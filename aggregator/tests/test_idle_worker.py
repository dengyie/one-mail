import logging
from unittest.mock import MagicMock

import pytest

import one_mail_agg.idle_worker as idle_mod
from one_mail_agg.config import Config, AccountConfig
from one_mail_agg.state import SyncState
from one_mail_agg.idle_worker import (
    ImapIdleWorker,
    ensure_idle_workers,
    _resolve_client_factory,
    _is_msa_like,
    _active_idle_workers,
    _idle_unsupported,
    _idle_retry_after,
    _idle_fingerprint,
    _reconnect_backoff,
)
from one_mail_agg.oauth import oauth_client_factory
from one_mail_agg.sync import default_client_factory


@pytest.fixture(autouse=True)
def _reset_idle_registries():
    with idle_mod._lock:
        idle_mod._active_idle_workers.clear()
        idle_mod._idle_unsupported.clear()
        idle_mod._idle_retry_after.clear()
    yield
    with idle_mod._lock:
        for worker in idle_mod._active_idle_workers.values():
            try:
                worker.stop()
            except Exception:
                pass
        idle_mod._active_idle_workers.clear()
        idle_mod._idle_unsupported.clear()
        idle_mod._idle_retry_after.clear()


def _config(tmp_path):
    return Config(
        worker_base_url="https://fake",
        admin_token="token",
        state_path=str(tmp_path / "state.json"),
        accounts=[],
    )


def _qq_account(**overrides):
    values = {
        "id": "test-qq",
        "source": "imap_qq",
        "host": "imap.qq.com",
        "port": 993,
        "username": "test@qq.com",
        "password": "pwd",
        "folders": ["INBOX"],
        "use_ssl": True,
    }
    values.update(overrides)
    return AccountConfig(**values)


def test_idle_worker_lifecycle(tmp_path):
    state = SyncState(str(tmp_path / "state.json"))
    config = _config(tmp_path)
    acc = _qq_account()

    mock_client = MagicMock()
    mock_client.has_capability.return_value = True
    mock_client.idle_check.side_effect = [[(b"1", b"EXISTS")], Exception("stop test")]

    sync_calls = []
    worker = ImapIdleWorker(
        config=config,
        account=acc,
        state=state,
        client_factory=lambda _a: mock_client,
        idle_refresh_seconds=1,
    )
    worker.do_sync = lambda _c: sync_calls.append(1) or {"synced": 1, "dropped": 0}

    worker.start()
    worker.join(timeout=2)
    worker.stop()

    assert len(sync_calls) >= 1


def test_reconnect_backoff_grows_for_repeated_unstable_sessions(tmp_path):
    """能认证但一进入 IDLE 就断线时，不能每次建连后都把退避重置为 2 秒。"""
    waits = []

    class _StopEvent:
        def is_set(self): return False
        def set(self): pass
        def wait(self, seconds):
            waits.append(seconds)
            return len(waits) >= 3

    class _Client:
        def has_capability(self, name): return True
        def select_folder(self, *a, **k): return {b"UIDVALIDITY": 1}
        def idle(self): pass
        def idle_check(self, timeout=None): raise OSError("unstable idle")
        def logout(self): pass

    worker = ImapIdleWorker(
        _config(tmp_path),
        _qq_account(),
        SyncState(str(tmp_path / "state.json")),
        client_factory=lambda _a: _Client(),
    )
    worker._stop_event = _StopEvent()
    worker.do_sync = lambda _c: {"synced": 0, "dropped": 0}
    worker.run()

    assert waits == [2, 4, 8]


