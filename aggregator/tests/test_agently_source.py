"""Agently (agent.qq.com) sync source tests: token rotation and seen-anchor invariants."""
import base64
import json
from types import SimpleNamespace

import pytest

from one_mail_agg.agently_source import (
    _build_mime_from_api,
    _collect_pending_message_ids,
    _envelope,
    _resolve_alias_id,
    agently_access_token,
    agently_source_key,
    agently_uid_key,
    send_agently,
    sync_agently,
)
from one_mail_agg.config import AccountConfig
from one_mail_agg.smtp_sender import OutboundSendError, OutboundUnsupported


class _FakeResp:
    def __init__(self, payload, status=200, headers=None):
        self._payload = payload
        self.status_code = status
        self.headers = headers or {}
        self.text = json.dumps(payload)

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests as _requests
            raise _requests.HTTPError(f"HTTP {self.status_code}", response=self)

    def json(self):
        return self._payload


def _account(**overrides) -> AccountConfig:
    base = dict(
        id="ag-1", source="agently", host="api.agent.qq.com", port=443,
        username="user@agent.qq.com", password="ignored",
        oauth={"provider": "agently", "refresh_token": "RT-OLD"},
    )
    base.update(overrides)
    return AccountConfig(**base)


def _list_page(rows, has_more=False, next_cursor=""):
    # _api_get contract: returns the unwrapped envelope "data" object
    return {"data": rows, "pagination": {"has_more": has_more, "next_cursor": next_cursor}}


def _row(mid, subject="s", created="2026-11-24T00:00:00Z"):
    return {"message_id": mid, "subject": subject, "created_at": created,
            "dir": {"dir_id": 1, "dir_name": "inbox"}}


def _detail(mid, **overrides):
    d = {
        "message_id": mid,
        "subject": "Hello",
        "created_at": "2026-11-24T00:00:00Z",
        "body_format": "PLAIN",
        "body": "hi there",
        "from": {"email": "a@example.com", "name": "A"},
        "to": [{"email": "user@agent.qq.com", "name": "u"}],
        "rfc_message_id": "<r@example.com>",
        "dir": {"dir_id": 1, "dir_name": "inbox"},
        "attachments": [],
    }
    d.update(overrides)
    return d


@pytest.fixture
def state(tmp_path):
    from one_mail_agg.state import SyncState
    return SyncState(str(tmp_path / "state.json"))


# --- keys -------------------------------------------------------------------

def test_uid_key_keeps_account_and_folder_dimensions():
    acc = SimpleNamespace(id="ag-1")
    assert agently_uid_key(acc, "INBOX", "msg-1") == "agently:ag-1:INBOX:msg-1"


def test_source_key_is_folder_independent():
    acc = SimpleNamespace(id="ag-1")
    assert agently_source_key(acc, "msg-1") == "agently:ag-1:msg-1"


# --- envelope / token -------------------------------------------------------

def test_envelope_raises_on_ok_false():
    resp = _FakeResp({"ok": False, "error": {"code": 400, "message": "bad"}}, status=400)
    with pytest.raises(RuntimeError, match="agently API error"):
        _envelope(resp)


def test_envelope_401_is_auth_error():
    from one_mail_agg.agently_source import AgentlyAuthError
    with pytest.raises(AgentlyAuthError):
        _envelope(_FakeResp({"ok": False}, status=401))


def test_rotated_token_via_on_rotated_callback(monkeypatch):
    import one_mail_agg.agently_source as gas
    captured = {}
    monkeypatch.setattr(gas.requests, "post", lambda url, data=None, timeout=None: _FakeResp(
        {"access_token": "AT", "refresh_token": "RT-NEW"}))
    oauth = {"refresh_token": "RT-OLD"}
    token = agently_access_token(oauth, lambda rt: captured.setdefault("rt", rt))
    assert token == "AT"
    assert oauth["refresh_token"] == "RT-NEW"
    assert captured["rt"] == "RT-NEW"


def test_rejected_refresh_is_auth_error(monkeypatch):
    import one_mail_agg.agently_source as gas
    monkeypatch.setattr(gas.requests, "post", lambda *a, **k: _FakeResp({}, status=400))
    from one_mail_agg.agently_source import AgentlyAuthError
    with pytest.raises(AgentlyAuthError):
        agently_access_token({"refresh_token": "BAD"})


