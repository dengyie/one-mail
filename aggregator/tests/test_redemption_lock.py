"""并发兑换互斥 + daemon tick 交替的回归测试。

背景（2026-09-11 烧卡事故的并发版本）：MSA/Gmail 的 refresh_token 每次兑换都
轮换，响应携带的新 RT 替换旧的、旧 RT 随即失效。IDLE 监听线程与主循环轮询、
以及 mutation 回写都在同一个进程里，若为同一账号并发兑换，两份响应各自带回
互相冲突的 RT，先落盘的那份会被另一份覆盖 —— 账号即刻失联。

本组锁定两件事：
1. `token_store.redemption_lock()` 让「回读 config 最新 RT → 兑换 → 建连」整段
   串行化，且兑换前必须回读 config.json（调用方手里的 Config 快照可能已被 IDLE
   线程的轮换甩在后面）；
2. `main.run_daemon` 单进程 tick 循环：到点跑一轮完整增量拉取，其余 tick 排空
   mutation 队列，绝不并发。
"""
import json
import threading
import time as real_time
from types import SimpleNamespace

import pytest
import responses

import one_mail_agg.graph_source as graph_mod
import one_mail_agg.main as main_mod
import one_mail_agg.oauth as oauth_mod
import one_mail_agg.token_store as token_store
from one_mail_agg.config import AccountConfig, Config
from one_mail_agg.token_store import redemption_lock, refresh_rt_from_config


# ---------------------------------------------------------------------------
# 1. redemption_lock 语义
# ---------------------------------------------------------------------------

def test_redemption_lock_is_mutually_exclusive():
    active = 0
    max_active = 0
    counter_lock = threading.Lock()
    start = threading.Barrier(4)

    def critical():
        nonlocal active, max_active
        start.wait()
        with redemption_lock():
            with counter_lock:
                active += 1
                max_active = max(max_active, active)
            real_time.sleep(0.05)
            with counter_lock:
                active -= 1

    threads = [threading.Thread(target=critical) for _ in range(3)]
    for t in threads:
        t.start()
    start.wait()
    for t in threads:
        t.join()

    assert max_active == 1


def test_redemption_lock_is_reentrant():
    """RLock：oauth factory 内层再取锁（例如嵌套调用）不能自锁死。"""
    with redemption_lock():
        with redemption_lock():
            assert True


# ---------------------------------------------------------------------------
# 2. refresh_rt_from_config 回读
# ---------------------------------------------------------------------------

def _config_file(tmp_path, refresh_token="FRESH", account_id="acc-1", user_managed=False):
    p = tmp_path / "config.json"
    p.write_text(json.dumps({
        "worker_base_url": "https://w",
        "admin_token": "t",
        "accounts": [{
            "id": account_id, "source": "imap_outlook", "host": "outlook.office365.com",
            "port": 993, "username": "x@hotmail.com", "password": "",
            "oauth": {"provider": "msa", "client_id": "c", "refresh_token": refresh_token},
        }],
    }), encoding="utf-8")
    return p


def _msa_account(refresh_token="STALE", account_id="acc-1", user_managed=False):
    return AccountConfig(id=account_id, source="imap_outlook", host="outlook.office365.com",
                         port=993, username="x@hotmail.com", password="",
                         oauth={"provider": "msa", "client_id": "c",
                                "refresh_token": refresh_token},
                         user_managed=user_managed)


def test_refresh_rt_from_config_picks_up_latest(tmp_path):
    """IDLE 线程已把 config.json 的 RT 轮换到 FRESH，轮询线程手里的 STALE 必须被替换。"""
    path = _config_file(tmp_path, refresh_token="FRESH")
    acc = _msa_account(refresh_token="STALE")
    config = Config(worker_base_url="https://w", admin_token="t", accounts=[acc],
                    config_path=str(path))

    refresh_rt_from_config(config, acc)

    assert acc.oauth["refresh_token"] == "FRESH"


