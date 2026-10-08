"""Queue recovery must bound retries without stalling the other queue or polling."""

from collections import deque

import pytest

import one_mail_agg.main as main_mod
from one_mail_agg.config import Config
from one_mail_agg.outbound_jobs import OutboundBatchError


class _StopDaemon(Exception):
    """Exit the test daemon from sleep, outside its error handler."""


class _Clock:
    def __init__(self, stop_at: float):
        self.now = 0.0
        self.stop_at = stop_at

    def sleep(self, seconds: float) -> None:
        self.now += seconds
        if self.now >= self.stop_at:
            raise _StopDaemon()


def _run(tmp_path, monkeypatch, *, failing_queue="mutation", results=(None,),
         stop_at=900, request_duration=0, poll_duration=0):
    clock = _Clock(stop_at)
    remaining = deque(results)
    calls = {"mutation": [], "outbound": [], "poll": []}
    config = Config(worker_base_url="https://worker.invalid", admin_token="test",
                    accounts=[], state_path=str(tmp_path / "state.json"))

    def drain(queue):
        calls[queue].append(clock.now)
        if queue != failing_queue:
            return 1
        clock.now += request_duration
        return remaining.popleft() if len(remaining) > 1 else remaining[0]

    def poll(_config, _state, *, now):
        calls["poll"].append(now)
        clock.now += poll_duration

    monkeypatch.setattr(main_mod, "load_config", lambda _path: config)
    monkeypatch.setattr(main_mod.time, "monotonic", lambda: clock.now)
    monkeypatch.setattr(main_mod.time, "sleep", clock.sleep)
    monkeypatch.setattr(main_mod, "_poll_pass", poll)
    monkeypatch.setattr(main_mod, "_drain_mutation_jobs", lambda _config: drain("mutation"))
    monkeypatch.setattr(main_mod, "_drain_outbound_jobs", lambda _config: drain("outbound"))
    with pytest.raises(_StopDaemon):
        main_mod.run_daemon("test.json")
    return calls


@pytest.mark.parametrize("queue", ["mutation", "outbound"])
def test_failed_queue_exponentially_backs_off_without_stalling_healthy_work(
    tmp_path, monkeypatch, queue,
):
    calls = _run(tmp_path, monkeypatch, failing_queue=queue)
    healthy = "outbound" if queue == "mutation" else "mutation"
    assert calls[queue] == [5, 65, 185, 425, 725]
    assert {10, 70, 190, 430, 730}.issubset(calls[healthy])
    assert calls["poll"] == list(range(0, 900, 60))


@pytest.mark.parametrize("queue", ["mutation", "outbound"])
@pytest.mark.parametrize("recovered_claim", [0, 2])
def test_successful_claim_resets_failure_backoff(tmp_path, monkeypatch, queue, recovered_claim):
    calls = _run(tmp_path, monkeypatch, failing_queue=queue,
                 results=(None, None, recovered_claim, None, 1), stop_at=260)
    assert calls[queue][:6] == [5, 65, 185, 190, 250, 255]


@pytest.mark.parametrize("queue", ["mutation", "outbound"])
def test_empty_queue_does_not_delay_the_busy_queue(tmp_path, monkeypatch, queue):
    calls = _run(tmp_path, monkeypatch, failing_queue=queue, results=(0,), stop_at=95)
    healthy = "outbound" if queue == "mutation" else "mutation"
    assert calls[queue] == [5, 10, 15, 75]
    assert {20, 25, 30, 35, 40, 45, 50, 55, 65, 70, 80, 85, 90}.issubset(calls[healthy])


@pytest.mark.parametrize("queue", ["mutation", "outbound"])
def test_request_duration_does_not_consume_retry_delay(tmp_path, monkeypatch, queue):
    calls = _run(tmp_path, monkeypatch, failing_queue=queue, request_duration=20, stop_at=150)
    assert calls[queue] == [5, 85]


def test_slow_poll_leaves_a_window_to_drain_queues(tmp_path, monkeypatch):
    calls = _run(tmp_path, monkeypatch, results=(1,), poll_duration=70, stop_at=200)
    assert calls["mutation"][0] == 75
    assert calls["outbound"][0] == 75
    assert calls["poll"] == [0, 130]


def test_repeated_failures_and_empty_claims_keep_bounded_state():
    schedule = main_mod.ClaimSchedule()
    for _ in range(2_000):
        schedule = schedule.after_claim(5, None, completed_at=100)
    assert schedule.next_at == 400
    assert schedule.error_delay == 300
    for _ in range(2_000):
        schedule = schedule.after_claim(5, 0, completed_at=100)
    assert schedule.next_at == 160
    assert schedule.empty_claims == 3
    assert schedule.error_delay == 0


@pytest.mark.parametrize("claimed", [None, 0, 1])
def test_backoff_never_shortens_the_configured_interval(claimed):
    schedule = main_mod.ClaimSchedule()
    for _ in range(5):
        schedule = schedule.after_claim(600, claimed, completed_at=100)
        assert schedule.next_at == 700


@pytest.mark.parametrize("queue", ["mutation", "outbound"])
def test_daemon_restart_does_not_inherit_another_runs_backoff(tmp_path, monkeypatch, queue):
    first = _run(tmp_path, monkeypatch, failing_queue=queue, stop_at=200)
    second = _run(tmp_path, monkeypatch, failing_queue=queue, stop_at=200)
    assert first[queue] == second[queue] == [5, 65, 185]


@pytest.mark.parametrize("claimed", [0, 2])
def test_outbound_partial_batch_is_a_failure_not_an_empty_or_successful_claim(
    monkeypatch, caplog, claimed,
):
    result = {"claimed": claimed, "succeeded": 0, "retried": 0, "failed": 0, "unsupported": 0}

    def fail(_config):
        raise OutboundBatchError([("claim", TimeoutError("upstream unavailable"))], result)

    monkeypatch.setattr(main_mod, "process_outbound_jobs", fail)
    assert main_mod._drain_outbound_jobs(object()) is None
    assert "outbound batch error" in caplog.text
