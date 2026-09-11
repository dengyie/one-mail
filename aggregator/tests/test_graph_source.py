"""Graph API 同步源测试：token 轮换与 ImmutableId 都是持久化契约。"""
import json
from types import SimpleNamespace

import pytest

from one_mail_agg.graph_source import (
    GRAPH_IMMUTABLE_PREFER,
    GraphMessageMeta,
    _resolve_immutable_metadata,
    graph_access_token,
    graph_source_key,
    graph_uid_key,
    sync_graph,
)
from one_mail_agg.config import Config
from one_mail_agg import token_store


class _FakeResp:
    def __init__(self, payload, status=200, content=b""):
        self._payload = payload
        self.status_code = status
        self.content = content
        self.text = json.dumps(payload)

    def raise_for_status(self):
        assert self.status_code == 200

    def json(self):
        return self._payload


def test_graph_uid_key_keeps_legacy_account_and_folder_dimensions():
    acc = SimpleNamespace(id="acc1")
    key = graph_uid_key(acc, "INBOX", "msg-1")
    assert key == "graph:acc1:INBOX:msg-1"


def test_graph_source_key_uses_account_and_immutable_id_only():
    acc = SimpleNamespace(id="acc1")
    assert graph_source_key(acc, "immutable-1") == "graph:acc1:immutable-1"


def test_resolve_immutable_metadata_batches_and_sets_prefer(monkeypatch):
    import one_mail_agg.graph_source as gs

    payloads = []

    def fake_post(url, headers=None, json=None, timeout=None, **kwargs):
        assert url.endswith("/$batch")
        payloads.append(json)
        responses = []
        for req in json["requests"]:
            assert req["headers"]["Prefer"] == GRAPH_IMMUTABLE_PREFER
            responses.append({
                "id": req["id"],
                "status": 200,
                "body": {
                    "id": f"immutable-{req['id']}",
                    "conversationId": f"conv-{req['id']}",
                    "parentFolderId": "folder-1",
                },
            })
        return _FakeResp({"responses": responses})

    monkeypatch.setattr(gs.requests, "post", fake_post)
    items = [{"id": f"legacy-{i}"} for i in range(21)]
    resolved = _resolve_immutable_metadata("AT", items)

    assert len(payloads) == 2  # Graph JSON batch limit is 20
    assert resolved["legacy-0"]["id"] == "immutable-0"
    assert resolved["legacy-20"]["id"] == "immutable-20"


def test_resolve_immutable_metadata_fails_closed_on_subrequest_error(monkeypatch):
    import one_mail_agg.graph_source as gs

    monkeypatch.setattr(gs.requests, "post", lambda *a, **k: _FakeResp({
        "responses": [{"id": "0", "status": 404, "body": {}}],
    }))
    with pytest.raises(RuntimeError, match="ImmutableId resolution failed"):
        _resolve_immutable_metadata("AT", [{"id": "legacy-1"}])


def test_rotated_token_via_on_rotated_callback():
    captured = {}

    import one_mail_agg.graph_source as gs
    original = gs.requests.post
    gs.requests.post = lambda url, data=None, timeout=None: _FakeResp(
        {"access_token": "AT", "refresh_token": "NEW"})
    try:
        oauth = {"client_id": "cid", "refresh_token": "OLD"}
        token = graph_access_token(oauth, lambda rt: captured.setdefault("rt", rt))
    finally:
        gs.requests.post = original

    assert token == "AT"
    assert oauth["refresh_token"] == "NEW"
    assert captured["rt"] == "NEW"


def test_sync_graph_static_account_persists_to_config(tmp_path, monkeypatch):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({
        "worker_base_url": "https://w", "admin_token": "t",
        "accounts": [{"id": "g1", "source": "graph_outlook", "host": "graph.microsoft.com",
                      "port": 443, "username": "u@hotmail.com", "password": "",
                      "folders": ["INBOX"], "use_ssl": True,
                      "oauth": {"provider": "graph", "client_id": "cid", "refresh_token": "OLD"}}],
    }), encoding="utf-8")
    config = Config(worker_base_url="https://w", admin_token="t", accounts=[],
                    config_path=str(cfg_file))

    import one_mail_agg.graph_source as gs
    monkeypatch.setattr(gs.requests, "post", lambda url, data=None, timeout=None: _FakeResp({
        "access_token": "AT", "refresh_token": "NEW"}))
    monkeypatch.setattr(gs, "fetch_graph_messages",
                        lambda token, account, folder, state: ([], []))

    acc = SimpleNamespace(id="g1", oauth={"provider": "graph", "client_id": "cid",
                                          "refresh_token": "OLD"},
                          folders=["INBOX"], initial_sync_limit=50, user_managed=False)
    state = SimpleNamespace()
    sync_graph(acc, config, state)

    saved = json.loads(cfg_file.read_text(encoding="utf-8"))
    assert saved["accounts"][0]["oauth"]["refresh_token"] == "NEW"