def test_refresh_rt_from_config_skips_user_managed_and_missing_path(tmp_path):
    """用户账号 RT 存 Worker/D1（每轮已最新）；无 config_path 时不得抛错。"""
    path = _config_file(tmp_path, refresh_token="FRESH", account_id="u-1")
    user_acc = _msa_account(refresh_token="STALE", account_id="u-1", user_managed=True)
    config = Config(worker_base_url="https://w", admin_token="t", accounts=[user_acc],
                    config_path=str(path))

    refresh_rt_from_config(config, user_acc)
    assert user_acc.oauth["refresh_token"] == "STALE"

    static_acc = _msa_account(refresh_token="STALE")
    refresh_rt_from_config(None, static_acc)
    refresh_rt_from_config(Config(worker_base_url="https://w", admin_token="t",
                                  accounts=[], config_path=None), static_acc)
    assert static_acc.oauth["refresh_token"] == "STALE"


def test_refresh_rt_from_config_tolerates_unreadable_file(tmp_path):
    acc = _msa_account(refresh_token="STALE")
    config = Config(worker_base_url="https://w", admin_token="t", accounts=[acc],
                    config_path=str(tmp_path / "does-not-exist.json"))
    refresh_rt_from_config(config, acc)
    assert acc.oauth["refresh_token"] == "STALE"


def test_refresh_rt_from_config_empty_value_keeps_current(tmp_path):
    path = _config_file(tmp_path, refresh_token="")
    acc = _msa_account(refresh_token="STALE")
    config = Config(worker_base_url="https://w", admin_token="t", accounts=[acc],
                    config_path=str(path))
    refresh_rt_from_config(config, acc)
    assert acc.oauth["refresh_token"] == "STALE"


# ---------------------------------------------------------------------------
# 3. 兑换通路接线：用的是 config.json 里的最新 RT
# ---------------------------------------------------------------------------

MSA_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"


@responses.activate
def test_oauth_factory_redeems_latest_rt_from_config(tmp_path, monkeypatch):
    """端到端接线：factory 兑换时用的必须是 config.json 的 FRESH，而非入参里的 STALE。"""
    path = _config_file(tmp_path, refresh_token="FRESH")
    monkeypatch.setattr(oauth_mod, "create_imap_client",
                        lambda account, *, timeout=0, **_kw: SimpleNamespace(
                            oauth2_login=lambda u, tok: None))
    responses.add(responses.POST, MSA_TOKEN_URL,
                  json={"access_token": "acc"}, status=200)

    acc = _msa_account(refresh_token="STALE")
    config = Config(worker_base_url="https://w", admin_token="t", accounts=[acc],
                    config_path=str(path))

    oauth_mod.oauth_client_factory(acc, config)(acc)

    body = responses.calls[-1].request.body
    body = body if isinstance(body, str) else body.decode("utf-8")
    assert "refresh_token=FRESH" in body
    assert "refresh_token=STALE" not in body
    # 兑换响应无新 RT 时不得覆盖已回读的值
    assert acc.oauth["refresh_token"] == "FRESH"


def test_oauth_factory_holds_redemption_lock_while_redeeming(tmp_path, monkeypatch):
    """兑换 + XOAUTH2 建连整段在锁内：另一个线程在同一账号兑换期间进不来。"""
    path = _config_file(tmp_path, refresh_token="FRESH")
    acc = _msa_account(refresh_token="FRESH")
    config = Config(worker_base_url="https://w", admin_token="t", accounts=[acc],
                    config_path=str(path))

    observed = []
    holder_released = threading.Event()
    holder_inside = threading.Event()

    def fake_token_fn(oauth, on_rotated=None):
        holder_inside.set()
        # 保持锁 0.2s；若锁失效，旁路线程会在窗口内观察到重入
        observed.append(("redeem", threading.current_thread().name))
        real_time.sleep(0.2)
        return "tok"

    monkeypatch.setitem(oauth_mod._TOKEN_FN, "msa", fake_token_fn)
    monkeypatch.setattr(oauth_mod, "create_imap_client",
                        lambda account, *, timeout=0, **_kw: SimpleNamespace(
                            oauth2_login=lambda u, tok: None))

    def holder():
        with redemption_lock():
            holder_inside.set()
            try:
                fake_token_fn({}, None)
            finally:
                holder_released.set()

    t = threading.Thread(target=holder, name="holder")
    t.start()
    assert holder_inside.wait(2.0)

    started = real_time.monotonic()
    oauth_mod.oauth_client_factory(acc, config)(acc)
    waited = real_time.monotonic() - started
    t.join()

    assert holder_released.is_set()
    # 旁路线程必须等 holder 释放锁，即等待时间接近 0.2s 而不是立即返回
    assert waited >= 0.1, f"factory 未等待 redemption_lock: {waited:.3f}s"


