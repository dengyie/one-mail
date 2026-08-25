import json
import os
import time

# 连续失败 N 轮后进入退避；退避时长（秒）
FAILBACK_MAX_FAILS = 3
FAILBACK_BACKOFF_SEC = 900      # 15 分钟起步
# POP3 seen 集合单账号(FIFO)上限：POP3 没有 IMAP 的水印删档，已见 UIDL 无限
# 增长会让 state 文件越滚越大；超出时裁剪最旧（set 保序 → 掐头）。
POP3_SEEN_MAX = 2000


def next_backoff_offset(fail_count: int, backoff_sec: int = FAILBACK_BACKOFF_SEC,
                        max_fail: int = FAILBACK_MAX_FAILS) -> int:
    """纯函数：给定当前累计失败数，达到退避阈值则返回退避秒数，否则 0。"""
    if fail_count >= max_fail:
        return backoff_sec
    return 0


class SyncState:
    def __init__(self, path: str):
        self.path = path
        self._data = {"last_uid": {}, "uidvalidity": {}, "pop3_seen": {}, "fallback": {},
                      "per_account": {}}
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                try:
                    self._data = json.load(f)
                except (json.JSONDecodeError, OSError):
                    # 半截 JSON（旧版非原子写被写坏）：降级为全新状态、
                    # 构造不抛错——否则一个坏文件就让所有账号的同步状态清零。
                    self._data = {}
        # 旧/手工编辑的 state 可能缺键，补默认，避免 KeyError
        self._data.setdefault("last_uid", {})
        self._data.setdefault("uidvalidity", {})
        self._data.setdefault("pop3_seen", {})
        self._data.setdefault("fallback", {})
        self._data.setdefault("per_account", {})

    def _key(self, account_id: str, folder: str) -> str:
        return f"{account_id}|{folder}"

    def get_last_uid(self, account_id: str, folder: str) -> int:
        return int(self._data["last_uid"].get(self._key(account_id, folder), 0))

    def set_last_uid(self, account_id: str, folder: str, uid: int) -> None:
        self._data["last_uid"][self._key(account_id, folder)] = int(uid)
        self.save()

    def set_last_uid_max(self, account_id: str, folder: str, uid: int) -> None:
        """水印单调推进：只接受更大的值，绝不回落。

        fetch 层把超限单封推进过水印后，sync 层不能拿「已挑出邮件」的较小 max
        把水位拉回来，否则下轮会重拉含超限封的整个窗口。见 sync_imap 的
        `max(oversize 推过的水位, 窗口 max uid)`。无副作用：如果 uid 不大于
        当前水位则不动，避免无谓的磁盘写。
        """
        if uid > self.get_last_uid(account_id, folder):
            self.set_last_uid(account_id, folder, uid)

    def get_uidvalidity(self, account_id: str, folder: str) -> int | None:
        v = self._data["uidvalidity"].get(self._key(account_id, folder))
        return int(v) if v is not None else None

    def set_uidvalidity(self, account_id: str, folder: str, v: int) -> None:
        self._data["uidvalidity"][self._key(account_id, folder)] = int(v)
        self.save()

    # --- POP3 专用命名空间 ---
    # POP3 没有 IMAP 的 UIDVALIDITY/UID，只有服务端维持的 UIDL 字符串。
    # 存"已见过"的 UIDL 集合来推进水印；未成功上传的 UIDL 不标记、留到下一轮重试。
    # 与 last_uid/uidvalidity（IMAP 命名空间）完全隔离，避免两类 int 互相污染。

    def get_pop3_seen(self, account_id: str, folder: str) -> set[str]:
        return set(self._data["pop3_seen"].get(self._key(account_id, folder), []))

    def _trim_pop3_seen(self, seen: set[str]) -> list[str]:
        """FIFO 裁剪：保留最近 POP3_SEEN_MAX 条；老数据兼容（超限旧集合首次 add 时裁剪）。"""
        ordered = sorted(seen)
        if len(ordered) > POP3_SEEN_MAX:
            ordered = ordered[-POP3_SEEN_MAX:]
        return ordered

    def add_pop3_seen(self, account_id: str, folder: str, uidl: str) -> None:
        key = self._key(account_id, folder)
        seen = set(self._data["pop3_seen"].get(key, []))
        seen.add(uidl)
        self._data["pop3_seen"][key] = self._trim_pop3_seen(seen)
        self.save()

    def add_pop3_seen_many(self, account_id: str, folder: str, uidls: list[str]) -> None:
        """批量标记已见（一次 save，避免每封一整盘 JSON）。"""
        if not uidls:
            return
        key = self._key(account_id, folder)
        seen = set(self._data["pop3_seen"].get(key, []))
        seen.update(uidls)
        self._data["pop3_seen"][key] = self._trim_pop3_seen(seen)
        self.save()

    # --- 降级固定（fallback pin）---
    # auto 账号一旦因 IMAP 失败降级到 POP3，就永久钉住到 POP3（除非手工清除），
    # 避免 IMAP 抖动时在同一账号内产生 imap:/pop3: 两套 imap_uid 键的重复行。

    def is_fallback_pinned(self, account_id: str) -> bool:
        return bool(self._data["fallback"].get(account_id, False))

    def set_fallback_pinned(self, account_id: str, pinned: bool) -> None:
        self._data["fallback"][account_id] = bool(pinned)
        self.save()

    # --- 账号级失败管理（连续失败退避）---
    # 每账号维护连续失败计数与「跳过到刻」。连续 FAILBACK_MAX=3 轮失败后进入
    # 退避（skip_until_ts），期间不再尝试该账号，避免无意义重连轰炸目标服务器
    # 触发封 IP；成功（或上传任意一条）即清零。老 state 文件缺字段视为 0/None
    # （向后兼容：不 break）。

    def get_fail_state(self, account_id: str) -> tuple[int, float]:
        """返回 `(fail_count, skip_until_ts)`；缺失视为 `(0, 0)`。"""
        pa = self._data["per_account"].get(account_id) or {}
        return int(pa.get("fail_count", 0) or 0), float(pa.get("skip_until", 0) or 0)

    def record_failure(self, account_id: str, max_fail: int = FAILBACK_MAX_FAILS,
                       backoff_sec: int = FAILBACK_BACKOFF_SEC,
                       now: float | None = None) -> float:
        """记一次失败：fail_count+1；达到退避阈值时设 skip_until_ts = now+退避。

        返回本轮 skip_until_ts（未达到退避时为原值）。`now` 可注入便于测试。
        """
        now = float(now) if now is not None else time.time()
        pa = dict(self._data["per_account"].get(account_id) or {})
        n = int(pa.get("fail_count", 0) or 0) + 1
        skip_until = pa.get("skip_until", 0) or 0
        if next_backoff_offset(n, backoff_sec, max_fail):
            # 达到退避阈值：skip_until_ts 从失败时刻起延后 backoff_sec
            skip_until = now + backoff_sec
        pa["fail_count"] = n
        pa["skip_until"] = skip_until
        self._data["per_account"][account_id] = pa
        self.save()
        return float(skip_until)

    def record_success(self, account_id: str) -> None:
        """同步成功（含上传任意一条）：清零失败计数，解除退避。"""
        if account_id not in self._data["per_account"]:
            return
        pa = self._data["per_account"].get(account_id) or {}
        if not pa.get("fail_count") and not pa.get("skip_until"):
            return
        pa.pop("fail_count", None)
        pa.pop("skip_until", None)
        if not pa:
            self._data["per_account"].pop(account_id, None)
        else:
            self._data["per_account"][account_id] = pa
        self.save()

    def should_skip_account(self, account_id: str, now: float | None = None) -> bool:
        """当前是否处于退避窗口（返回 True 则本轮跳过该账号）。"""
        _fail, skip_until = self.get_fail_state(account_id)
        now = float(now) if now is not None else time.time()
        return skip_until > now

    def save(self) -> None:
        # 原子写：先写临时文件再 os.replace 替换，避免进程被 kill（240s 超时/OOM/重启）
        # 时留下半截 JSON 导致下轮 json.load 抛错、全部账号同步状态丢失。
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._data, f)
        except Exception:
            # 写临时文件失败（磁盘满/权限/序列化错等）：清理残留 .tmp，不留垃圾。
            if os.path.exists(tmp):
                os.remove(tmp)
            raise
        os.replace(tmp, self.path)