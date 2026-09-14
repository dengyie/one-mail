from types import SimpleNamespace

import pytest

import one_mail_agg.graph_source as gs
from one_mail_agg.config import Config


class _Resp:
    def __init__(self, payload, status=200, content=b""):
        self._payload = payload
        self.status_code = status
        self.content = content
        self.text = str(payload)

    def raise_for_status(self):
        assert self.status_code == 200

    def json(self):
        return self._payload


class _State:
    def __init__(self, seen=None):
        self.seen = set(seen or [])
        self.added = []

    def get_pop3_seen(self, account_id, folder):
        return set(self.seen)

    def add_pop3_seen_many(self, account_id, folder, keys):
        self.added.extend(keys)
        self.seen.update(keys)


def _account(initial_sync_limit=50):
    return SimpleNamespace(id="g1", initial_sync_limit=initial_sync_limit)


def _items(start, end):
    return [{"id": f"new-{i}", "receivedDateTime": "2026-09-14T00:00:00Z"}
            for i in range(start, end + 1)]


def test_graph_backlog_over_50_paginates_to_seen_anchor_and_drains_oldest_first(monkeypatch):
    account = _account()
    anchor = gs.graph_uid_key(account, "INBOX", "old-seen")
    state = _State({anchor})

    def fake_get(url, headers=None, timeout=None):
        if "page=2" in url:
            return _Resp({"value": _items(51, 80) + [{"id": "old-seen"}]})
        return _Resp({
            "value": _items(1, 50),
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?page=2",
        })

    monkeypatch.setattr(gs.requests, "get", fake_get)
    first = gs._collect_pending_graph_items("AT", account, "INBOX", state, "inbox")
    # 80 unseen items: process the oldest 50 first (80..31 after chronological reverse).
    assert [row["id"] for row in first] == [f"new-{i}" for i in range(80, 30, -1)]

    state.seen.update(gs.graph_uid_key(account, "INBOX", row["id"]) for row in first)
    second = gs._collect_pending_graph_items("AT", account, "INBOX", state, "inbox")
    # Next run hits the new seen boundary on page 1 and drains the remaining 30.
    assert [row["id"] for row in second] == [f"new-{i}" for i in range(30, 0, -1)]


def test_graph_first_sync_preserves_initial_limit_without_scanning_history(monkeypatch):
    account = _account(initial_sync_limit=20)
    state = _State()
    calls = []

    def fake_get(url, headers=None, timeout=None):
        calls.append(url)
        return _Resp({
            "value": _items(1, 50),
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?page=2",
        })

    monkeypatch.setattr(gs.requests, "get", fake_get)
    pending = gs._collect_pending_graph_items("AT", account, "INBOX", state, "inbox")
    assert len(calls) == 1
    assert [row["id"] for row in pending] == [f"new-{i}" for i in range(20, 0, -1)]
    assert len(state.added) == 30


def test_graph_message_pagination_rejects_unexpected_nextlink_host(monkeypatch):
    account = _account()
    state = _State({gs.graph_uid_key(account, "INBOX", "old")})
    monkeypatch.setattr(gs.requests, "get", lambda *a, **k: _Resp({
        "value": _items(1, 50),
        "@odata.nextLink": "https://evil.example/messages?page=2",
    }))
    with pytest.raises(RuntimeError, match="unexpected host"):
        gs._collect_pending_graph_items("AT", account, "INBOX", state, "inbox")


