import json
import os
import threading
import time

# 连续失败 N 轮后进入退避；退避时长（秒）
FAILBACK_MAX_FAILS = 3
FAILBACK_BACKOFF_SEC = 900      # 15 分钟起步
# POP3/Graph seen 单账号上限：POP3 没有 IMAP 的水印删档，Graph 也沿用历史 seen
# namespace 兼容旧 state。磁盘里保持“首次 seen 的写入顺序”，超出时从头裁剪最旧。
POP3_SEEN_MAX = 2000

# daemon 会把同一个 SyncState 共享给多个 IDLE worker。所有状态访问都必须按
# state path 串行化，否则多个线程会并发修改 _data / 覆盖同一个临时文件。
# path 级共享锁也让同一进程中偶然创建的第二个 SyncState 实例复用同一写锁。
_STATE_LOCKS: dict[str, threading.RLock] = {}
_STATE_LOCKS_GUARD = threading.Lock()


def _lock_for_path(path: str) -> threading.RLock:
    key = os.path.abspath(path)
    with _STATE_LOCKS_GUARD:
        lock = _STATE_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _STATE_LOCKS[key] = lock
        return lock


def next_backoff_offset(fail_count: int, backoff_sec: int = FAILBACK_BACKOFF_SEC,
                        max_fail: int = FAILBACK_MAX_FAILS) -> int:
    """纯函数：给定当前累计失败数，达到退避阈值则返回退避秒数，否则 0。"""
    if fail_count >= max_fail:
        return backoff_sec
    return 0


