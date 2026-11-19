"""Claim paths must pause on a Worker D1 budget 503 instead of scanning.

The 2026-11-20 incident: mutation/outbound claims are full-scan reads. When
the hourly read budget is exhausted the Worker answers 503
D1_HOURLY_READ_BUDGET, but the claim loops treated that as an ordinary
transport error and retried every 2-5 minutes, burning a full-table scan on
every attempt and keeping the hour pinned at zero allowance. #188 gave the
ingest path the pause semantics; these tests pin the same contract onto the
claim paths (the #188 review follow-up's missed surface).
"""

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

import pytest
import requests

import one_mail_agg.main as main_mod
import one_mail_agg.mutation_jobs as mutations
import one_mail_agg.outbound_jobs as outbound
from one_mail_agg.config import Config
from one_mail_agg.d1_quota import DatabaseQuotaExceeded, batch_quota_retry_at

NOW = datetime(2026, 11, 20, 8, 30, tzinfo=timezone.utc).timestamp()
RESET = NOW + 1_800  # hourly budget: retry_at is within the retention window


def _config():
    return Config(
        worker_base_url="https://worker.example",
        admin_token="admin-token",
        accounts=[],
        state_path="state.json",
    )


def _quota_response(code="D1_HOURLY_READ_BUDGET", retry_at=None):
    response = requests.Response()
    response.status_code = 503
    response._content = json.dumps({
        "code": code,
        "retry_at": datetime.fromtimestamp(retry_at or RESET, timezone.utc)
        .isoformat().replace("+00:00", "Z"),
    }).encode()
    return response


def _silence_transport_retry_sleep(monkeypatch):
    monkeypatch.setattr("one_mail_agg.transport_retry.time.sleep", lambda _seconds: None)


@pytest.fixture
def now_frozen(monkeypatch):
    monkeypatch.setattr(mutations.time, "time", lambda: NOW)
    monkeypatch.setattr(outbound.time, "time", lambda: NOW)


# ------------------------------------------------------------------ claim raises

def test_mutation_claim_503_hourly_budget_raises_quota_pause(monkeypatch, now_frozen):
    _silence_transport_retry_sleep(monkeypatch)
    config = _config()
    monkeypatch.setattr(mutations.requests, "post",
                        Mock(return_value=_quota_response()))
    with pytest.raises(DatabaseQuotaExceeded) as caught:
        mutations.claim_mutation_jobs(config)
    assert caught.value.code == "D1_HOURLY_READ_BUDGET"
    assert caught.value.retry_at == RESET
    assert isinstance(caught.value.__cause__, requests.HTTPError)


def test_mutation_claim_quota_pause_is_not_masked_by_the_404_fallback(monkeypatch, now_frozen):
    """The v2->legacy fallback must not swallow a quota 503 from either endpoint."""
    _silence_transport_retry_sleep(monkeypatch)
    config = _config()
    calls = []

    def fake_post(url, **kwargs):
        calls.append(url)
        return _quota_response()

    monkeypatch.setattr(mutations.requests, "post", fake_post)
    with pytest.raises(DatabaseQuotaExceeded):
        mutations._claim_destination_jobs(config, limit=20)
    assert len(calls) == 1  # no retry storm, no legacy fallback after a quota 503


def test_outbound_claim_503_hourly_budget_raises_quota_pause(monkeypatch, now_frozen):
    _silence_transport_retry_sleep(monkeypatch)
    config = _config()
    monkeypatch.setattr(outbound.requests, "post",
                        Mock(return_value=_quota_response()))
    with pytest.raises(DatabaseQuotaExceeded) as caught:
        outbound.claim_outbound_jobs(config)
    assert caught.value.code == "D1_HOURLY_READ_BUDGET"
    assert caught.value.retry_at == RESET


def test_batch_error_from_claimed_quota_failure_carries_the_pause(monkeypatch, now_frozen):
    """process_*_jobs wraps the pause in the batch error; the deadline survives."""
    config = _config()
    quota = DatabaseQuotaExceeded("D1_HOURLY_READ_BUDGET", RESET)
    monkeypatch.setattr(mutations, "claim_mutation_jobs", Mock(side_effect=quota))
    with pytest.raises(mutations.MutationBatchError) as mutation_caught:
        mutations.process_mutation_jobs(config)
    assert batch_quota_retry_at(mutation_caught.value) == RESET

    monkeypatch.setattr(outbound, "claim_outbound_jobs", Mock(side_effect=quota))
    with pytest.raises(outbound.OutboundBatchError) as outbound_caught:
        outbound.process_outbound_jobs(config)
    assert batch_quota_retry_at(outbound_caught.value) == RESET


