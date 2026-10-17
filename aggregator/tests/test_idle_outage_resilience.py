from unittest.mock import patch, MagicMock
import pytest
import requests

from one_mail_agg.config import Config, AccountConfig
from one_mail_agg.state import SyncState
import one_mail_agg.main as main_mod
import one_mail_agg.idle_worker as idle_mod


def _mock_config(tmp_path):
    return Config(
        worker_base_url="https://worker.test",
        admin_token="secret",
        accounts=[
            AccountConfig(
                id="qq-main",
                source="imap_qq",
                host="imap.qq.com",
                port=993,
                username="qq@qq.com",
                password="pw",
                use_ssl=True,
            )
        ],
        state_path=str(tmp_path / "sync_state.json"),
    )


def test_get_merged_accounts_retains_cache_on_worker_outage(tmp_path, monkeypatch):
    main_mod._clear_user_accounts_cache()
    monkeypatch.setattr(main_mod, "assert_public_user_account", lambda _: None)
    config = _mock_config(tmp_path)
    state = SyncState(config.state_path)

    gmail_account = AccountConfig(
        id="gmail-user",
        source="imap_gmail",
        host="imap.gmail.com",
        port=993,
        username="user@gmail.com",
        password="pw",
        use_ssl=True,
        user_managed=True,
    )

    # 1. First fetch succeeds: returns gmail account
    with patch("one_mail_agg.main.fetch_user_accounts", return_value=[gmail_account]):
        accounts, user_ids = main_mod.get_merged_accounts(config, state)
        assert len(accounts) == 2
        assert "gmail-user" in user_ids
        assert {a.id for a in accounts} == {"qq-main", "gmail-user"}

    # 2. Second fetch fails with ReadTimeout: cache must be retained!
    with patch("one_mail_agg.main.fetch_user_accounts", side_effect=requests.exceptions.ReadTimeout("Cloudflare timeout")):
        accounts_retry, user_ids_retry = main_mod.get_merged_accounts(config, state)
        assert len(accounts_retry) == 2
        assert "gmail-user" in user_ids_retry
        assert {a.id for a in accounts_retry} == {"qq-main", "gmail-user"}


def test_get_merged_accounts_updates_cache_when_empty_returned(tmp_path, monkeypatch):
    main_mod._clear_user_accounts_cache()
    monkeypatch.setattr(main_mod, "assert_public_user_account", lambda _: None)
    config = _mock_config(tmp_path)
    state = SyncState(config.state_path)

    gmail_account = AccountConfig(
        id="gmail-user",
        source="imap_gmail",
        host="imap.gmail.com",
        port=993,
        username="user@gmail.com",
        password="pw",
        use_ssl=True,
        user_managed=True,
    )

    # First fetch succeeds
    with patch("one_mail_agg.main.fetch_user_accounts", return_value=[gmail_account]):
        accounts, user_ids = main_mod.get_merged_accounts(config, state)
        assert len(accounts) == 2

    # Second fetch legitimately returns empty list (user removed the account)
    with patch("one_mail_agg.main.fetch_user_accounts", return_value=[]):
        accounts, user_ids = main_mod.get_merged_accounts(config, state)
        assert len(accounts) == 1
        assert "gmail-user" not in user_ids
        assert accounts[0].id == "qq-main"