def test_graph_access_token_locked_reads_fresh_rt(tmp_path, monkeypatch):
    """Graph 通路同样在锁内回读 config.json 的最新 RT。"""
    path = _config_file(tmp_path, refresh_token="FRESH")
    path.write_text(json.dumps({
        "worker_base_url": "https://w", "admin_token": "t",
        "accounts": [{"id": "acc-1", "source": "graph_outlook", "host": "graph.microsoft.com",
                      "port": 443, "username": "x@outlook.com", "password": "",
                      "oauth": {"provider": "graph", "client_id": "c",
                                "refresh_token": "FRESH"}}],
    }), encoding="utf-8")
    captured = {}

    class _Resp:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"access_token": "AT"}

    def fake_post(url, data=None, timeout=None):
        captured.update(data=data)
        return _Resp()

    monkeypatch.setattr(graph_mod.requests, "post", fake_post)

    acc = AccountConfig(id="acc-1", source="graph_outlook", host="graph.microsoft.com",
                        port=443, username="x@outlook.com", password="",
                        oauth={"provider": "graph", "client_id": "c",
                               "refresh_token": "STALE"})
    config = Config(worker_base_url="https://w", admin_token="t", accounts=[acc],
                    config_path=str(path))

    assert graph_mod.graph_access_token_locked(acc, config) == "AT"
    assert captured["data"]["refresh_token"] == "FRESH"


# ---------------------------------------------------------------------------
# 4. daemon tick 循环
# ---------------------------------------------------------------------------

class _StopDaemon(Exception):
    """从假 sleep 里抛出来结束 run_daemon 的 while True。"""


class _Clock:
    def __init__(self, stop_after):
        self.now = 0.0
        self.tick = 0
        self.stop_after = stop_after

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        self.tick += 1
        if self.tick >= self.stop_after:
            raise _StopDaemon()


