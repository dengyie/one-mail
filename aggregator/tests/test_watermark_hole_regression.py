from one_mail_agg import sync as sync_mod
from one_mail_agg.config import AccountConfig, Config
from one_mail_agg.state import SyncState


class HoleClient:
    def __init__(self, recovered=False):
        self.recovered = recovered

    def select_folder(self, folder, readonly=True):
        return {b"UIDVALIDITY": 1}

    def search(self, criteria, charset=None):
        lo = int(criteria[1].split(":")[0])
        return [uid for uid in (1, 2, 3) if uid >= lo]

    def fetch(self, uids, data):
        if b"RFC822.SIZE" in data:
            out = {}
            for uid in uids:
                if uid == 2 and not self.recovered:
                    out[uid] = {}
                else:
                    out[uid] = {b"RFC822.SIZE": 100}
            return out
        if b"RFC822" in data:
            return {
                uid: {b"RFC822": f"raw-{uid}".encode(), b"INTERNALDATE": None}
                for uid in uids
            }
        return {}


def test_sync_imap_never_advances_watermark_past_unknown_size_hole(tmp_path, monkeypatch):
    state = SyncState(str(tmp_path / "state.json"))
    account = AccountConfig(
        id="a", source="imap_custom", host="imap.example.com", port=993,
        username="u@example.com", password="p", folders=["INBOX"],
        initial_sync_limit=0,
    )
    config = Config(worker_base_url="https://worker", admin_token="t", accounts=[])

    monkeypatch.setattr(sync_mod, "maybe_sync_imap_folder_catalog", lambda *a, **k: 0)
    monkeypatch.setattr(
        sync_mod,
        "normalize_message",
        lambda raw, *a, **k: {"raw": raw.decode("ascii")},
    )
    uploaded = []
    monkeypatch.setattr(
        sync_mod,
        "upload_emails",
        lambda _config, batch: uploaded.extend(batch) or {"inserted": len(batch)},
    )

    first = sync_mod.sync_imap(HoleClient(recovered=False), config, account, state)
    assert first["synced"] == 1
    assert [row["raw"] for row in uploaded] == ["raw-1"]
    assert state.get_last_uid("a", "INBOX") == 1

    uploaded.clear()
    second = sync_mod.sync_imap(HoleClient(recovered=True), config, account, state)
    assert second["synced"] == 2
    assert [row["raw"] for row in uploaded] == ["raw-2", "raw-3"]
    assert state.get_last_uid("a", "INBOX") == 3
