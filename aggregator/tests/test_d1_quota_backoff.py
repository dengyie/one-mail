from datetime import datetime, timezone
from dataclasses import replace
import json
from unittest.mock import Mock

import pytest
import requests

from one_mail_agg.config import AccountConfig, Config
from one_mail_agg.d1_quota import DatabaseQuotaExceeded, database_quota_error
from one_mail_agg.state import SyncState
from one_mail_agg import folder_catalog, idle_worker, main, remote_accounts

NOW = datetime(2026, 10, 8, 12, tzinfo=timezone.utc).timestamp()
RESET = datetime(2026, 10, 9, tzinfo=timezone.utc).timestamp()


@pytest.fixture
def context(tmp_path, monkeypatch):
    monkeypatch.setattr("time.time", lambda: NOW)
    account = AccountConfig("account-1", "imap_custom", "imap.example.test", 993,
                            "user@example.test", "test-only", protocol="imap", user_managed=True)
    config = Config("https://worker.example.test", "test-only", [account], state_path=str(tmp_path / "state.json"))
    state = SyncState(config.state_path)
    state.set_last_uid("account-1", "INBOX", 41)
    monkeypatch.setattr(idle_worker, "_active_idle_workers", {})
    monkeypatch.setattr(idle_worker, "_idle_unsupported", {})
    monkeypatch.setattr(idle_worker, "_idle_retry_after", {})
    monkeypatch.setattr(main, "_ACCOUNT_LAST_POLL", {})
    return config, account, state


def exhausted(*args, **kwargs):
    raise DatabaseQuotaExceeded("D1_DAILY_WRITE_LIMIT", RESET)


def quota_response(body=None, status=503):
    response = requests.Response()
    response.status_code = status
    response._content = json.dumps(body if body is not None else {
        "code": "D1_DAILY_WRITE_LIMIT", "retry_at": "2026-10-09T00:00:00.000Z",
    }).encode()
    return response


@pytest.mark.parametrize("code", ["D1_DAILY_READ_LIMIT", "D1_DAILY_WRITE_LIMIT"])
def test_quota_response_preserves_reset_and_http_cause(code):
    response = quota_response({"code": code, "retry_at": "2026-10-09T00:00:00.000Z"})
    error = database_quota_error(response, NOW)
    assert error.code == code
    assert error.retry_at == RESET
    assert isinstance(error.__cause__, requests.HTTPError)
    assert error.__cause__.response is response


@pytest.mark.parametrize("body", [
    [], {}, {"code": []}, {"code": "OTHER"},
    {"code": "D1_DAILY_WRITE_LIMIT", "retry_at": 123},
    {"code": "D1_DAILY_WRITE_LIMIT", "retry_at": "invalid"},
    {"code": "D1_DAILY_WRITE_LIMIT", "retry_at": "2026-10-09T00:00:00"},
    {"code": "D1_DAILY_WRITE_LIMIT", "retry_at": "2026-10-09T00:00:00+08:00"},
    {"code": "D1_DAILY_WRITE_LIMIT", "retry_at": "2026-10-10T00:00:00Z"},
])
def test_untrusted_quota_shape_retains_ordinary_http_error_handling(body):
    assert database_quota_error(quota_response(body), NOW) is None


def test_non_quota_status_and_non_json_are_not_quota_errors():
    assert database_quota_error(quota_response(status=500), NOW) is None
    response = quota_response()
    response._content = b"upstream temporarily unavailable"
    assert database_quota_error(response, NOW) is None


def test_quota_response_arriving_across_midnight_allows_the_next_attempt():
    assert database_quota_error(quota_response(), RESET + 0.1).retry_at == RESET + 1.1


def test_status_write_quota_also_persists_the_account_pause(context, monkeypatch):
    config, account, state = context
    monkeypatch.setattr(remote_accounts.requests, "post", Mock(return_value=quota_response()))
    remote_accounts.report_sync_status(config.worker_base_url, config.admin_token, account.id, None, state=state)
    assert SyncState(config.state_path).get_fail_state(account.id)[1] == RESET


def test_empty_idle_sync_status_quota_exits_before_starting_idle(context, monkeypatch):
    config, account, state = context
    client = Mock()
    client.has_capability.return_value = True
    factory = Mock(return_value=client)
    monkeypatch.setattr(idle_worker, "sync_imap", Mock(return_value={"synced": 0, "dropped": 0}))
    monkeypatch.setattr(remote_accounts.requests, "post", Mock(return_value=quota_response()))
    monkeypatch.setattr(idle_worker, "_enable_socket_keepalive", lambda _: None)
    worker = idle_worker.ImapIdleWorker(config, account, state, client_factory=factory)

    worker.run()

    assert state.get_fail_state(account.id)[1] == RESET
    factory.assert_called_once()
    client.logout.assert_called_once()
    client.idle.assert_not_called()


