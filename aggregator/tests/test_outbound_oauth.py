import json
from contextlib import contextmanager

import pytest
import requests

import one_mail_agg.oauth_sender as oauth_send
from one_mail_agg.config import AccountConfig


def _oauth_account(source="imap_gmail", **overrides):
    kwargs = {
        "id": "acc-1",
        "source": source,
        "host": "imap.example.com",
        "port": 993,
        "username": "user@example.com",
        "password": "",
        "use_ssl": True,
        "oauth": {"provider": "gmail", "client_id": "cid", "client_secret": "cs",
                  "refresh_token": "rt"},
    }
    kwargs.update(overrides)
    return AccountConfig(**kwargs)


def _payload(**overrides):
    payload = {
        "from_addr": "user@example.com",
        "from_name": "Sender",
        "to_addr": "to@example.com",
        "to_name": "Recipient",
        "subject": "Hello",
        "body_text": "plain body",
        "body_html": "",
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------- scope

def test_graph_scope_allows_send_empty_scope_returns_true():
    assert oauth_send._graph_scope_allows_send({}) is True


def test_graph_scope_allows_send_no_scope_field_returns_true():
    assert oauth_send._graph_scope_allows_send({"client_id": "cid"}) is True


def test_graph_scope_allows_send_mail_send_is_true():
    assert oauth_send._graph_scope_allows_send({"scope": "Mail.Send"}) is True
    assert oauth_send._graph_scope_allows_send({"scope": "https://graph.microsoft.com/Mail.Send"}) is True


def test_graph_scope_allows_send_mail_readwrite_is_true():
    assert oauth_send._graph_scope_allows_send({"scope": "Mail.ReadWrite"}) is True
    assert oauth_send._graph_scope_allows_send({"scope": "openid Mail.ReadWrite offline_access"}) is True


def test_graph_scope_allows_send_read_only_is_false():
    assert oauth_send._graph_scope_allows_send({"scope": "Mail.Read"}) is False
    assert oauth_send._graph_scope_allows_send({"scope": "openid Mail.Read"}) is False


def test_graph_scope_allows_send_default_app_scope_returns_true():
    # .default app scopes omit individual delegated permissions in the token
    # response: they do not prove read-only access.
    assert oauth_send._graph_scope_allows_send({
        "scope": "https://graph.microsoft.com/.default",
    }) is True


# ---------------------------------------------------------------------- XOAUTH2

class _FakeSMTP:
    def __init__(self, docmd_result=(334, b"challenge accepted")):
        self.docmd_result = docmd_result
        self.docmd_calls = []
        self.sent = []
        self.quit_called = False

    def docmd(self, *args):
        self.docmd_calls.append(args)
        return self.docmd_result

    def send_message(self, msg, from_addr, to_addrs):
        self.sent.append((msg, from_addr, to_addrs))
        return {}

    def quit(self):
        self.quit_called = True


def test_xoauth2_auth_sends_correct_format():
    client = _FakeSMTP()
    oauth_send._xoauth2_auth(client, "user@example.com", "at-123")
    assert len(client.docmd_calls) == 1
    assert client.docmd_calls[0][0] == "AUTH"
    encoded = client.docmd_calls[0][1]
    assert encoded.startswith("XOAUTH2 ")
    import base64
    decoded = base64.b64decode(encoded[len("XOAUTH2 "):]).decode()
    assert decoded == "user=user@example.com\x01auth=Bearer at-123\x01\x01"


def test_xoauth2_auth_non_334_response_is_identity_error():
    client = _FakeSMTP(docmd_result=(535, b"auth failed"))
    with pytest.raises(oauth_send.OutboundIdentityError, match="XOAUTH2 auth rejected"):
        oauth_send._xoauth2_auth(client, "user@example.com", "at-123")


# ---------------------------------------------------------------------- _send_smtp_xoauth (shared path)

def test_send_smtp_xoauth_no_oauth_is_identity_error(monkeypatch):
    account = _oauth_account(oauth=None)
    with pytest.raises(oauth_send.OutboundIdentityError, match="no OAuth config"):
        oauth_send._send_smtp_xoauth(account, _payload(), None, lambda *a: "AT", "gmail")


def test_send_smtp_xoauth_sends_and_returns_none(monkeypatch):
    account = _oauth_account()
    client = _FakeSMTP()
    monkeypatch.setattr(oauth_send, "connect_smtp", lambda *a, **k: client)
    monkeypatch.setattr(oauth_send, "redemption_lock", lambda: contextmanager(lambda: (yield))())
    monkeypatch.setattr(oauth_send, "refresh_rt_from_config", lambda *a: None)

    def token_fn(oauth, on_rotated):
        return "AT-123"

    result = oauth_send._send_smtp_xoauth(account, _payload(), None, token_fn, "gmail")
    assert result is None
    assert len(client.docmd_calls) == 1  # XOAUTH2
    assert len(client.sent) == 1
    assert client.quit_called is True


def test_send_smtp_xoauth_outlook_uses_outlook_endpoint(monkeypatch):
    account = _oauth_account(source="imap_outlook")
    captured = {}

    def fake_connect(host, port, use_ssl, timeout=30):
        captured.update(host=host, port=port, use_ssl=use_ssl)
        return _FakeSMTP()

    monkeypatch.setattr(oauth_send, "connect_smtp", fake_connect)
    monkeypatch.setattr(oauth_send, "redemption_lock", lambda: contextmanager(lambda: (yield))())
    monkeypatch.setattr(oauth_send, "refresh_rt_from_config", lambda *a: None)

    oauth_send._send_smtp_xoauth(account, _payload(), None, lambda *a: "AT", "outlook")
    assert captured["host"] == "smtp-mail.outlook.com"
    assert captured["port"] == 587
    assert captured["use_ssl"] is False


def test_send_smtp_xoauth_transport_loss_is_outcome_unknown(monkeypatch):
    account = _oauth_account()

    def boom(*a, **k):
        raise OSError("broken pipe")

    monkeypatch.setattr(oauth_send, "connect_smtp", boom)
    monkeypatch.setattr(oauth_send, "redemption_lock", lambda: contextmanager(lambda: (yield))())
    monkeypatch.setattr(oauth_send, "refresh_rt_from_config", lambda *a: None)

    with pytest.raises(oauth_send.OutboundOutcomeUnknown, match="transport lost"):
        oauth_send._send_smtp_xoauth(account, _payload(), None, lambda *a: "AT", "gmail")


# ---------------------------------------------------------------------- send_graph

def test_send_graph_read_only_scope_is_unsupported():
    account = _oauth_account(source="graph_outlook", oauth={
        "provider": "graph", "client_id": "cid", "refresh_token": "rt",
        "scope": "Mail.Read",
    })
    with pytest.raises(oauth_send.OutboundUnsupported, match="read-only scope"):
        oauth_send.send_graph(account, _payload(), None)


class _GraphResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = json.dumps(self._payload)
        self.response = None

    def raise_for_status(self):
        if self.status_code >= 400:
            response = requests.Response()
            response.status_code = self.status_code
            raise requests.HTTPError(response=response)
        return None

    def json(self):
        return self._payload


def test_send_graph_success_202_returns_none(monkeypatch):
    account = _oauth_account(source="graph_outlook")
    monkeypatch.setattr(oauth_send, "redemption_lock", lambda: contextmanager(lambda: (yield))())
    monkeypatch.setattr(oauth_send, "refresh_rt_from_config", lambda *a: None)
    monkeypatch.setattr(oauth_send, "graph_access_token", lambda oauth, cb: "AT")
    monkeypatch.setattr(oauth_send.requests, "post", lambda *a, **k: _GraphResponse(202))

    assert oauth_send.send_graph(account, _payload(), None) is None


def test_send_graph_403_is_unsupported(monkeypatch):
    account = _oauth_account(source="graph_outlook")
    monkeypatch.setattr(oauth_send, "redemption_lock", lambda: contextmanager(lambda: (yield))())
    monkeypatch.setattr(oauth_send, "refresh_rt_from_config", lambda *a: None)
    monkeypatch.setattr(oauth_send, "graph_access_token", lambda oauth, cb: "AT")

    def fake_post(*a, **k):
        response = requests.Response()
        response.status_code = 403
        error = requests.HTTPError(response=response)
        error.response = response
        raise error

    monkeypatch.setattr(oauth_send.requests, "post", fake_post)
    with pytest.raises(oauth_send.OutboundUnsupported, match="forbidden"):
        oauth_send.send_graph(account, _payload(), None)


def test_send_graph_429_is_outcome_unknown(monkeypatch):
    account = _oauth_account(source="graph_outlook")
    monkeypatch.setattr(oauth_send, "redemption_lock", lambda: contextmanager(lambda: (yield))())
    monkeypatch.setattr(oauth_send, "refresh_rt_from_config", lambda *a: None)
    monkeypatch.setattr(oauth_send, "graph_access_token", lambda oauth, cb: "AT")

    def fake_post(*a, **k):
        response = requests.Response()
        response.status_code = 429
        error = requests.HTTPError(response=response)
        error.response = response
        raise error

    monkeypatch.setattr(oauth_send.requests, "post", fake_post)
    with pytest.raises(oauth_send.OutboundOutcomeUnknown, match="transient"):
        oauth_send.send_graph(account, _payload(), None)


def test_send_graph_502_is_outcome_unknown(monkeypatch):
    account = _oauth_account(source="graph_outlook")
    monkeypatch.setattr(oauth_send, "redemption_lock", lambda: contextmanager(lambda: (yield))())
    monkeypatch.setattr(oauth_send, "refresh_rt_from_config", lambda *a: None)
    monkeypatch.setattr(oauth_send, "graph_access_token", lambda oauth, cb: "AT")

    def fake_post(*a, **k):
        response = requests.Response()
        response.status_code = 502
        error = requests.HTTPError(response=response)
        error.response = response
        raise error

    monkeypatch.setattr(oauth_send.requests, "post", fake_post)
    with pytest.raises(oauth_send.OutboundOutcomeUnknown):
        oauth_send.send_graph(account, _payload(), None)


def test_send_graph_400_is_send_error(monkeypatch):
    account = _oauth_account(source="graph_outlook")
    monkeypatch.setattr(oauth_send, "redemption_lock", lambda: contextmanager(lambda: (yield))())
    monkeypatch.setattr(oauth_send, "refresh_rt_from_config", lambda *a: None)
    monkeypatch.setattr(oauth_send, "graph_access_token", lambda oauth, cb: "AT")

    def fake_post(*a, **k):
        response = requests.Response()
        response.status_code = 400
        error = requests.HTTPError(response=response)
        error.response = response
        raise error

    monkeypatch.setattr(oauth_send.requests, "post", fake_post)
    with pytest.raises(oauth_send.OutboundSendError, match="rejected"):
        oauth_send.send_graph(account, _payload(), None)


def test_send_graph_timeout_is_outcome_unknown(monkeypatch):
    account = _oauth_account(source="graph_outlook")
    monkeypatch.setattr(oauth_send, "redemption_lock", lambda: contextmanager(lambda: (yield))())
    monkeypatch.setattr(oauth_send, "refresh_rt_from_config", lambda *a: None)
    monkeypatch.setattr(oauth_send, "graph_access_token", lambda oauth, cb: "AT")
    monkeypatch.setattr(oauth_send.requests, "post",
                        lambda *a, **k: (_ for _ in ()).throw(requests.Timeout("timed out")))

    with pytest.raises(oauth_send.OutboundOutcomeUnknown, match="request lost"):
        oauth_send.send_graph(account, _payload(), None)


def test_send_graph_sets_save_to_sent_items(monkeypatch):
    account = _oauth_account(source="graph_outlook")
    captured = {}
    monkeypatch.setattr(oauth_send, "redemption_lock", lambda: contextmanager(lambda: (yield))())
    monkeypatch.setattr(oauth_send, "refresh_rt_from_config", lambda *a: None)
    monkeypatch.setattr(oauth_send, "graph_access_token", lambda oauth, cb: "AT")

    def fake_post(url, **kwargs):
        captured.update(kwargs)
        return _GraphResponse(202)

    monkeypatch.setattr(oauth_send.requests, "post", fake_post)
    oauth_send.send_graph(account, _payload(), None)
    assert captured["json"]["saveToSentItems"] is True
    assert captured["json"]["message"]["subject"] == "Hello"


# ---------------------------------------------------------------------- send_outbound_oauth dispatcher

def test_send_outbound_oauth_dispatches_gmail(monkeypatch):
    account = _oauth_account(source="imap_gmail")
    called = {}
    monkeypatch.setattr(oauth_send, "send_gmail", lambda *a: called.update(provider="gmail"))
    oauth_send.send_outbound_oauth(account, _payload(), None)
    assert called == {"provider": "gmail"}


def test_send_outbound_oauth_dispatches_outlook_smtp(monkeypatch):
    account = _oauth_account(source="imap_outlook")
    called = {}
    monkeypatch.setattr(oauth_send, "send_outlook_smtp", lambda *a: called.update(provider="outlook"))
    oauth_send.send_outbound_oauth(account, _payload(), None)
    assert called == {"provider": "outlook"}


def test_send_outbound_oauth_dispatches_msa(monkeypatch):
    account = _oauth_account(source="msa")
    called = {}
    monkeypatch.setattr(oauth_send, "send_outlook_smtp", lambda *a: called.update(provider="msa"))
    oauth_send.send_outbound_oauth(account, _payload(), None)
    assert called == {"provider": "msa"}


def test_send_outbound_oauth_dispatches_graph(monkeypatch):
    account = _oauth_account(source="graph_outlook")
    called = {}
    monkeypatch.setattr(oauth_send, "send_graph", lambda *a: called.update(provider="graph"))
    oauth_send.send_outbound_oauth(account, _payload(), None)
    assert called == {"provider": "graph"}


def test_send_outbound_oauth_unknown_provider_is_unsupported():
    account = _oauth_account(source="imap_unknown")
    with pytest.raises(oauth_send.OutboundUnsupported, match="unknown OAuth send provider"):
        oauth_send.send_outbound_oauth(account, _payload(), None)


# ---------------------------------------------------------------------- reconcile_graph_sent

def _graph_account():
    return _oauth_account(source="graph_outlook", oauth={
        "provider": "graph", "client_id": "cid", "refresh_token": "rt",
    })


def test_reconcile_graph_sent_single_match_returns_immutable_id(monkeypatch):
    import time
    sent = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()))
    account = _graph_account()
    monkeypatch.setattr(oauth_send, "redemption_lock", lambda: contextmanager(lambda: (yield))())
    monkeypatch.setattr(oauth_send, "refresh_rt_from_config", lambda *a: None)
    monkeypatch.setattr(oauth_send, "graph_access_token", lambda oauth, cb: "AT")
    monkeypatch.setattr(
        oauth_send.requests,
        "get",
        lambda *a, **k: _GraphResponse(200, {"value": [
            {"id": "immutable-1", "subject": "Hello", "sentDateTime": sent},
        ]}),
    )
    assert oauth_send.reconcile_graph_sent(account, _payload(), None) == "immutable-1"


