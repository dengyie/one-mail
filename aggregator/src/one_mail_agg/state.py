import json
import os


class SyncState:
    def __init__(self, path: str):
        self.path = path
        self._data = {"last_uid": {}, "uidvalidity": {}}
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                self._data = json.load(f)

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

    def save(self) -> None:
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._data, f)