def test_idle_workers_not_killed_during_transient_worker_outage(tmp_path, monkeypatch):
    main_mod._clear_user_accounts_cache()
    monkeypatch.setattr(main_mod, "assert_public_user_account", lambda _: None)
    config = _mock_config(tmp_path)
    state = SyncState(config.state_path)

    gmail_account = AccountConfig(
        id="gmail-user-9a30",
        source="imap_gmail",
        host="imap.gmail.com",
        port=993,
        username="dengyietech@gmail.com",
        password="pw",
        use_ssl=True,
        user_managed=True,
    )

    # Mock client factory to avoid real network socket in IDLE worker
    mock_client = MagicMock()
    mock_client.has_capability.return_value = True
    monkeypatch.setattr(idle_mod, "default_client_factory", lambda acc: mock_client)
    monkeypatch.setattr(idle_mod, "_resolve_client_factory", lambda acc, cfg: (lambda a: mock_client))

    with idle_mod._lock:
        idle_mod._active_idle_workers.clear()

    try:
        # Pass 1: Healthy Worker API fetch -> launches IDLE worker for gmail
        with patch("one_mail_agg.main.fetch_user_accounts", return_value=[gmail_account]):
            main_mod._poll_pass(config, state)

        worker = idle_mod._active_idle_workers.get("gmail-user-9a30")
        assert worker is not None
        assert not worker.is_stopped()

        # Pass 2: Outage on Worker API (ReadTimeout) -> cache retained, worker MUST NOT be stopped!
        with patch("one_mail_agg.main.fetch_user_accounts", side_effect=requests.exceptions.ReadTimeout("GCP to CF timeout")):
            main_mod._poll_pass(config, state)

        retained_worker = idle_mod._active_idle_workers.get("gmail-user-9a30")
        assert retained_worker is worker
        assert not retained_worker.is_stopped(), "Active IDLE worker was killed during transient outage!"

    finally:
        with idle_mod._lock:
            for w in idle_mod._active_idle_workers.values():
                w.stop()
            idle_mod._active_idle_workers.clear()


def test_get_merged_accounts_throttles_failure_logging_and_logs_recovery(tmp_path, monkeypatch, caplog):
    import logging
    main_mod._clear_user_accounts_cache()
    monkeypatch.setattr(main_mod, "assert_public_user_account", lambda _: None)
    config = _mock_config(tmp_path)
    state = SyncState(config.state_path)

    gmail_account = AccountConfig(
        id="gmail-user",
        source="imap_gmail",
        host="imap.gmail.com",
        port=993,
        username="user@gmail.com",
        password="pw",
        use_ssl=True,
        user_managed=True,
    )

    # Prime cache with one account
    with patch("one_mail_agg.main.fetch_user_accounts", return_value=[gmail_account]):
        main_mod.get_merged_accounts(config, state)

    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="one-mail-agg"):
        # Consecutive failure 1 -> should log
        with patch("one_mail_agg.main.fetch_user_accounts", side_effect=requests.exceptions.ReadTimeout("outage")):
            main_mod.get_merged_accounts(config, state)
        assert main_mod._user_accounts_consecutive_errors == 1
        assert len([rec for rec in caplog.records if "fetch user mail_accounts failed" in rec.message]) == 1

        # Consecutive failure 2..9 -> should be suppressed
        for _ in range(2, 10):
            with patch("one_mail_agg.main.fetch_user_accounts", side_effect=requests.exceptions.ReadTimeout("outage")):
                main_mod.get_merged_accounts(config, state)
        assert main_mod._user_accounts_consecutive_errors == 9
        # Still only 1 warning record logged
        assert len([rec for rec in caplog.records if "fetch user mail_accounts failed" in rec.message]) == 1

        # Consecutive failure 10 -> should log on 10th failure
        with patch("one_mail_agg.main.fetch_user_accounts", side_effect=requests.exceptions.ReadTimeout("outage")):
            main_mod.get_merged_accounts(config, state)
        assert main_mod._user_accounts_consecutive_errors == 10
        assert len([rec for rec in caplog.records if "fetch user mail_accounts failed" in rec.message]) == 2

    # Recovery -> should log info and reset counter
    with caplog.at_level(logging.INFO, logger="one-mail-agg"):
        with patch("one_mail_agg.main.fetch_user_accounts", return_value=[gmail_account]):
            main_mod.get_merged_accounts(config, state)
        assert main_mod._user_accounts_consecutive_errors == 0
        assert any("recovered after 10 failure(s)" in rec.message for rec in caplog.records)