def test_reconcile_graph_sent_zero_matches_returns_none(monkeypatch):
    account = _graph_account()
    monkeypatch.setattr(oauth_send, "redemption_lock", lambda: contextmanager(lambda: (yield))())
    monkeypatch.setattr(oauth_send, "refresh_rt_from_config", lambda *a: None)
    monkeypatch.setattr(oauth_send, "graph_access_token", lambda oauth, cb: "AT")
    monkeypatch.setattr(oauth_send.requests, "get", lambda *a, **k: _GraphResponse(200, {"value": []}))
    assert oauth_send.reconcile_graph_sent(account, _payload(), None) is None


def test_reconcile_graph_sent_ambiguous_returns_none(monkeypatch):
    import time
    sent = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()))
    account = _graph_account()
    monkeypatch.setattr(oauth_send, "redemption_lock", lambda: contextmanager(lambda: (yield))())
    monkeypatch.setattr(oauth_send, "refresh_rt_from_config", lambda *a: None)
    monkeypatch.setattr(oauth_send, "graph_access_token", lambda oauth, cb: "AT")
    monkeypatch.setattr(
        oauth_send.requests,
        "get",
        lambda *a, **k: _GraphResponse(200, {"value": [
            {"id": "immutable-1", "subject": "Hello", "sentDateTime": sent},
            {"id": "immutable-2", "subject": "Hello", "sentDateTime": sent},
        ]}),
    )
    assert oauth_send.reconcile_graph_sent(account, _payload(), None) is None


