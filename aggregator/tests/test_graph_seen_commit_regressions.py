from types import SimpleNamespace

import pytest

import one_mail_agg.graph_source as gs
from one_mail_agg.config import Config


class _State:
    def __init__(self):
        self.seen = set()

    def add_pop3_seen_many(self, account_id, folder, keys):
        self.seen.update(keys)


def _account():
    return SimpleNamespace(
        id="g1",
        oauth={"provider": "graph"},
        folders=["INBOX"],
        user_managed=False,
    )


def _config():
    return Config(worker_base_url="https://worker.example", admin_token="t", accounts=[])


def _meta(message_id="normal"):
    return gs.GraphMessageMeta(
        id=f"immutable-{message_id}",
        legacy_id=message_id,
        received_at_ms=None,
        subject=message_id,
        conversation_id=None,
        parent_folder_id="inbox-id",
    )


def _wire_common(monkeypatch, fetched, oversize):
    monkeypatch.setattr(gs, "graph_access_token", lambda *a, **k: "AT")
    monkeypatch.setattr(gs, "maybe_sync_graph_folder_catalog", lambda *a, **k: 0)
    monkeypatch.setattr(gs, "fetch_graph_messages", lambda *a, **k: (fetched, oversize))
    monkeypatch.setattr(
        gs,
        "normalize_message",
        lambda raw, *a, **k: {"imap_uid": k["imap_uid_override"]},
    )


def test_graph_upload_failure_does_not_commit_interleaved_oversize_seen(monkeypatch):
    """A newer intentional drop must not become a seen anchor across an older uncommitted upload."""
    account = _account()
    state = _State()
    normal_key = gs.graph_uid_key(account, "INBOX", "normal")
    oversize_key = gs.graph_uid_key(account, "INBOX", "oversize-newer")
    _wire_common(monkeypatch, [(_meta(), b"raw")], [oversize_key])

    def fail_upload(*args, **kwargs):
        raise RuntimeError("worker ingest 500")

    monkeypatch.setattr(gs, "upload_emails", fail_upload)

    with pytest.raises(RuntimeError, match="worker ingest 500"):
        gs.sync_graph(account, _config(), state)

    # Neither the successful-normalized message nor the interleaved oversize drop
    # may advance the Graph seen boundary when the Worker transaction failed.
    assert normal_key not in state.seen
    assert oversize_key not in state.seen
    assert state.seen == set()


def test_graph_success_commits_normal_and_oversize_prefix_together(monkeypatch):
    account = _account()
    state = _State()
    normal_key = gs.graph_uid_key(account, "INBOX", "normal")
    oversize_key = gs.graph_uid_key(account, "INBOX", "oversize-newer")
    _wire_common(monkeypatch, [(_meta(), b"raw")], [oversize_key])
    monkeypatch.setattr(gs, "upload_emails", lambda config, batch: {"inserted": len(batch)})

    result = gs.sync_graph(account, _config(), state)

    assert result == {"synced": 1, "dropped": 1, "protocol": "graph"}
    assert state.seen == {normal_key, oversize_key}


def test_graph_all_oversize_prefix_can_commit_without_upload(monkeypatch):
    account = _account()
    state = _State()
    oversize_key = gs.graph_uid_key(account, "INBOX", "oversize-only")
    _wire_common(monkeypatch, [], [oversize_key])
    monkeypatch.setattr(
        gs,
        "upload_emails",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("no upload for all-drop prefix")),
    )

    result = gs.sync_graph(account, _config(), state)

    assert result == {"synced": 0, "dropped": 1, "protocol": "graph"}
    assert state.seen == {oversize_key}
