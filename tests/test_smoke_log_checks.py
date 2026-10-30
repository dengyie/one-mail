from datetime import datetime, timezone

from scripts.smoke_log_checks import assess_aggregator_health


def _ts(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def test_ignores_old_success_and_reports_recent_timeout():
    lines = [
        f"{_ts(90)} INFO fetched 5 user mail account(s)",
        f"{_ts(90)} INFO Account gmail IDLE monitoring",
        f"{_ts(110)} WARNING Read timed out while reporting sync status",
    ]
    health = assess_aggregator_health(lines, since=100, gmail_account_id="gmail")
    assert health.ok is False
    assert health.fetch_events == 0
    assert health.timeout_events == 1
    assert health.gmail_idle_events == 0


def test_requires_recent_fetch_idle_and_no_timeout():
    lines = [
        f"{_ts(101)} INFO fetched 5 user mail account(s)",
        f"{_ts(102)} INFO Account gmail IDLE monitoring",
        f"{_ts(103)} INFO sync completed",
    ]
    health = assess_aggregator_health(lines, since=100, gmail_account_id="gmail")
    assert health.ok is True
    assert health.message() == (
        "recent_lines=3, fetch_events=1, latest_account_count=5, "
        "timeout_events=0, gmail_idle_events=1"
    )


def test_matches_timeout_wording_case_insensitively():
    lines = [
        f"{_ts(101)} INFO fetched 5 user mail account(s)",
        f"{_ts(102)} INFO Account gmail IDLE monitoring",
        f"{_ts(103)} WARNING request Timeout from worker",
    ]
    health = assess_aggregator_health(lines, since=100, gmail_account_id="gmail")
    assert health.timeout_events == 1
    assert health.ok is False


def test_unparseable_lines_are_not_fresh_evidence():
    health = assess_aggregator_health(
        ["INFO fetched 5 user mail account(s)", "INFO Account gmail IDLE monitoring"],
        since=100,
        gmail_account_id="gmail",
    )
    assert health.recent_lines == 0
    assert health.ok is False