def test_sync_graph_user_account_reports_to_worker(tmp_path, monkeypatch):
    reported = {}
    monkeypatch.setattr(token_store, "report_refresh_token_to_worker",
                        lambda base, tok, aid, rt: reported.update(
                            {"base": base, "aid": aid, "rt": rt}) or True)

    config = Config(worker_base_url="https://w", admin_token="t", accounts=[],
                    config_path=None)
    import one_mail_agg.graph_source as gs
    monkeypatch.setattr(gs.requests, "post", lambda url, data=None, timeout=None: _FakeResp({
        "access_token": "AT", "refresh_token": "NEW"}))
    monkeypatch.setattr(gs, "fetch_graph_messages",
                        lambda token, account, folder, state: ([], []))

    acc = SimpleNamespace(id="uuid-1", oauth={"provider": "graph", "client_id": "cid",
                                              "refresh_token": "OLD"},
                          folders=["INBOX"], initial_sync_limit=50, user_managed=True)
    sync_graph(acc, config, SimpleNamespace())

    assert reported == {"base": "https://w", "aid": "uuid-1", "rt": "NEW"}


def test_sync_graph_uploads_immutable_identity_and_keeps_legacy_seen_key(monkeypatch):
    import one_mail_agg.graph_source as gs

    raw = (b"From: sender@example.com\r\nTo: u@hotmail.com\r\n"
           b"Message-ID: <rfc-1@example.com>\r\nSubject: moved\r\n\r\nbody\r\n")
    meta = GraphMessageMeta(
        id="immutable-1",
        legacy_id="legacy-folder-id-1",
        received_at_ms=1700000000000,
        subject="moved",
        conversation_id="conv-1",
        parent_folder_id="folder-2",
    )
    captured = {}
    seen = []

    monkeypatch.setattr(gs, "graph_access_token", lambda oauth, cb=None: "AT")
    monkeypatch.setattr(gs, "fetch_graph_messages",
                        lambda token, account, folder, state: ([(meta, raw)], []))

    def fake_upload(config, batch):
        captured["email"] = batch[0]
        return {"inserted": 1, "skipped": 0}

    monkeypatch.setattr(gs, "upload_emails", fake_upload)

    state = SimpleNamespace(
        add_pop3_seen_many=lambda account_id, folder, keys: seen.extend(keys),
    )
    account = SimpleNamespace(
        id="g1",
        source="graph_outlook",
        host="graph.microsoft.com",
        username="u@hotmail.com",
        oauth={"provider": "graph"},
        folders=["INBOX"],
        user_managed=False,
    )
    config = Config(worker_base_url="https://w", admin_token="t", accounts=[], config_path=None)

    result = sync_graph(account, config, state)
    email = captured["email"]
    assert result["synced"] == 1
    assert email["provider"] == "graph"
    assert email["provider_message_id"] == "immutable-1"
    assert email["provider_thread_id"] == "conv-1"
    assert email["source_folder_id"] == "folder-2"
    assert email["source_key"] == "graph:g1:immutable-1"
    assert email["imap_uid"] == "graph:g1:INBOX:legacy-folder-id-1"
    assert seen == ["graph:g1:INBOX:legacy-folder-id-1"]


def test_same_refresh_token_no_callback():
    import one_mail_agg.graph_source as gs
    original = gs.requests.post
    gs.requests.post = lambda url, data=None, timeout=None: _FakeResp({"access_token": "AT"})
    try:
        oauth = {"client_id": "cid", "refresh_token": "SAME"}
        called = []
        graph_access_token(oauth, lambda rt: called.append(rt))
        assert called == []
    finally:
        gs.requests.post = original
