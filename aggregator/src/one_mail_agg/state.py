import json
import os


class SyncState:
    def __init__(self, path: str):
        self.path = path
        self._data = {"last_uid": {}, "uidvalidity": {}, "pop3_seen": {}, "fallback": {}}
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                self._data = json.load(f)
        # 旧/手工编辑的 state 可能缺键，补默认，避免 KeyError
        self._data.setdefault("last_uid", {})
        self._data.setdefault("uidvalidity", {})
        self._data.setdefault("pop3_seen", {})
        self._data.setdefault("fallback", {})

    def _key(self, account_id: str, folder: str) -> str:
        return f"{account_id}|{folder}"

    def get_last_uid(self, account_id: str, folder: str) -> int:
        return int(self._data["last_uid"].get(self._key(account_id, folder), 0))

    def set_last_uid(self, account_id: str, folder: str, uid: int) -> None:
        self._data["last_uid"][self._key(account_id, folder)] = int(uid)
        self.save()

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

    def add_pop3_seen(self, account_id: str, folder: str, uidl: str) -> None:
        key = self._key(account_id, folder)
        seen = set(self._data["pop3_seen"].get(key, []))
        seen.add(uidl)
        self._data["pop3_seen"][key] = sorted(seen)
        self.save()

    def add_pop3_seen_many(self, account_id: str, folder: str, uidls: list[str]) -> None:
        """批量标记已见（一次 save，避免每封一整盘 JSON）。"""
        if not uidls:
            return
        key = self._key(account_id, folder)
        seen = set(self._data["pop3_seen"].get(key, []))
        seen.update(uidls)
        self._data["pop3_seen"][key] = sorted(seen)
        self.save()

    # --- 降级固定（fallback pin）---
    # auto 账号一旦因 IMAP 失败降级到 POP3，就永久钉住到 POP3（除非手工清除），
    # 避免 IMAP 抖动时在同一账号内产生 imap:/pop3: 两套 imap_uid 键的重复行。

    def is_fallback_pinned(self, account_id: str) -> bool:
        return bool(self._data["fallback"].get(account_id, False))

    def set_fallback_pinned(self, account_id: str, pinned: bool) -> None:
        self._data["fallback"][account_id] = bool(pinned)
        self.save()

    def save(self) -> None:
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._data, f)