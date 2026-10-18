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
        idle_mod._active_idle_folders.clear()
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
        idle_mod._active_idle_folders.clear()


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
    assert retry_at == 100.0 + idle_mod._IDLE_RETRY_COOLDOWN_SECONDS


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
        enable_noop_fallback=False,
    )
    worker.run()

    assert _idle_unsupported[acc.id] == _idle_fingerprint(acc)
    assert client.logged_out is True


def test_noop_fallback_mode_runs_noop_and_syncs(tmp_path, monkeypatch):
    class _NoIdleClient:
        def __init__(self):
            self.noops = 0
            self.folders_selected = []
            self.logged_out = False

        def has_capability(self, name):
            return False

        def select_folder(self, folder, readonly=True):
            self.folders_selected.append(folder)

        def noop(self):
            self.noops += 1

        def logout(self):
            self.logged_out = True

    client = _NoIdleClient()
    acc = _qq_account()
    syncs = []

    worker = ImapIdleWorker(
        _config(tmp_path), acc, SyncState(str(tmp_path / "state.json")),
        client_factory=lambda _a: client,
        enable_noop_fallback=True,
        noop_poll_interval_seconds=0.01,
    )

    def fake_do_sync(cl):
        syncs.append(len(syncs))
        if len(syncs) >= 2:
            worker.stop()
        return {"synced": 1, "dropped": 0}

    worker.do_sync = fake_do_sync
    worker.run()

    assert client.noops >= 1
    assert "INBOX" in client.folders_selected
    assert len(syncs) >= 2
    assert acc.id not in _idle_unsupported


def test_noop_fallback_mode_handles_connection_loss_and_reconnects(tmp_path, monkeypatch):
    clients = []

    class _BrokenNoIdleClient:
        def __init__(self, fail_noop: bool):
            self.fail_noop = fail_noop
            self.logged_out = False
            self.noops = 0

        def has_capability(self, name):
            return False

        def select_folder(self, folder, readonly=True):
            pass

        def noop(self):
            if self.fail_noop:
                raise ConnectionResetError("connection reset by peer")
            self.noops += 1

        def logout(self):
            self.logged_out = True

    def factory(_acc):
        c = _BrokenNoIdleClient(fail_noop=(len(clients) == 0))
        clients.append(c)
        return c

    acc = _qq_account()
    worker = ImapIdleWorker(
        _config(tmp_path), acc, SyncState(str(tmp_path / "state.json")),
        client_factory=factory,
        enable_noop_fallback=True,
        noop_poll_interval_seconds=0.01,
    )
    monkeypatch.setattr(idle_mod, "_reconnect_backoff", lambda _errs: 0.01)

    sync_calls = []
    def fake_do_sync(cl):
        sync_calls.append(len(sync_calls))
        if len(clients) >= 2 and len(sync_calls) >= 3:
            worker.stop()
        return {"synced": 0, "dropped": 0}

    worker.do_sync = fake_do_sync
    worker.run()

    assert len(clients) >= 2
    assert clients[0].logged_out is True
    assert clients[1].noops >= 1


def test_noop_poll_interval_honors_account_config(tmp_path):
    acc = _qq_account(poll_interval=25)
    worker = ImapIdleWorker(
        _config(tmp_path), acc, SyncState(str(tmp_path / "state.json")),
        enable_noop_fallback=True,
    )
    assert worker.noop_poll_interval_seconds == 25

    # Out of 10~60 range reverts to safe default 30
    acc_invalid = _qq_account(poll_interval=5)
    worker2 = ImapIdleWorker(
        _config(tmp_path), acc_invalid, SyncState(str(tmp_path / "state.json")),
        enable_noop_fallback=True,
    )
    assert worker2.noop_poll_interval_seconds == 30


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


def test_enable_socket_keepalive():
    import socket
    # 1. sock 为 None 时优雅返回不报错
    idle_mod._enable_socket_keepalive(MagicMock(_imap=None))

    # 2. 正常 socket 挂载 keepalive 选项
    mock_sock = MagicMock()
    mock_client = MagicMock()
    mock_client._imap.sock = mock_sock
    idle_mod._enable_socket_keepalive(mock_client)
    mock_sock.setsockopt.assert_any_call(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)

    # 3. setsockopt 抛异常时静默捕获不影响上层连接
    bomb_sock = MagicMock()
    bomb_sock.setsockopt.side_effect = OSError("setsockopt unsupported")
    bomb_client = MagicMock()
    bomb_client._imap.sock = bomb_sock
    idle_mod._enable_socket_keepalive(bomb_client)


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


def test_ensure_idle_workers_recovers_pinned_gmail_account(tmp_path, monkeypatch):
    """历史被误 pin 到 POP3 的 Gmail 账号在 ensure_idle_workers 中自动解开 pin 并拉起 IDLE。"""
    acc = AccountConfig(
        id="gmail-1", source="imap_gmail", host="imap.gmail.com", port=993,
        username="u@gmail.com", password="pwd", protocol="auto"
    )
    state = SyncState(str(tmp_path / "state.json"))
    state.set_fallback_pinned(acc.id, True)

    started = []
    class _FakeWorker:
        def __init__(self, config, account, state, client_factory): self.account = account
        def start(self): started.append(self.account.id)
        def is_alive(self): return True
        def is_stopped(self): return False
        def stop(self): pass

    monkeypatch.setattr(idle_mod, "ImapIdleWorker", _FakeWorker)
    ensure_idle_workers(_config(tmp_path), state, [acc])

    assert not state.is_fallback_pinned(acc.id)
    assert started == [acc.id]
    assert acc.id in _active_idle_workers


