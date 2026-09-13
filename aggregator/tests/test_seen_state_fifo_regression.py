import json

import one_mail_agg.state as state_mod
from one_mail_agg.state import SyncState


def _stored_seen(path, account="acc", folder="INBOX"):
    payload = json.loads(path.read_text())
    return payload["pop3_seen"][f"{account}|{folder}"]


def test_seen_cap_uses_insertion_order_not_lexicographic_order(tmp_path, monkeypatch):
    """随机 UIDL/Graph ID 不能按字符串大小决定谁最旧。"""
    monkeypatch.setattr(state_mod, "POP3_SEEN_MAX", 3)
    path = tmp_path / "state.json"
    state = SyncState(str(path))

    state.add_pop3_seen_many("acc", "INBOX", ["z-old", "a-middle", "m-new"])
    state.add_pop3_seen("acc", "INBOX", "0-newest")

    assert _stored_seen(path) == ["a-middle", "m-new", "0-newest"]
    assert state.get_pop3_seen("acc", "INBOX") == {"a-middle", "m-new", "0-newest"}


def test_duplicate_seen_key_does_not_refresh_its_fifo_age(tmp_path, monkeypatch):
    monkeypatch.setattr(state_mod, "POP3_SEEN_MAX", 3)
    path = tmp_path / "state.json"
    state = SyncState(str(path))

    state.add_pop3_seen_many("acc", "INBOX", ["first", "second", "third"])
    state.add_pop3_seen("acc", "INBOX", "first")
    state.add_pop3_seen("acc", "INBOX", "fourth")

    assert _stored_seen(path) == ["second", "third", "fourth"]


def test_seen_fifo_order_survives_process_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(state_mod, "POP3_SEEN_MAX", 3)
    path = tmp_path / "state.json"

    first_process = SyncState(str(path))
    first_process.add_pop3_seen_many(
        "acc",
        "INBOX",
        ["graph:acc:INBOX:z-old", "graph:acc:INBOX:a-mid", "graph:acc:INBOX:m-new"],
    )

    second_process = SyncState(str(path))
    second_process.add_pop3_seen("acc", "INBOX", "graph:acc:INBOX:0-newest")

    assert _stored_seen(path) == [
        "graph:acc:INBOX:a-mid",
        "graph:acc:INBOX:m-new",
        "graph:acc:INBOX:0-newest",
    ]


def test_legacy_seen_list_keeps_existing_order_and_deduplicates(tmp_path, monkeypatch):
    monkeypatch.setattr(state_mod, "POP3_SEEN_MAX", 3)
    path = tmp_path / "state.json"
    path.write_text(json.dumps({
        "last_uid": {},
        "uidvalidity": {},
        "pop3_seen": {"acc|INBOX": ["old", "middle", "old", "recent"]},
        "fallback": {},
        "per_account": {},
    }))

    state = SyncState(str(path))
    state.add_pop3_seen("acc", "INBOX", "newest")

    assert _stored_seen(path) == ["middle", "recent", "newest"]
