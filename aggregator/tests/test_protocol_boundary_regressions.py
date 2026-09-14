import pytest
from imapclient.exceptions import IMAPClientError

import one_mail_agg.sync as sync_mod
from one_mail_agg.config import AccountConfig, Config
from one_mail_agg.state import SyncState


def _config(account):
    return Config(
        worker_base_url="https://worker.example",
        admin_token="secret",
        accounts=[account],
    )


def _account(*, protocol="auto", folders=None):
    return AccountConfig(
        id="acc-1",
        source="imap_163",
        host="imap.163.com",
        port=993,
        username="user@163.com",
        password="pw",
        folders=folders or ["INBOX"],
        protocol=protocol,
        pop3_host="pop.163.com",
        pop3_port=995,
        pop3_ssl=True,
    )


def test_auto_fallback_rejected_after_any_imap_history(tmp_path, monkeypatch):
    state = SyncState(str(tmp_path / "state.json"))
    state.set_uidvalidity("acc-1", "INBOX", 777)
    account = _account()

    monkeypatch.setattr(
        sync_mod,
        "sync_pop3",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("POP3 must not be used after IMAP history")),
    )

    def fail_imap(_account):
        raise IMAPClientError("Unsafe Login")

    with pytest.raises(IMAPClientError, match="Unsafe Login"):
        sync_mod.sync_account(fail_imap, _config(account), account, state)

    assert state.has_imap_history("acc-1") is True
    assert state.is_fallback_pinned("acc-1") is False


def test_auto_fallback_rejected_for_multi_folder_account(tmp_path, monkeypatch):
    state = SyncState(str(tmp_path / "state.json"))
    account = _account(folders=["INBOX", "Archive"])

    monkeypatch.setattr(
        sync_mod,
        "sync_pop3",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("multi-folder accounts must stay IMAP")),
    )

    def fail_imap(_account):
        raise OSError("connection reset")

    with pytest.raises(OSError, match="connection reset"):
        sync_mod.sync_account(fail_imap, _config(account), account, state)

    assert state.is_fallback_pinned("acc-1") is False


def test_first_use_inbox_only_auto_account_can_fallback_and_pin(tmp_path, monkeypatch):
    state = SyncState(str(tmp_path / "state.json"))
    account = _account()
    calls = []

    def fake_pop3(acc, config, sync_state):
        calls.append(acc.id)
        return {"synced": 1, "dropped": 0, "protocol": "pop3"}

    monkeypatch.setattr(sync_mod, "sync_pop3", fake_pop3)

    def fail_imap(_account):
        raise IMAPClientError("Unsafe Login")

    result = sync_mod.sync_account(fail_imap, _config(account), account, state)

    assert result == {"synced": 1, "dropped": 0, "protocol": "pop3"}
    assert calls == ["acc-1"]
    assert state.is_fallback_pinned("acc-1") is True


def test_explicit_imap_clears_stale_pop3_pin(tmp_path, monkeypatch):
    state = SyncState(str(tmp_path / "state.json"))
    state.set_fallback_pinned("acc-1", True)
    account = _account(protocol="imap")

    monkeypatch.setattr(sync_mod, "maybe_sync_imap_folder_catalog", lambda *a, **k: 0)

    class Client:
        def select_folder(self, folder, readonly=True):
            return {b"UIDVALIDITY": 9}

        def search(self, *a, **k):
            return []

        def fetch(self, *a, **k):
            return {}

        def logout(self):
            pass

    result = sync_mod.sync_account(lambda _acc: Client(), _config(account), account, state)

    assert result["protocol"] == "imap"
    assert result["synced"] == 0
    assert state.is_fallback_pinned("acc-1") is False