def _daemon_harness(tmp_path, monkeypatch, *, clock, poll_interval, mutation_interval,
                    accounts=()):
    state_path = str(tmp_path / "state.json")
    config = Config(worker_base_url="https://w", admin_token="t",
                    accounts=list(accounts), state_path=state_path)

    monkeypatch.setattr(main_mod, "load_config", lambda path: config)
    monkeypatch.setattr(main_mod, "fetch_user_accounts", lambda *a: [])
    monkeypatch.setattr(main_mod.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(main_mod.time, "sleep", clock.sleep)

    polls = []
    drains = []
    monkeypatch.setattr(main_mod, "ensure_idle_workers",
                        lambda cfg, st, accs: polls.append(("idle", len(list(accs)))))
    monkeypatch.setattr(main_mod, "_drain_mutation_jobs", lambda cfg: drains.append(1))

    with pytest.raises(_StopDaemon):
        main_mod.run_daemon("whatever.json", poll_interval=poll_interval,
                            mutation_interval=mutation_interval)
    return polls, drains


def test_run_daemon_alternates_poll_and_drain_ticks(tmp_path, monkeypatch):
    """poll_interval=60 / mutation_interval=5：首 tick 立刻拉取，直到第 60s 才再拉取。"""
    clock = _Clock(stop_after=13)
    polls, drains = _daemon_harness(tmp_path, monkeypatch, clock=clock,
                                    poll_interval=60, mutation_interval=5)

    # tick1 (t=0) 与 tick13 (t=60) 是拉取轮；其余 11 个 tick 排空 mutation。
    # 最后一轮 sleep 先把时钟推到 65s 再抛 _StopDaemon 结束循环。
    assert len(polls) == 2
    assert len(drains) == 11
    assert clock.now == 65.0


def test_run_daemon_skips_poll_when_account_backs_off(tmp_path, monkeypatch):
    """退避中的账号不参与轮询拉取（沿用 run_once 的 skip 语义）。"""
    account = AccountConfig(id="bad", source="imap_qq", host="imap.qq.com", port=993,
                            username="u@qq.com", password="pw")
    state_path = str(tmp_path / "state.json")
    config = Config(worker_base_url="https://w", admin_token="t",
                    accounts=[account], state_path=state_path)

    monkeypatch.setattr(main_mod, "load_config", lambda path: config)
    monkeypatch.setattr(main_mod, "fetch_user_accounts", lambda *a: [])
    monkeypatch.setattr(main_mod, "ensure_idle_workers", lambda *a: None)
    monkeypatch.setattr(main_mod, "oauth_client_factory", lambda *a, **k: None)

    synced = []
    monkeypatch.setattr(main_mod, "sync_account",
                        lambda *a: synced.append(a[2].id) or {"synced": 0, "dropped": 0})

    state = main_mod.SyncState(state_path)
    for _ in range(3):
        state.record_failure("bad")

    clock = _Clock(stop_after=1)
    monkeypatch.setattr(main_mod.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(main_mod.time, "sleep", clock.sleep)
    monkeypatch.setattr(main_mod, "_drain_mutation_jobs", lambda cfg: None)

    with pytest.raises(_StopDaemon):
        main_mod.run_daemon("whatever.json", poll_interval=60, mutation_interval=5)

    assert synced == [], "退避窗口内的账号不应被轮询拉取"


def test_poll_pass_skips_accounts_owned_by_live_idle_worker(tmp_path, monkeypatch):
    """有存活 IDLE worker 的账号交给 IDLE 线程，主循环不再重复拉取（避免并发兑换）。"""
    import one_mail_agg.idle_worker as idle_mod

    account = AccountConfig(id="qq", source="imap_qq", host="imap.qq.com", port=993,
                            username="u@qq.com", password="pw")
    config = Config(worker_base_url="https://w", admin_token="t",
                    accounts=[account], state_path=str(tmp_path / "state.json"))
    state = main_mod.SyncState(config.state_path)

    monkeypatch.setattr(main_mod, "get_merged_accounts", lambda cfg, st: ([account], set()))
    monkeypatch.setattr(main_mod, "ensure_idle_workers", lambda *a: None)
    monkeypatch.setattr(main_mod, "sync_account",
                        lambda *a: pytest.fail("IDLE 托管的账号不得被轮询重复同步"))

    class _LiveWorker:
        def is_alive(self):
            return True

        def is_stopped(self):
            return False

    monkeypatch.setitem(idle_mod._active_idle_workers, "qq", _LiveWorker())
    try:
        main_mod._poll_pass(config, state)
    finally:
        idle_mod._active_idle_workers.pop("qq", None)


def test_drain_mutation_jobs_logs_only_when_claimed(tmp_path, monkeypatch, caplog):
    config = Config(worker_base_url="https://w", admin_token="t", accounts=[],
                    state_path=str(tmp_path / "state.json"))

    monkeypatch.setattr(main_mod, "process_mutation_jobs",
                        lambda cfg: {"claimed": 0, "succeeded": 0, "retried": 0,
                                     "failed": 0, "unsupported": 0})
    with caplog.at_level("INFO", logger="one-mail-agg"):
        main_mod._drain_mutation_jobs(config)
    assert "mutation batch" not in caplog.text

    caplog.clear()
    monkeypatch.setattr(main_mod, "process_mutation_jobs",
                        lambda cfg: {"claimed": 3, "succeeded": 2, "retried": 1,
                                     "failed": 0, "unsupported": 0})
    with caplog.at_level("INFO", logger="one-mail-agg"):
        main_mod._drain_mutation_jobs(config)
    assert "mutation batch claimed=3" in caplog.text


def test_redemption_lock_shares_state_with_config_rewrite_lock():
    """两个锁都在 token_store 进程级命名空间内（IDLE/轮询/mutation 同进程共用）。"""
    assert token_store._REDEMPTION_LOCK is not None
    assert token_store._CONFIG_REWRITE_LOCK is not None