def test_ensure_idle_workers_recovers_pinned_qq_and_overseas_accounts(tmp_path, monkeypatch):
    """历史误 pin 的 QQ 与海外邮箱（如 Yahoo）在 ensure_idle_workers 中自动解开 pin 并启动 IDLE。"""
    qq_acc = AccountConfig(
        id="qq-1", source="imap_qq", host="imap.qq.com", port=993,
        username="u@qq.com", password="pwd", protocol="auto"
    )
    yahoo_acc = AccountConfig(
        id="yahoo-1", source="imap_custom", host="imap.mail.yahoo.com", port=993,
        username="u@yahoo.com", password="pwd", protocol="auto"
    )
    state = SyncState(str(tmp_path / "state.json"))
    state.set_fallback_pinned(qq_acc.id, True)
    state.set_fallback_pinned(yahoo_acc.id, True)

    started = []
    class _FakeWorker:
        def __init__(self, config, account, state, client_factory): self.account = account
        def start(self): started.append(self.account.id)
        def is_alive(self): return True
        def is_stopped(self): return False
        def stop(self): pass

    monkeypatch.setattr(idle_mod, "ImapIdleWorker", _FakeWorker)
    ensure_idle_workers(_config(tmp_path), state, [qq_acc, yahoo_acc])

    assert not state.is_fallback_pinned(qq_acc.id)
    assert not state.is_fallback_pinned(yahoo_acc.id)
    assert set(started) == {qq_acc.id, yahoo_acc.id}



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


def test_folders_change_restarts_idle_worker(tmp_path, monkeypatch):
    """新增目录（如垃圾邮件箱）后必须重建 IDLE worker：线程冻结了启动时的 account 快照，
    不重建就只会一直同步旧目录。"""
    started, stopped = [], []

    class _FakeWorker:
        def __init__(self, config, account, state, client_factory): self.account = account
        def start(self): started.append(self.account.id)
        def is_alive(self): return True
        def is_stopped(self): return False
        def stop(self): stopped.append(self.account.id)

    monkeypatch.setattr(idle_mod, "ImapIdleWorker", _FakeWorker)
    config = _config(tmp_path)
    state = SyncState(str(tmp_path / "state.json"))

    ensure_idle_workers(config, state, [_qq_account(folders=["INBOX"])])
    first = _active_idle_workers["test-qq"]
    assert started == ["test-qq"]

    # 目录未变：复用同一个 worker，不重建
    ensure_idle_workers(config, state, [_qq_account(folders=["INBOX"])])
    assert started == ["test-qq"]
    assert _active_idle_workers["test-qq"] is first

    # 新增垃圾邮件箱：停掉旧 worker 并用新目录重建
    ensure_idle_workers(config, state, [_qq_account(folders=["INBOX", "Junk"])])
    assert started == ["test-qq", "test-qq"]
    assert stopped == ["test-qq"]
    assert _active_idle_workers["test-qq"] is not first


def test_do_sync_reports_partial_folder_failure_as_status_warning(tmp_path, monkeypatch):
    """垃圾邮件箱本轮跑挂时不能静默：do_sync 仍算成功（不回退退避），但必须把警告
    回写账号状态，否则 UI 上账号一直显示「正常同步」而垃圾邮件其实没进来。"""
    config = _config(tmp_path)
    state = SyncState(str(tmp_path / "state.json"))
    acc = _qq_account(user_managed=True)

    monkeypatch.setattr(idle_mod, "sync_imap", lambda client, cfg, a, st: {
        "synced": 3, "dropped": 0, "protocol": "imap", "failed_folders": ["Junk"],
    })
    reports = []
    monkeypatch.setattr(idle_mod, "report_sync_status",
                        lambda url, token, aid, error, state=None: reports.append((aid, error)))

    worker = ImapIdleWorker(config=config, account=acc, state=state,
                            client_factory=lambda _a: MagicMock())
    result = worker.do_sync(MagicMock())

    assert result["synced"] == 3
    assert reports == [("test-qq", "folder sync failed this round: Junk")]


def test_do_sync_reports_clean_status_when_all_folders_sync(tmp_path, monkeypatch):
    config = _config(tmp_path)
    state = SyncState(str(tmp_path / "state.json"))
    acc = _qq_account(user_managed=True)

    monkeypatch.setattr(idle_mod, "sync_imap", lambda client, cfg, a, st: {
        "synced": 1, "dropped": 0, "protocol": "imap",
    })
    reports = []
    monkeypatch.setattr(idle_mod, "report_sync_status",
                        lambda url, token, aid, error, state=None: reports.append((aid, error)))

    worker = ImapIdleWorker(config=config, account=acc, state=state,
                            client_factory=lambda _a: MagicMock())
    worker.do_sync(MagicMock())

    assert reports == [("test-qq", None)]