def test_reconcile_graph_sent_transient_error_is_reconcile_error(monkeypatch):
    account = _graph_account()
    monkeypatch.setattr(oauth_send, "redemption_lock", lambda: contextmanager(lambda: (yield))())
    monkeypatch.setattr(oauth_send, "refresh_rt_from_config", lambda *a: None)
    monkeypatch.setattr(oauth_send, "graph_access_token", lambda oauth, cb: "AT")
    monkeypatch.setattr(
        oauth_send.requests,
        "get",
        lambda *a, **k: (_ for _ in ()).throw(requests.Timeout("timed out")),
    )
    with pytest.raises(oauth_send.ReconcileError, match="reconciliation failed"):
        oauth_send.reconcile_graph_sent(account, _payload(), None)


# ---------------------------------------------------------------------- send_oauth_with_reconcile

def test_send_oauth_with_reconcile_clean_success_returns_none(monkeypatch):
    account = _graph_account()
    monkeypatch.setattr(oauth_send, "send_outbound_oauth", lambda *a: None)
    assert oauth_send.send_oauth_with_reconcile(account, _payload(), None) is None


def test_send_oauth_with_reconcile_graph_reconciled_returns_id(monkeypatch):
    account = _graph_account()
    monkeypatch.setattr(
        oauth_send,
        "send_outbound_oauth",
        lambda *a: (_ for _ in ()).throw(oauth_send.OutboundOutcomeUnknown("lost")),
    )
    monkeypatch.setattr(oauth_send, "reconcile_graph_sent", lambda *a, **k: "immutable-1")
    assert oauth_send.send_oauth_with_reconcile(account, _payload(), None) == "immutable-1"