# --- alias / pagination ------------------------------------------------------

def test_resolve_alias_prefers_primary(monkeypatch):
    import one_mail_agg.agently_source as gas
    monkeypatch.setattr(gas, "_api_get", lambda token, path, params=None: {
        "aliases": [
            {"alias_id": "alias_b", "is_primary": False},
            {"alias_id": "alias_a", "is_primary": True},
        ]})
    assert _resolve_alias_id("AT", _account()) == "alias_a"


def test_collect_pagination_stops_at_seen_anchor(monkeypatch, state):
    import one_mail_agg.agently_source as gas
    acc = _account()
    # seed the anchor: newest three are msg-3/2/1; msg-0 was already seen
    state.add_pop3_seen(acc.id, "INBOX", agently_uid_key(acc, "INBOX", "msg-0"))
    pages = [
        _list_page([_row("msg-2"), _row("msg-1")], has_more=True, next_cursor="c1"),
        _list_page([_row("msg-0")]),
    ]
    monkeypatch.setattr(gas, "_api_get", lambda token, path, params=None: pages.pop(0))
    pending = _collect_pending_message_ids("AT", acc, "INBOX", state, "alias_x")
    assert [row["_mid"] for row in pending] == ["msg-1", "msg-2"]  # oldest -> newest


def test_collect_first_sync_trims_to_initial_limit(monkeypatch, state):
    import one_mail_agg.agently_source as gas
    acc = _account(initial_sync_limit=2)
    rows = [_row(f"msg-{i}") for i in range(5)]
    monkeypatch.setattr(gas, "_api_get", lambda token, path, params=None: _list_page(rows))
    pending = _collect_pending_message_ids("AT", acc, "INBOX", state, "alias_x")
    # API returns newest -> oldest; initial_limit keeps the first 2 (msg-0/1);
    # reverse yields oldest -> newest.
    assert [row["_mid"] for row in pending] == ["msg-1", "msg-0"]
    seen = state.get_pop3_seen(acc.id, "INBOX")
    assert agently_uid_key(acc, "INBOX", "msg-2") in seen  # older marked seen


def test_collect_backlog_cap_fails_visibly(monkeypatch, state):
    import one_mail_agg.agently_source as gas
    acc = _account()
    # Established folder (has a seen anchor) is the only path that scans past
    # one page; first_sync stops after one page and trims via initial_sync_limit.
    state.add_pop3_seen(acc.id, "INBOX", agently_uid_key(acc, "INBOX", "old-seen"))

    counter = [0]

    def counting_endless(token, path, params=None):
        n = counter[0]
        counter[0] += 1
        return _list_page([_row(f"msg-{n}")], has_more=True, next_cursor=f"c{n + 1}")

    monkeypatch.setattr(gas, "_api_get", counting_endless)
    monkeypatch.setattr(gas, "_MAX_AGENTLY_MESSAGE_SCAN", 3)
    with pytest.raises(RuntimeError, match="backlog exceeded scan cap"):
        _collect_pending_message_ids("AT", acc, "INBOX", state, "alias_x")


# --- MIME assembly -----------------------------------------------------------

def test_build_mime_html_body_and_headers():
    acc = _account()
    detail = _detail("msg-1", body_format="HTML", body="<p>hi</p>")
    raw = _build_mime_from_api(acc, "INBOX", detail, "msg-1")
    assert b"Content-Type: text/html" in raw
    assert b"Subject: Hello" in raw
    assert b"<r@example.com>" in raw


def test_build_mime_attachment_roundtrip():
    acc = _account()
    detail = _detail("msg-1", attachments=[{
        "attachment_id": "att-1", "filename": "a.txt",
        "content_type": "text/plain",
        "content": base64.b64encode(b"data").decode(),
    }])
    raw = _build_mime_from_api(acc, "INBOX", detail, "msg-1")
    assert b"attachment; filename=" in raw
    assert b"ZGF0YQ==" in raw  # base64 of b"data" (EmailMessage re-encodes)


# --- sync end-to-end (mocked wire) -------------------------------------------