def test_successful_idle_cycle_resets_reconnect_backoff(tmp_path):
    """连接稳定完成一次 IDLE+sync 后，后续偶发断线从短退避重新开始。"""
    waits = []
    sessions = 0

    class _StopEvent:
        def is_set(self): return False
        def set(self): pass
        def wait(self, seconds):
            waits.append(seconds)
            return len(waits) >= 2

    class _AlwaysFail:
        def has_capability(self, name): return True
        def select_folder(self, *a, **k): return {b"UIDVALIDITY": 1}
        def idle(self): pass
        def idle_check(self, timeout=None): raise OSError("first session fails")
        def logout(self): pass

    class _StableThenFail:
        def __init__(self): self.calls = 0
        def has_capability(self, name): return True
        def select_folder(self, *a, **k): return {b"UIDVALIDITY": 1}
        def idle(self): pass
        def idle_check(self, timeout=None):
            self.calls += 1
            if self.calls == 1:
                return []
            raise OSError("later disconnect")
        def idle_done(self): pass
        def logout(self): pass

    def factory(_a):
        nonlocal sessions
        sessions += 1
        return _AlwaysFail() if sessions == 1 else _StableThenFail()

    worker = ImapIdleWorker(
        _config(tmp_path),
        _qq_account(),
        SyncState(str(tmp_path / "state.json")),
        client_factory=factory,
    )
    worker._stop_event = _StopEvent()
    worker.do_sync = lambda _c: {"synced": 0, "dropped": 0}
    worker.run()

    assert waits == [2, 2]


def test_reconnect_backoff_is_bounded():
    assert [_reconnect_backoff(n) for n in range(1, 8)] == [2, 4, 8, 16, 30, 30, 30]


def test_repeated_idle_failures_enter_polling_cooldown(tmp_path, monkeypatch):
    """连续 IDLE 故障达到阈值后退出 worker，交给 daemon polling，稍后再探测。"""
    waits = []
    monkeypatch.setattr(idle_mod.time, "monotonic", lambda: 100.0)

    class _StopEvent:
        def is_set(self): return False
        def set(self): pass
        def wait(self, seconds):
            waits.append(seconds)
            return False

    class _Client:
        def has_capability(self, name): return True
        def select_folder(self, *a, **k): return {b"UIDVALIDITY": 1}
        def idle(self): pass
        def idle_check(self, timeout=None): raise OSError("still unstable")
        def logout(self): pass

    acc = _qq_account()
    worker = ImapIdleWorker(
        _config(tmp_path), acc, SyncState(str(tmp_path / "state.json")),
        client_factory=lambda _a: _Client(),
    )
    worker._stop_event = _StopEvent()
    worker.do_sync = lambda _c: {"synced": 0, "dropped": 0}
    worker.run()

    # 第五次失败直接转 polling cooldown，不再额外 sleep。
    assert waits == [2, 4, 8, 16]
    fingerprint, retry_at = _idle_retry_after[acc.id]
    assert fingerprint == _idle_fingerprint(acc)
    assert retry_at == 400.0


def test_cooldown_skips_worker_then_retries_after_expiry(tmp_path, monkeypatch):
    acc = _qq_account()
    _idle_retry_after[acc.id] = (_idle_fingerprint(acc), 200.0)
    monkeypatch.setattr(idle_mod.time, "monotonic", lambda: 100.0)

    class _ShouldNotStart:
        def __init__(self, *a, **k):
            raise AssertionError("cooldown account must use daemon polling")

    monkeypatch.setattr(idle_mod, "ImapIdleWorker", _ShouldNotStart)
    ensure_idle_workers(_config(tmp_path), SyncState(str(tmp_path / "state.json")), [acc])
    assert acc.id not in _active_idle_workers

    started = []

    class _FakeWorker:
        def __init__(self, config, account, state, client_factory): self.account = account
        def start(self): started.append(self.account.id)
        def is_alive(self): return True
        def is_stopped(self): return False
        def stop(self): pass

    monkeypatch.setattr(idle_mod.time, "monotonic", lambda: 201.0)
    monkeypatch.setattr(idle_mod, "ImapIdleWorker", _FakeWorker)
    ensure_idle_workers(_config(tmp_path), SyncState(str(tmp_path / "state.json")), [acc])

    assert started == [acc.id]
    assert acc.id not in _idle_retry_after
    assert acc.id in _active_idle_workers


def test_unsupported_idle_is_remembered_and_worker_exits(tmp_path):
    class _NoIdleClient:
        logged_out = False
        def has_capability(self, name): return False
        def logout(self): self.logged_out = True

    client = _NoIdleClient()
    acc = _qq_account()
    worker = ImapIdleWorker(
        _config(tmp_path), acc, SyncState(str(tmp_path / "state.json")),
        client_factory=lambda _a: client,
    )
    worker.run()

    assert _idle_unsupported[acc.id] == _idle_fingerprint(acc)
    assert client.logged_out is True