def test_graph_mime_retryable_hole_stops_before_newer_messages(monkeypatch):
    account = _account()
    state = _State()
    pending = [
        {"id": "oldest", "receivedDateTime": "2026-09-14T00:00:01Z"},
        {"id": "retry-me", "receivedDateTime": "2026-09-14T00:00:02Z"},
        {"id": "newer", "receivedDateTime": "2026-09-14T00:00:03Z"},
    ]
    monkeypatch.setattr(gs, "_collect_pending_graph_items", lambda *a, **k: pending)
    monkeypatch.setattr(gs, "_resolve_immutable_metadata", lambda token, items: {
        row["id"]: {
            "id": f"immutable-{row['id']}",
            "conversationId": None,
            "parentFolderId": "inbox-id",
        }
        for row in items
    })
    mime_calls = []

    def fake_get(url, headers=None, timeout=None):
        message_id = url.split("/messages/", 1)[1].split("/", 1)[0]
        mime_calls.append(message_id)
        if message_id == "retry-me":
            return _Resp({}, status=503)
        return _Resp({}, content=b"From: a@b\r\nSubject: ok\r\n\r\nbody\r\n")

    monkeypatch.setattr(gs.requests, "get", fake_get)
    fetched, oversize = gs.fetch_graph_messages("AT", account, "INBOX", state)

    assert [meta.legacy_id for meta, _raw in fetched] == ["oldest"]
    assert mime_calls == ["oldest", "retry-me"]
    assert oversize == []


def test_graph_normalize_drop_is_marked_seen_to_keep_boundary_contiguous(monkeypatch):
    account = SimpleNamespace(
        id="g1",
        oauth={"provider": "graph"},
        folders=["INBOX"],
        user_managed=False,
    )
    state = _State()
    config = Config(worker_base_url="https://worker.example", admin_token="t", accounts=[])
    good = gs.GraphMessageMeta("immutable-good", "good", None, "good", None, "inbox-id")
    bad = gs.GraphMessageMeta("immutable-bad", "bad", None, "bad", None, "inbox-id")

    monkeypatch.setattr(gs, "graph_access_token", lambda *a, **k: "AT")
    monkeypatch.setattr(gs, "maybe_sync_graph_folder_catalog", lambda *a, **k: 0)
    monkeypatch.setattr(
        gs,
        "fetch_graph_messages",
        lambda *a, **k: ([(good, b"good"), (bad, b"bad")], []),
    )

    def fake_normalize(raw, *args, **kwargs):
        if raw == b"bad":
            raise ValueError("permanent parse failure")
        return {"imap_uid": kwargs["imap_uid_override"]}

    monkeypatch.setattr(gs, "normalize_message", fake_normalize)
    monkeypatch.setattr(gs, "upload_emails", lambda config, batch: {"inserted": len(batch)})

    result = gs.sync_graph(account, config, state)

    assert result == {"synced": 1, "dropped": 1, "protocol": "graph"}
    assert state.seen == {
        gs.graph_uid_key(account, "INBOX", "good"),
        gs.graph_uid_key(account, "INBOX", "bad"),
    }


def test_custom_graph_folder_name_resolves_to_provider_folder_id(monkeypatch):
    account = SimpleNamespace(id="g1")
    monkeypatch.setattr(gs, "discover_graph_folders", lambda token, acc: [
        {"display_name": "Projects", "provider_folder_id": "folder-123"},
        {"display_name": "Other", "provider_folder_id": "folder-456"},
    ])
    targets, rows = gs._resolve_graph_folder_targets("AT", account, ["INBOX", "Projects"])
    assert targets == [("INBOX", None), ("Projects", "folder-123")]
    assert rows is not None and len(rows) == 2


def test_ambiguous_custom_graph_folder_requires_explicit_id(monkeypatch):
    account = SimpleNamespace(id="g1")
    monkeypatch.setattr(gs, "discover_graph_folders", lambda token, acc: [
        {"display_name": "Projects", "provider_folder_id": "folder-a"},
        {"display_name": "Projects", "provider_folder_id": "folder-b"},
    ])
    with pytest.raises(ValueError, match="ambiguous"):
        gs._resolve_graph_folder_targets("AT", account, ["Projects"])


def test_explicit_graph_folder_id_needs_no_discovery(monkeypatch):
    account = SimpleNamespace(id="g1")
    monkeypatch.setattr(gs, "discover_graph_folders",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("no discovery")))
    targets, rows = gs._resolve_graph_folder_targets("AT", account, ["id:folder-xyz"])
    assert targets == [("id:folder-xyz", "folder-xyz")]
    assert rows is None