def test_sync_agently_commits_seen_after_upload(monkeypatch, state, tmp_path):
    import one_mail_agg.agently_source as gas
    from one_mail_agg.config import Config

    acc = _account()
    config = Config(worker_base_url="https://w.example", admin_token="t",
                    accounts=[acc], state_path=str(tmp_path / "cfg-state.json"),
                    config_path=None)

    uploaded = []
    monkeypatch.setattr(gas, "upload_emails", lambda cfg, batch: (
        uploaded.extend(batch), {"inserted": len(batch)})[1])
    monkeypatch.setattr(gas, "_api_get", lambda token, path, params=None: (
        {"aliases": [{"alias_id": "alias_x", "is_primary": True}]}
        if path == "/v1/me" else
        (_detail("msg-1") if "messages/msg-" in path else _list_page([_row("msg-1")]))
    ))
    monkeypatch.setattr(gas, "agently_access_token_locked", lambda acc_, cfg: "AT")

    result = sync_agently(acc, config, state)
    assert result == {"synced": 1, "dropped": 0, "protocol": "agently"}
    assert len(uploaded) == 1
    assert uploaded[0]["provider"] == "agently"
    assert uploaded[0]["source"] == "agently"
    assert uploaded[0]["source_key"] == agently_source_key(acc, "msg-1")
    # seen committed only after upload succeeded
    assert agently_uid_key(acc, "INBOX", "msg-1") in state.get_pop3_seen(acc.id, "INBOX")


def test_sync_requires_oauth():
    acc = _account(oauth=None)
    with pytest.raises(ValueError, match="requires oauth"):
        sync_agently(acc, None, None)


# --- outbound ----------------------------------------------------------------

def test_send_agently_success(monkeypatch, tmp_path):
    import one_mail_agg.agently_source as gas
    from one_mail_agg.config import Config
    acc = _account()
    config = Config(worker_base_url="https://w.example", admin_token="t",
                    accounts=[acc], state_path=str(tmp_path / "s.json"), config_path=None)
    monkeypatch.setattr(gas, "agently_access_token", lambda *a, **k: "AT")

    bodies = []

    def fake_post(url, headers=None, json=None, timeout=None):
        bodies.append(json)
        return _FakeResp({"ok": True, "data": {"message_id": "msg-out-1"}})

    monkeypatch.setattr(gas.requests, "post", fake_post)
    monkeypatch.setattr(gas, "_api_get", lambda token, path, params=None: {
        "aliases": [{"alias_id": "alias_x", "is_primary": True}]})

    provider_id = send_agently(acc, {
        "to_addr": "to@example.com", "subject": "s", "body_text": "hi",
        "is_html": False,
    }, config)
    assert provider_id == "msg-out-1"
    assert bodies[0]["body_format"] == "PLAIN"
    assert bodies[0]["skip_confirmation"] is True


def test_send_agently_classifies_errors(monkeypatch, tmp_path):
    import one_mail_agg.agently_source as gas
    import requests as _requests
    from one_mail_agg.config import Config
    acc = _account()
    config = Config(worker_base_url="https://w.example", admin_token="t",
                    accounts=[acc], state_path=str(tmp_path / "s.json"), config_path=None)
    monkeypatch.setattr(gas, "agently_access_token", lambda *a, **k: "AT")
    monkeypatch.setattr(gas, "_api_get", lambda token, path, params=None: {
        "aliases": [{"alias_id": "alias_x", "is_primary": True}]})

    http_error = _requests.HTTPError("HTTP 403",
                                     response=_FakeResp({"ok": False}, status=403))
    monkeypatch.setattr(gas.requests, "post", lambda *a, **k: (_ for _ in ()).throw(http_error))
    with pytest.raises(OutboundUnsupported):
        send_agently(acc, {"to_addr": "x@y", "subject": "s", "body_text": "b"}, config)

    http_500 = _requests.HTTPError("HTTP 500",
                                   response=_FakeResp({"ok": False}, status=500))
    monkeypatch.setattr(gas.requests, "post", lambda *a, **k: (_ for _ in ()).throw(http_500))
    from one_mail_agg.smtp_sender import OutboundOutcomeUnknown
    with pytest.raises(OutboundOutcomeUnknown):
        send_agently(acc, {"to_addr": "x@y", "subject": "s", "body_text": "b"}, config)

    monkeypatch.setattr(gas.requests, "post", lambda *a, **k: _FakeResp(
        {"ok": False, "error": {"code": 400, "message": "bad addr"}}, status=400))
    with pytest.raises(OutboundSendError):
        send_agently(acc, {"to_addr": "x@y", "subject": "s", "body_text": "b"}, config)