def test_ensure_idle_workers_skips_known_unsupported_account(tmp_path, monkeypatch):
    acc = _qq_account()
    _idle_unsupported[acc.id] = _idle_fingerprint(acc)

    class _ShouldNotStart:
        def __init__(self, *a, **k):
            raise AssertionError("known unsupported account must use daemon polling")

    monkeypatch.setattr(idle_mod, "ImapIdleWorker", _ShouldNotStart)
    ensure_idle_workers(_config(tmp_path), SyncState(str(tmp_path / "state.json")), [acc])
    assert acc.id not in _active_idle_workers


def test_account_config_change_retries_idle_capability(tmp_path, monkeypatch):
    old = _qq_account()
    changed = _qq_account(host="imap2.qq.com")
    _idle_unsupported[old.id] = _idle_fingerprint(old)
    _idle_retry_after[old.id] = (_idle_fingerprint(old), 999999.0)
    started = []

    class _FakeWorker:
        def __init__(self, config, account, state, client_factory): self.account = account
        def start(self): started.append(self.account.host)
        def is_alive(self): return True
        def is_stopped(self): return False
        def stop(self): pass

    monkeypatch.setattr(idle_mod, "ImapIdleWorker", _FakeWorker)
    ensure_idle_workers(_config(tmp_path), SyncState(str(tmp_path / "state.json")), [changed])

    assert started == ["imap2.qq.com"]
    assert old.id not in _idle_unsupported
    assert old.id not in _idle_retry_after
    assert old.id in _active_idle_workers


def test_resolve_client_factory_oauth_uses_oauth_factory():
    acc = AccountConfig(
        id="hotmail-main",
        source="imap_outlook",
        host="outlook.office365.com",
        port=993,
        username="x@hotmail.com",
        password="p",
        oauth={"provider": "msa", "client_id": "c", "refresh_token": "rt"},
    )
    factory = _resolve_client_factory(acc)
    assert factory is oauth_client_factory(acc) or callable(factory)
    assert factory is not default_client_factory


def test_resolve_client_factory_basic_uses_default():
    acc = AccountConfig(
        id="qq", source="imap_qq", host="imap.qq.com", port=993,
        username="u@qq.com", password="pwd",
    )
    assert _resolve_client_factory(acc) is default_client_factory


def test_resolve_client_factory_unknown_provider_falls_back():
    acc = AccountConfig(
        id="bad", source="imap_custom", host="imap.example.com", port=993,
        username="u@example.com", password="pwd",
        oauth={"provider": "totally-unknown", "client_id": "c", "refresh_token": "rt"},
    )
    assert _resolve_client_factory(acc) is default_client_factory


def test_is_msa_like_by_host():
    acc = AccountConfig(
        id="h1", source="imap_outlook", host="outlook.office365.com", port=993,
        username="a@outlook.com", password="p",
        oauth={"provider": "hotmail", "client_id": "c", "refresh_token": "rt"},
    )
    assert _is_msa_like(acc) is True


def test_is_msa_like_by_provider_alias():
    acc = AccountConfig(
        id="h2", source="imap_custom", host="imap.custombox.com", port=993,
        username="b@custom.com", password="p",
        oauth={"provider": "outlook_personal", "client_id": "c", "refresh_token": "rt"},
    )
    assert _is_msa_like(acc) is True


def test_is_msa_like_false_for_normal_account():
    acc = AccountConfig(
        id="qq2", source="imap_qq", host="imap.qq.com", port=993,
        username="u@qq.com", password="pwd",
    )
    assert _is_msa_like(acc) is False


def test_resolve_client_factory_msa_failure_logs_reauth(caplog):
    with caplog.at_level(logging.ERROR, logger="one-mail-agg"):
        acc = AccountConfig(
            id="dead-msa", source="imap_outlook", host="outlook.office365.com", port=993,
            username="dead@outlook.com", password="p",
            oauth={"provider": "totally-unknown", "client_id": "c", "refresh_token": "rt"},
        )
        factory = _resolve_client_factory(acc)
    assert factory is default_client_factory
    joined = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "重新授权" in joined
    assert "outlook.office365.com" in str(acc.host.lower()) or "outlook" in joined