def test_send_oauth_with_reconcile_imap_reconciled_returns_id(monkeypatch):
    account = _oauth_account(source="imap_gmail")
    monkeypatch.setattr(
        oauth_send,
        "send_outbound_oauth",
        lambda *a: (_ for _ in ()).throw(oauth_send.OutboundOutcomeUnknown("lost")),
    )
    monkeypatch.setattr(oauth_send, "reconcile_sent_folder", lambda *a, **k: "42")
    assert oauth_send.send_oauth_with_reconcile(account, _payload(), None) == "42"


def test_send_oauth_with_reconcile_unresolvable_reraises(monkeypatch):
    account = _oauth_account(source="imap_gmail")
    original = oauth_send.OutboundOutcomeUnknown("lost")
    monkeypatch.setattr(oauth_send, "send_outbound_oauth", lambda *a: (_ for _ in ()).throw(original))
    monkeypatch.setattr(oauth_send, "reconcile_sent_folder", lambda *a, **k: None)
    with pytest.raises(oauth_send.OutboundOutcomeUnknown) as caught:
        oauth_send.send_oauth_with_reconcile(account, _payload(), None)
    assert caught.value is original


def test_send_oauth_with_reconcile_reconcile_error_keeps_original(monkeypatch):
    account = _oauth_account(source="imap_gmail")
    original = oauth_send.OutboundOutcomeUnknown("lost")
    monkeypatch.setattr(oauth_send, "send_outbound_oauth", lambda *a: (_ for _ in ()).throw(original))
    monkeypatch.setattr(
        oauth_send,
        "reconcile_sent_folder",
        lambda *a, **k: (_ for _ in ()).throw(oauth_send.ReconcileError("select failed")),
    )
    with pytest.raises(oauth_send.OutboundOutcomeUnknown) as caught:
        oauth_send.send_oauth_with_reconcile(account, _payload(), None)
    assert caught.value is original
    assert caught.value.__cause__ is None