class SyncState:
    def __init__(self, path: str):
        self.path = path
        self._lock = _lock_for_path(path)
        self._data = {"last_uid": {}, "uidvalidity": {}, "pop3_seen": {}, "fallback": {},
                      "per_account": {}}
        with self._lock:
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
        with self._lock:
            return int(self._data["last_uid"].get(self._key(account_id, folder), 0))

    def set_last_uid(self, account_id: str, folder: str, uid: int) -> None:
        with self._lock:
            self._data["last_uid"][self._key(account_id, folder)] = int(uid)
            self._save_locked()

    def set_last_uid_max(self, account_id: str, folder: str, uid: int) -> None:
        """水印单调推进：只接受更大的值，绝不回落。

        fetch 层把超限单封推进过水印后，sync 层不能拿「已挑出邮件」的较小 max
        把水位拉回来，否则下轮会重拉含超限封的整个窗口。比较与写入必须在同一
        锁内，否则两个 IDLE 线程/调用方交错时会破坏 compare-and-set 语义。
        """
        with self._lock:
            key = self._key(account_id, folder)
            current = int(self._data["last_uid"].get(key, 0))
            if uid > current:
                self._data["last_uid"][key] = int(uid)
                self._save_locked()

    def get_uidvalidity(self, account_id: str, folder: str) -> int | None:
        with self._lock:
            v = self._data["uidvalidity"].get(self._key(account_id, folder))
            return int(v) if v is not None else None

    def set_uidvalidity(self, account_id: str, folder: str, v: int) -> None:
        with self._lock:
            self._data["uidvalidity"][self._key(account_id, folder)] = int(v)
            self._save_locked()

    # --- POP3 / Graph seen 命名空间 ---
    # 历史字段名保留为 pop3_seen，避免升级时 Graph/POP3 现有水印全部失效。
    # 对外读取仍返回 set 以保持调用方 API；磁盘内部必须保存有序 list，才能做真实 FIFO。

    def get_pop3_seen(self, account_id: str, folder: str) -> set[str]:
        with self._lock:
            return set(self._data["pop3_seen"].get(self._key(account_id, folder), []))

    def _ordered_pop3_seen_locked(self, key: str) -> list[str]:
        """调用方已持锁：读取并去重 seen list，保留首次出现顺序。"""
        raw = self._data["pop3_seen"].get(key, [])
        if not isinstance(raw, list):
            raw = []
        ordered: list[str] = []
        membership: set[str] = set()
        for value in raw:
            uid = str(value)
            if uid in membership:
                continue
            membership.add(uid)
            ordered.append(uid)
        return ordered

    def _append_pop3_seen_locked(self, key: str, uidls: list[str]) -> None:
        """调用方已持锁：按首次写入顺序追加 seen key，并裁剪真正最旧条目。"""
        ordered = self._ordered_pop3_seen_locked(key)
        membership = set(ordered)
        for value in uidls:
            uid = str(value)
            if uid in membership:
                continue
            membership.add(uid)
            ordered.append(uid)
        if len(ordered) > POP3_SEEN_MAX:
            ordered = ordered[-POP3_SEEN_MAX:]
        self._data["pop3_seen"][key] = ordered

    def add_pop3_seen(self, account_id: str, folder: str, uidl: str) -> None:
        with self._lock:
            key = self._key(account_id, folder)
            self._append_pop3_seen_locked(key, [uidl])
            self._save_locked()

    def add_pop3_seen_many(self, account_id: str, folder: str, uidls: list[str]) -> None:
        """批量标记已见（一次 save，避免每封一整盘 JSON）。"""
        if not uidls:
            return
        with self._lock:
            key = self._key(account_id, folder)
            self._append_pop3_seen_locked(key, uidls)
            self._save_locked()

    # --- 降级固定（fallback pin）---

    def is_fallback_pinned(self, account_id: str) -> bool:
        with self._lock:
            return bool(self._data["fallback"].get(account_id, False))

    def set_fallback_pinned(self, account_id: str, pinned: bool) -> None:
        with self._lock:
            self._data["fallback"][account_id] = bool(pinned)
            self._save_locked()

    # --- 账号级失败管理（连续失败退避） ---

    def get_fail_state(self, account_id: str) -> tuple[int, float]:
        """返回 `(fail_count, skip_until_ts)`；缺失视为 `(0, 0)`。"""
        with self._lock:
            pa = self._data["per_account"].get(account_id) or {}
            return int(pa.get("fail_count", 0) or 0), float(pa.get("skip_until", 0) or 0)

    def record_failure(self, account_id: str, max_fail: int = FAILBACK_MAX_FAILS,
                       backoff_sec: int = FAILBACK_BACKOFF_SEC,
                       now: float | None = None) -> float:
        """原子地记一次失败，并在达到阈值后开启退避。"""
        now = float(now) if now is not None else time.time()
        with self._lock:
            pa = dict(self._data["per_account"].get(account_id) or {})
            n = int(pa.get("fail_count", 0) or 0) + 1
            skip_until = pa.get("skip_until", 0) or 0
            if next_backoff_offset(n, backoff_sec, max_fail):
                skip_until = now + backoff_sec
            pa["fail_count"] = n
            pa["skip_until"] = skip_until
            self._data["per_account"][account_id] = pa
            self._save_locked()
            return float(skip_until)

    def record_success(self, account_id: str) -> None:
        """同步成功（含上传任意一条）：清零失败计数，解除退避。"""
        with self._lock:
            if account_id not in self._data["per_account"]:
                return
            pa = dict(self._data["per_account"].get(account_id) or {})
            if not pa.get("fail_count") and not pa.get("skip_until"):
                return
            pa.pop("fail_count", None)
            pa.pop("skip_until", None)
            if not pa:
                self._data["per_account"].pop(account_id, None)
            else:
                self._data["per_account"][account_id] = pa
            self._save_locked()

    def should_skip_account(self, account_id: str, now: float | None = None) -> bool:
        """当前是否处于退避窗口（返回 True 则本轮跳过该账号）。"""
        now = float(now) if now is not None else time.time()
        with self._lock:
            pa = self._data["per_account"].get(account_id) or {}
            skip_until = float(pa.get("skip_until", 0) or 0)
            return skip_until > now

    def _save_locked(self) -> None:
        """调用方已持锁：原子持久化当前内存快照。"""
        # 每线程独立临时文件，防止未来出现第二进程/异常重入时共享 `.tmp`
        # 名称互相 truncate；同进程内正常路径仍由 path RLock 串行化。
        tmp = f"{self.path}.{os.getpid()}.{threading.get_ident()}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._data, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except Exception:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            raise

    def save(self) -> None:
        with self._lock:
            self._save_locked()
