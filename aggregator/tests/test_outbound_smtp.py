import time as _time

import pytest
import smtplib

import one_mail_agg.smtp_sender as smtp
from one_mail_agg.config import AccountConfig


# IMAP INTERNALDATE uses +0000 for UTC, which parsedate_to_datetime handles
# correctly as a UTC-aware datetime.
_RECENT_DATE = _time.strftime(
    "%d-%b-%Y %H:%M:%S +0000", _time.gmtime(_time.time())
).encode("ascii")


def _smtp_account(source="imap_qq", **overrides):
    kwargs = {
        "id": "acc-1",
        "source": source,
        "host": "imap.example.com",
        "port": 993,
        "username": "user@example.com",
        "password": "app-password",
        "use_ssl": True,
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


class _FakeSMTP:
    """Minimal stand-in for the smtplib client returned by connect_smtp."""

    def __init__(self, *, login_error=None, send_error=None, send_result=None):
        self.login_error = login_error
        self.send_error = send_error
        self.send_result = send_result if send_result is not None else {}
        self.logged_in = None
        self.sent = []
        self.quit_called = False

    def login(self, user, password):
        self.logged_in = (user, password)
        if self.login_error is not None:
            raise self.login_error

    def send_message(self, msg, from_addr, to_addrs):
        self.sent.append((msg, from_addr, to_addrs))
        if self.send_error is not None:
            raise self.send_error
        return self.send_result

    def quit(self):
        self.quit_called = True


def test_resolve_endpoint_uses_provider_defaults():
    assert smtp._resolve_smtp_endpoint(_smtp_account("imap_qq")) == ("smtp.qq.com", 465, True)
    assert smtp._resolve_smtp_endpoint(_smtp_account("imap_163")) == ("smtp.163.com", 465, True)
    assert smtp._resolve_smtp_endpoint(_smtp_account("imap_gmail")) == ("smtp.gmail.com", 587, False)
    assert smtp._resolve_smtp_endpoint(_smtp_account("imap_outlook")) == ("smtp-mail.outlook.com", 587, False)


def test_resolve_endpoint_explicit_overrides_win():
    account = _smtp_account("imap_qq", smtp_host="mail.example.com", smtp_port=2525)
    assert smtp._resolve_smtp_endpoint(account) == ("mail.example.com", 2525, True)


def test_resolve_endpoint_custom_imap_port_465_uses_ssl():
    account = _smtp_account("imap_custom", smtp_host="mail.linux.do", smtp_port=465)
    assert smtp._resolve_smtp_endpoint(account) == ("mail.linux.do", 465, True)


def test_resolve_endpoint_unknown_source_has_no_host():
    account = _smtp_account("imap_unknown")
    assert smtp._resolve_smtp_endpoint(account) == ("", 0, False)


def test_resolve_endpoint_custom_derives_smtp_from_host():
    acc1 = _smtp_account("imap_custom", host="imap.domain.com", smtp_host="")
    assert smtp._resolve_smtp_endpoint(acc1) == ("smtp.domain.com", 465, True)

    acc2 = _smtp_account("imap_custom", host="mail.domain.com", smtp_host="")
    assert smtp._resolve_smtp_endpoint(acc2) == ("mail.domain.com", 465, True)


def test_use_proxy_only_for_overseas_hosts():
    assert smtp._use_proxy("smtp.gmail.com") is True
    assert smtp._use_proxy("smtp-mail.outlook.com") is True
    assert smtp._use_proxy("smtp.qq.com") is False
    assert smtp._use_proxy("smtp.163.com") is False
    # policy overrides
    assert smtp._use_proxy("smtp.qq.com", "always") is True
    assert smtp._use_proxy("smtp.gmail.com", "never") is False


def test_build_outbound_mime_plain_text():
    msg = smtp.build_outbound_mime(_payload())
    assert msg["From"] == "Sender <user@example.com>"
    assert msg["To"] == "Recipient <to@example.com>"
    assert msg["Subject"] == "Hello"
    assert msg.get_content_type() == "text/plain"
    assert msg.get_content().strip() == "plain body"


def test_build_outbound_mime_html_preferred_when_present():
    payload = _payload(body_html="<b>html</b>")
    msg = smtp.build_outbound_mime(payload)
    assert msg.get_content_type() == "text/html"
    assert msg.get_content().strip() == "<b>html</b>"


def test_send_smtp_message_no_host_is_unsupported(monkeypatch):
    account = _smtp_account("imap_unknown")
    with pytest.raises(smtp.OutboundUnsupported, match="no SMTP host"):
        smtp.send_smtp_message(account, _payload())


def test_send_smtp_message_no_credentials_is_identity_error():
    account = _smtp_account("imap_qq", password="")
    with pytest.raises(smtp.OutboundIdentityError, match="no SMTP credentials"):
        smtp.send_smtp_message(account, _payload())


def test_send_smtp_message_auth_failure_is_identity_error(monkeypatch):
    account = _smtp_account()
    client = _FakeSMTP(login_error=smtplib.SMTPAuthenticationError(535, b"bad password"))
    monkeypatch.setattr(smtp, "connect_smtp", lambda *a, **k: client)

    with pytest.raises(smtp.OutboundIdentityError, match="SMTP auth/HELO"):
        smtp.send_smtp_message(account, _payload())
    assert client.quit_called is True


def test_send_smtp_message_recipients_refused_is_send_error(monkeypatch):
    account = _smtp_account()
    client = _FakeSMTP(send_error=smtplib.SMTPRecipientsRefused({"to@example.com": (550, b"nope")}))
    monkeypatch.setattr(smtp, "connect_smtp", lambda *a, **k: client)

    with pytest.raises(smtp.OutboundSendError, match="SMTP send refused"):
        smtp.send_smtp_message(account, _payload())


def test_send_smtp_message_soft_protocol_error_is_outcome_unknown(monkeypatch):
    account = _smtp_account()
    client = _FakeSMTP(send_error=smtplib.SMTPException("connection dropped after DATA"))
    monkeypatch.setattr(smtp, "connect_smtp", lambda *a, **k: client)

    with pytest.raises(smtp.OutboundOutcomeUnknown, match="outcome is unknown"):
        smtp.send_smtp_message(account, _payload())


def test_send_smtp_message_transport_loss_is_outcome_unknown(monkeypatch):
    account = _smtp_account()
    client = _FakeSMTP(send_error=OSError("broken pipe"))
    monkeypatch.setattr(smtp, "connect_smtp", lambda *a, **k: client)

    with pytest.raises(smtp.OutboundOutcomeUnknown):
        smtp.send_smtp_message(account, _payload())


def test_send_smtp_message_success_returns_none(monkeypatch):
    account = _smtp_account()
    client = _FakeSMTP()
    monkeypatch.setattr(smtp, "connect_smtp", lambda *a, **k: client)

    assert smtp.send_smtp_message(account, _payload()) is None
    assert client.logged_in == ("user@example.com", "app-password")
    assert len(client.sent) == 1


class _FakeImapSent:
    def __init__(self, folders=("Sent",), search_uids=(), internaldate=b"", envelope=b""):
        self.folders = list(folders)
        self.search_uids = list(search_uids)
        self.internaldate = internaldate
        self.envelope = envelope
        self.selected = None
        self.logged_out = False

    def list_folders(self):
        return [(b"\\HasNoChildren", b"/", name.encode()) for name in self.folders]

    def select_folder(self, folder, readonly=True):
        self.selected = folder
        return {b"UIDVALIDITY": 1}

    def search(self, criteria, charset=None):
        return list(self.search_uids)

    def fetch(self, uids, data):
        result = {}
        for uid in uids:
            result[uid] = {
                b"INTERNALDATE": self.internaldate,
                b"ENVELOPE": self.envelope,
            }
        return result

    def logout(self):
        self.logged_out = True


def _imap_account_with_oauth():
    return _smtp_account("imap_gmail", oauth={"provider": "gmail", "client_id": "cid", "refresh_token": "rt"})


def test_discover_sent_folder_prefers_candidate(monkeypatch):
    account = _smtp_account()
    client = _FakeImapSent(folders=("INBOX", "Sent", "已发送"))
    assert smtp._discover_sent_folder(account, client) == "Sent"


def test_discover_sent_folder_no_candidate_is_unsupported(monkeypatch):
    account = _smtp_account()
    client = _FakeImapSent(folders=("INBOX", "Archive"))
    with pytest.raises(smtp.OutboundUnsupported, match="no Sent folder"):
        smtp._discover_sent_folder(account, client)


def test_reconcile_sent_folder_single_match_returns_uid(monkeypatch):
    account = _smtp_account()
    client = _FakeImapSent(
        folders=("Sent",),
        search_uids=[42],
        internaldate=_RECENT_DATE,
        envelope=b"Hello",
    )
    monkeypatch.setattr(smtp, "_imap_client_for_account", lambda account, config: client)

    assert smtp.reconcile_sent_folder(account, _payload(), None) == "42"
    assert client.selected == "Sent"


def test_reconcile_sent_folder_zero_matches_returns_none(monkeypatch):
    account = _smtp_account()
    client = _FakeImapSent(folders=("Sent",), search_uids=[])
    monkeypatch.setattr(smtp, "_imap_client_for_account", lambda account, config: client)

    assert smtp.reconcile_sent_folder(account, _payload(), None) is None


def test_reconcile_sent_folder_ambiguous_subject_returns_none(monkeypatch):
    account = _smtp_account()
    client = _FakeImapSent(
        folders=("Sent",),
        search_uids=[43, 44],
        internaldate=_RECENT_DATE,
        envelope=b"Hello",
    )
    monkeypatch.setattr(smtp, "_imap_client_for_account", lambda account, config: client)

    assert smtp.reconcile_sent_folder(account, _payload(), None) is None


def test_reconcile_sent_folder_imap_error_is_reconcile_error(monkeypatch):
    from imapclient.exceptions import IMAPClientError

    account = _smtp_account()

    def boom(account, config):
        raise IMAPClientError("select failed")

    monkeypatch.setattr(smtp, "_imap_client_for_account", boom)
    with pytest.raises(smtp.ReconcileError, match="reconciliation failed"):
        smtp.reconcile_sent_folder(account, _payload(), None)


def test_send_with_reconcile_clean_success_returns_none(monkeypatch):
    account = _smtp_account()
    monkeypatch.setattr(smtp, "send_smtp_message", lambda *a: None)
    assert smtp.send_with_reconcile(account, _payload(), None) is None


def test_send_with_reconcile_reconciled_outcome_returns_provider_id(monkeypatch):
    account = _smtp_account()
    monkeypatch.setattr(
        smtp,
        "send_smtp_message",
        lambda *a: (_ for _ in ()).throw(smtp.OutboundOutcomeUnknown("lost")),
    )
    monkeypatch.setattr(smtp, "reconcile_sent_folder", lambda *a, **k: "42")
    assert smtp.send_with_reconcile(account, _payload(), None) == "42"


def test_send_with_reconcile_unresolvable_outcome_reraises(monkeypatch):
    account = _smtp_account()
    original = smtp.OutboundOutcomeUnknown("lost")
    monkeypatch.setattr(smtp, "send_smtp_message", lambda *a: (_ for _ in ()).throw(original))
    monkeypatch.setattr(smtp, "reconcile_sent_folder", lambda *a, **k: None)
    with pytest.raises(smtp.OutboundOutcomeUnknown) as caught:
        smtp.send_with_reconcile(account, _payload(), None)
    assert caught.value is original


def test_send_with_reconcile_reconcile_error_keeps_original_cause(monkeypatch):
    account = _smtp_account()
    original = smtp.OutboundOutcomeUnknown("lost")
    monkeypatch.setattr(smtp, "send_smtp_message", lambda *a: (_ for _ in ()).throw(original))
    monkeypatch.setattr(
        smtp,
        "reconcile_sent_folder",
        lambda *a, **k: (_ for _ in ()).throw(smtp.ReconcileError("select failed")),
    )
    with pytest.raises(smtp.OutboundOutcomeUnknown) as caught:
        smtp.send_with_reconcile(account, _payload(), None)
    assert caught.value is original
    assert caught.value.__cause__ is None