def test_idle_session_recycling_smoothly_reconnects(tmp_path):
    """当连接达到最大周期或最长寿命时，主动平滑重建连接（client.logout -> 重连），
    防止上游（如腾讯 QQ 邮箱）在长连接老化后静默注销推信广播。"""
    config = _config(tmp_path)
    state = SyncState(str(tmp_path / "state.json"))
    acc = _qq_account()

    created_clients = []

    class _MockClient:
        def __init__(self, idx):
            self.idx = idx
            self.logged_out = False
        def has_capability(self, cap):
            return True
        def select_folder(self, folder, readonly=True):
            return {b"UIDVALIDITY": 1}
        def idle(self):
            pass
        def idle_check(self, timeout=None):
            return []  # timeout tick
        def idle_done(self):
            pass
        def logout(self):
            self.logged_out = True

    def factory(_acc):
        c = _MockClient(len(created_clients))
        created_clients.append(c)
        return c

    worker = ImapIdleWorker(
        config=config,
        account=acc,
        state=state,
        client_factory=factory,
        idle_refresh_seconds=1,
        max_session_cycles=2,  # 2 次循环后必须置换
    )
    worker.do_sync = lambda _c, **k: {"synced": 0, "dropped": 0}

    # 模拟运行到第 3 个循环后停止
    cycle_counter = 0
    orig_do_sync = worker.do_sync
    def count_sync(_c, **k):
        nonlocal cycle_counter
        cycle_counter += 1
        if cycle_counter >= 4:
            worker.stop()
        return orig_do_sync(_c, **k)
    worker.do_sync = count_sync

    worker.start()
    worker.join(timeout=3)
    worker.stop()

    # 验证至少创建了 2 个独立的 client 连接，且第 1 个 client 已经平滑 logout
    assert len(created_clients) >= 2
    assert created_clients[0].logged_out is True


def test_netease_163_safe_noop_polling_interval(tmp_path):
    """网易 163/126 邮箱由于严格的频控与流量保护，NOOP 轮询周期必须保持在安全下限（>= 300s），
    杜绝短频轮询消耗流量导致被封。"""
    config = _config(tmp_path)
    state = SyncState(str(tmp_path / "state.json"))

    acc_163 = AccountConfig(
        id="test-163",
        source="imap_163",
        host="imap.163.com",
        port=993,
        username="test@163.com",
        password="pwd",
        folders=["INBOX"],
        use_ssl=True,
    )

    worker = ImapIdleWorker(
        config=config,
        account=acc_163,
        state=state,
        noop_poll_interval_seconds=30,  # 即使传入 30s
    )
    assert worker.noop_poll_interval_seconds >= 300


def test_secondary_folder_sync_cadence_during_idle_timeouts(tmp_path):
    """在 IDLE 维持心跳超时时，主收件箱每个周期检查，次要目录（如 Junk）每隔若干周期检查一次；
    收到真实事件时立即同步全部目录。"""
    config = _config(tmp_path)
    state = SyncState(str(tmp_path / "state.json"))
    acc = _qq_account(folders=["INBOX", "Junk"])

    sync_history = []

    class _MockClient:
        def __init__(self):
            self.tick = 0
        def has_capability(self, cap):
            return True
        def select_folder(self, folder, readonly=True):
            return {b"UIDVALIDITY": 1}
        def idle(self):
            pass
        def idle_check(self, timeout=None):
            self.tick += 1
            if self.tick == 2:
                return [(b"1", b"EXISTS")]  # 第 2 次触发真实事件
            return []  # 其他次为超时
        def idle_done(self):
            pass
        def logout(self):
            pass

    worker = ImapIdleWorker(
        config=config,
        account=acc,
        state=state,
        client_factory=lambda _a: _MockClient(),
        idle_refresh_seconds=1,
    )

    def mock_sync(_c, folders=None):
        sync_history.append(list(folders) if folders is not None else list(acc.folders))
        if len(sync_history) >= 5:
            worker.stop()
        return {"synced": 0, "dropped": 0}

    worker.do_sync = mock_sync

    worker.start()
    worker.join(timeout=3)
    worker.stop()

    # 期望序列：
    # 0: initial sync (folders=["INBOX", "Junk"])
    # 1: cycle 0 timeout (cycles_since_connect=0 % 3 == 0) -> ["INBOX", "Junk"]
    # 2: cycle 1 has_event=True -> ["INBOX", "Junk"]
    # 3: cycle 2 timeout (cycles_since_connect=2 % 3 != 0) -> ["INBOX"]
    # 4: cycle 3 timeout (cycles_since_connect=3 % 3 == 0) -> ["INBOX", "Junk"]
    assert sync_history[0] == ["INBOX", "Junk"]
    assert sync_history[1] == ["INBOX", "Junk"]
    assert sync_history[2] == ["INBOX", "Junk"]
    assert sync_history[3] == ["INBOX"]
    assert sync_history[4] == ["INBOX", "Junk"]