def test_run_once_graph_quota_does_not_abort_healthy_accounts(context, monkeypatch):
    config, account, state = context
    graph = replace(account, id="graph-1", source="graph_outlook")
    monkeypatch.setattr(main, "load_config", lambda _: config)
    monkeypatch.setattr(main, "get_merged_accounts", lambda *_: ([graph, account], {graph.id, account.id}))
    monkeypatch.setattr(main, "sync_graph", exhausted)
    monkeypatch.setattr(main, "sync_account", Mock(return_value={"synced": 1, "dropped": 0}))
    monkeypatch.setattr(main.time, "sleep", lambda _: None)
    status = Mock()
    monkeypatch.setattr(main, "report_sync_status", status)

    result = main.run_once("test-only")

    assert "D1_DAILY_WRITE_LIMIT" in result[graph.id]["error"]
    assert result[account.id]["synced"] == 1
    assert SyncState(config.state_path).get_fail_state(graph.id)[1] == RESET
    assert not state.should_skip_account(account.id, NOW)
    assert status.call_count == 1
    assert status.call_args.args[2] == account.id


def test_idle_quota_failure_is_persisted_without_reconnect_or_watermark_progress(context, monkeypatch):
    config, account, state = context
    client = Mock()
    client.has_capability.return_value = True
    client.idle_check.return_value = []
    client_factory = Mock(return_value=client)
    worker = idle_worker.ImapIdleWorker(config, account, state, client_factory=client_factory)
    sync = Mock(side_effect=exhausted)
    monkeypatch.setattr(worker, "do_sync", sync)
    status = Mock()
    monkeypatch.setattr(idle_worker, "report_sync_status", status)
    wait = Mock(return_value=True)
    monkeypatch.setattr(worker._stop_event, "wait", wait)
    monkeypatch.setattr(idle_worker, "_enable_socket_keepalive", lambda _: None)

    worker.run()

    assert state.should_skip_account(account.id, NOW)
    assert state.get_fail_state(account.id)[1] == RESET
    assert SyncState(config.state_path).should_skip_account(account.id, RESET - 1)
    assert not state.should_skip_account(account.id, RESET)
    assert state.get_last_uid(account.id, "INBOX") == 41
    assert sync.call_count == 1
    assert client_factory.call_count == 1
    assert client.logout.call_count == 1
    wait.assert_not_called()
    status.assert_not_called()


def test_idle_scheduler_respects_persisted_backoff_and_resumes_at_utc_reset(context, monkeypatch):
    config, account, state = context
    state.record_rate_limit_backoff(account.id, backoff_sec=int(RESET - NOW), now=NOW)
    worker = Mock()
    worker_factory = Mock(return_value=worker)
    monkeypatch.setattr(idle_worker, "ImapIdleWorker", worker_factory)
    monkeypatch.setattr(idle_worker, "_resolve_client_factory", lambda *_: Mock())

    idle_worker.ensure_idle_workers(config, state, [account])
    worker_factory.assert_not_called()
    monkeypatch.setattr("time.time", lambda: RESET)
    idle_worker.ensure_idle_workers(config, state, [account])
    assert worker_factory.call_count == 1
    worker.start.assert_called_once()


def test_poll_quota_pause_survives_restart_and_prevents_next_provider_attempt(context, monkeypatch):
    config, account, state = context
    monkeypatch.setattr(main, "get_merged_accounts", lambda *_: ([account], {account.id}))
    monkeypatch.setattr(main, "ensure_idle_workers", lambda *_: None)
    monkeypatch.setattr(main, "get_account_poll_interval", lambda *_: 1)
    sync = Mock(side_effect=exhausted)
    status = Mock()
    monkeypatch.setattr(main, "sync_account", sync)
    monkeypatch.setattr(main, "report_sync_status", status)

    main._poll_pass(config, state, now=100)
    main._poll_pass(config, SyncState(config.state_path), now=102)

    assert state.get_fail_state(account.id)[1] == RESET
    assert state.get_last_uid(account.id, "INBOX") == 41
    assert sync.call_count == 1
    status.assert_not_called()


@pytest.mark.parametrize("provider", ["imap", "graph"])
def test_catalog_quota_failure_is_not_swallowed_as_an_empty_success(context, monkeypatch, provider):
    config, account, _ = context
    monkeypatch.setattr(folder_catalog, "upload_folders", exhausted)
    row = {"account_id": account.id, "canonical_name": "INBOX"}
    if provider == "imap":
        monkeypatch.setattr(folder_catalog, "discover_imap_folders", lambda *_: [row])
        with pytest.raises(DatabaseQuotaExceeded):
            folder_catalog.maybe_sync_imap_folder_catalog(Mock(), config, account, force=True, now=0)
    else:
        with pytest.raises(DatabaseQuotaExceeded):
            folder_catalog.maybe_sync_graph_folder_catalog("test-only", config, account, discovered_rows=[row], force=True, now=0)