def test_batch_quota_retry_at_ignores_transport_and_plain_failures():
    assert batch_quota_retry_at(mutations.MutationBatchError(
        [("primary claim", requests.Timeout())], {"claimed": 0})) is None
    assert batch_quota_retry_at(outbound.OutboundBatchError(
        [("primary claim", requests.ConnectionError())], {"claimed": 0})) is None
    assert batch_quota_retry_at(RuntimeError("plain")) is None
    assert batch_quota_retry_at(DatabaseQuotaExceeded("D1_DAILY_READ_LIMIT", RESET)) == RESET


# ------------------------------------------------------------------ loop pauses

class _Clock:
    def __init__(self, stop_at: float):
        self.now = 0.0
        self.stop_at = stop_at

    def sleep(self, seconds: float) -> None:
        self.now += seconds
        if self.now >= self.stop_at:
            raise _StopDaemon()


class _StopDaemon(Exception):
    """Exit the test daemon from sleep, outside its error handler."""


def test_daemon_pauses_claim_until_retry_at_wall_clock(monkeypatch, tmp_path, caplog):
    """A quota 503 holds the queue until the deadline, not a retry every tick.

    Wall time starts at 100.0, the quota pause ends at 600.0. The daemon must
    claim once at startup, then stay silent until the wall-clock deadline —
    every intermediate claim would burn another full-table scan against the
    exhausted read window. The clock stops just after the deadline so the
    resumed claim (delay collapses to 0) lands exactly once more.
    """
    import one_mail_agg.main as main_mod

    config = Config(worker_base_url="https://worker.invalid", admin_token="test",
                    accounts=[], state_path=str(tmp_path / "state.json"))
    clock = _Clock(stop_at=505)
    claims = {"mutation": [], "outbound": []}
    wall = {"now": 100.0}

    def raise_quota(queue):
        def _raise(*_a, **_k):
            claims[queue].append(clock.now)
            raise DatabaseQuotaExceeded("D1_HOURLY_READ_BUDGET", 600.0)
        return _raise

    real_sleep = clock.sleep

    def sleep(seconds: float) -> None:
        wall["now"] += seconds
        real_sleep(seconds)

    monkeypatch.setattr(main_mod.time, "time", lambda: wall["now"])
    monkeypatch.setattr(main_mod.time, "monotonic", lambda: clock.now)
    monkeypatch.setattr(main_mod.time, "sleep", sleep)
    monkeypatch.setattr(main_mod, "load_config", lambda _path: config)
    monkeypatch.setattr(main_mod, "_poll_pass", lambda *_a, **_k: None)
    # Mock the process_* entrypoints, not _drain_*: the real drain wrappers
    # must run so they catch the pause, log it, and reschedule the queue.
    monkeypatch.setattr(main_mod, "process_mutation_jobs", raise_quota("mutation"))
    monkeypatch.setattr(main_mod, "process_outbound_jobs", raise_quota("outbound"))
    with pytest.raises(_StopDaemon):
        main_mod.run_daemon("test.json")

    # First claim on the second tick (tick 0 is a poll tick); the next claim
    # only after the 495s pause expires. A 5s-cadence retry storm would have
    # produced ~100 claims in this window instead of 2.
    assert claims["mutation"] == [5.0, 500.0]
    assert claims["outbound"] == [5.0, 500.0]
    assert "claim paused until UTC epoch 600" in caplog.text


def test_daemon_quota_pause_deadline_is_wall_clock_anchored(monkeypatch):
    """The pause translates the Worker's wall-clock retry_at into monotonic time."""
    monkeypatch.setattr(main_mod.time, "time", lambda: 100.0)
    assert main_mod._quota_pause_at(300.0, 1000.0) == pytest.approx(1200.0)
    # A deadline already in the past degrades to an immediate re-check.
    assert main_mod._quota_pause_at(50.0, 1000.0) == pytest.approx(1000.0)
    assert main_mod._quota_pause_at(None, 1000.0) is None
