import one_mail_agg.idle_worker as idle_mod
from one_mail_agg.config import AccountConfig, Config
from one_mail_agg.idle_worker import ImapIdleWorker
from one_mail_agg.state import SyncState


def _config(tmp_path):
    return Config(
        worker_base_url="https://worker.example",
        admin_token="secret",
        accounts=[],
        state_path=str(tmp_path / "state.json"),
    )


def _account(*, user_managed=True):
    return AccountConfig(
        id="user-1",
        source="imap_custom",
        host="imap.example.com",
        port=993,
        username="u@example.com",
        password="pw",
        folders=["INBOX"],
        protocol="imap",
        user_managed=user_managed,
    )


def test_idle_success_clears_fail_state_and_reports_success(tmp_path, monkeypatch):
    state = SyncState(str(tmp_path / "state.json"))
    state.record_failure("user-1", max_fail=1, backoff_sec=900, now=100)
    account = _account()
    reports = []

    monkeypatch.setattr(
        idle_mod,
        "sync_imap",
        lambda client, config, acc, sync_state: {"synced": 2, "dropped": 0, "protocol": "imap"},
    )
    monkeypatch.setattr(
        idle_mod,
        "report_sync_status",
        lambda base, token, account_id, error: reports.append((base, token, account_id, error)),
    )

    worker = ImapIdleWorker(_config(tmp_path), account, state, client_factory=lambda _a: object())
    result = worker.do_sync(object())

    assert result["synced"] == 2
    assert state.get_fail_state("user-1") == (0, 0.0)
    assert reports == [("https://worker.example", "secret", "user-1", None)]


def test_idle_status_reporting_failure_never_breaks_successful_sync(tmp_path, monkeypatch):
    state = SyncState(str(tmp_path / "state.json"))
    account = _account()

    monkeypatch.setattr(
        idle_mod,
        "sync_imap",
        lambda client, config, acc, sync_state: {"synced": 1, "dropped": 0, "protocol": "imap"},
    )

    def broken_status(*args, **kwargs):
        raise OSError("worker status endpoint down")

    monkeypatch.setattr(idle_mod, "report_sync_status", broken_status)

    worker = ImapIdleWorker(_config(tmp_path), account, state, client_factory=lambda _a: object())
    result = worker.do_sync(object())

    assert result == {"synced": 1, "dropped": 0, "protocol": "imap"}


def test_idle_error_status_reports_user_managed_accounts_only(tmp_path, monkeypatch):
    reports = []
    monkeypatch.setattr(
        idle_mod,
        "report_sync_status",
        lambda base, token, account_id, error: reports.append((account_id, error)),
    )

    user_worker = ImapIdleWorker(
        _config(tmp_path),
        _account(user_managed=True),
        SyncState(str(tmp_path / "user-state.json")),
        client_factory=lambda _a: object(),
    )
    user_worker._report_status(RuntimeError("idle broke"))

    admin_account = _account(user_managed=False)
    admin_account.id = "admin-1"
    admin_worker = ImapIdleWorker(
        _config(tmp_path),
        admin_account,
        SyncState(str(tmp_path / "admin-state.json")),
        client_factory=lambda _a: object(),
    )
    admin_worker._report_status(RuntimeError("ignored"))

    assert reports == [("user-1", "idle broke")]
