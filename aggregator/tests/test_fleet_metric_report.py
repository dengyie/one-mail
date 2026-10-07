"""Pure D0 → registry JSON boundary, including the actual TS validator."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import shutil
import subprocess

import pytest

from one_mail_agg.fleet_metric_report import RemainingDemand, build_metric_report, build_metrics_request
from one_mail_agg.fleet_metrics import AccountConfig, DatabaseConfig, MAX_SAFE_INTEGER, MetricSnapshot, MetricsError


NOW = datetime(2026, 10, 8, 12, 10, tzinfo=timezone.utc)
ACCOUNT = AccountConfig("account-a", "a" * 32, "env:ACCOUNT_A_READ_TOKEN", (
    DatabaseConfig("primary", "11111111-1111-1111-1111-111111111111"),
    DatabaseConfig("secondary", "22222222-2222-2222-2222-222222222222"),
))
SAMPLE = MetricSnapshot("account-a", "2026-10-08", "2026-10-08T12:05:00Z", "cloudflare-account-api",
                        100, 20, 10, "authoritative", {"primary": 1000, "secondary": 2000})
DEMAND = RemainingDemand(rows_read=1000, rows_written=500, worker_requests=200)


def report(sample=SAMPLE, demand=DEMAND, **kwargs):
    return build_metric_report(sample, ACCOUNT, demand, now=kwargs.pop("now", NOW), **kwargs)


def test_projects_only_explicit_remaining_demand_and_preserves_observed_counts():
    result = report()
    assert result == {
        "snapshot": {"account_key": "account-a", "utc_date": "2026-10-08", "observed_at": "2026-10-08T12:05:00Z",
                     "source": "cloudflare_graphql", "rows_read": 100, "rows_written": 20, "worker_requests": 10,
                     "confidence": "authoritative", "shard_sizes": {"primary": 1000, "secondary": 2000}},
        "projected_rows_read": 1100, "projected_rows_written": 520, "projected_worker_requests": 210,
    }
    assert "credential_ref" not in json.dumps(result)
    assert "allocation_eligible" not in result["snapshot"]


@pytest.mark.parametrize("changes", [
    {"confidence": "partial"}, {"confidence": "stale"}, {"rows_read": None}, {"rows_written": None},
    {"worker_requests": None}, {"issues": ("COUNTER_REGRESSION",)}, {"source": "application_meta"},
])
def test_rejects_partial_missing_or_wrong_source_samples(changes):
    with pytest.raises(MetricsError):
        report(replace(SAMPLE, **changes))


@pytest.mark.parametrize("changes", [
    {"shard_sizes": {"primary": 1000}},
    {"shard_sizes": {"primary": 1000, "secondary": 2000, "other": 3}},
    {"shard_sizes": {"primary": 1000, "other": 2000}},
    {"shard_sizes": {"primary": -1, "secondary": 2}},
    {"shard_sizes": {"primary": 1000, "secondary": 2**53}},
    {"account_key": "account-b"},
])
def test_requires_exact_managed_account_and_shard_sizes(changes):
    with pytest.raises(MetricsError):
        report(replace(SAMPLE, **changes))


@pytest.mark.parametrize("bad", [None, True, -1, 0.5, "1", 2**53])
def test_remaining_demand_is_explicit_safe_integer_without_coercion(bad):
    with pytest.raises(MetricsError, match="INVALID_REPORT_COUNTER"):
        report(demand=RemainingDemand(0, bad, 0))


def test_zero_remaining_demand_is_explicit_and_overflow_fails_closed():
    result = report(demand=RemainingDemand(0, 0, 0))
    assert result["projected_rows_read"] == SAMPLE.rows_read
    with pytest.raises(MetricsError, match="REPORT_COUNTER_OVERFLOW"):
        report(demand=RemainingDemand(MAX_SAFE_INTEGER, 0, 0))


@pytest.mark.parametrize("observed", ["2026-10-08T11:54:59Z", "2026-10-08T12:10:01Z", "2026-10-07T12:10:00Z"])
def test_rejects_expired_future_or_wrong_utc_day(observed):
    with pytest.raises(MetricsError):
        report(replace(SAMPLE, observed_at=observed, utc_date=observed[:10]))


@pytest.mark.parametrize("observed", ["2026-10-08T12:05:00+00:00", "2026-02-30T12:00:00Z", "2026-10-08 12:05:00", "2026-10-08T12:05:00.1234Z"])
def test_timestamp_matches_typescript_utc_canonical_contract(observed):
    with pytest.raises(MetricsError, match="INVALID_REPORT_TIMESTAMP"):
        report(replace(SAMPLE, observed_at=observed))


def test_fifteen_minute_boundary_and_non_utc_clock_are_supported():
    result = report(replace(SAMPLE, observed_at="2026-10-08T11:55:00Z"))
    assert result["snapshot"]["observed_at"] == "2026-10-08T11:55:00Z"
    local_now = NOW.astimezone(timezone(timedelta(hours=8)))
    assert report(now=local_now) == report()
    with pytest.raises(MetricsError, match="TIMEZONE_REQUIRED"):
        report(now=NOW.replace(tzinfo=None))


@pytest.mark.parametrize("field", ["rows_read", "rows_written", "worker_requests"])
def test_current_day_baseline_regression_is_rejected_even_after_long_gap(field):
    baseline = replace(SAMPLE, observed_at="2026-10-08T09:00:00Z", **{field: getattr(SAMPLE, field) + 1})
    with pytest.raises(MetricsError, match="REPORT_COUNTER_REGRESSION"):
        report(baseline=baseline)


def test_duplicate_and_out_of_order_observation_times_do_not_advance_series():
    for observed in (SAMPLE.observed_at, "2026-10-08T12:06:00Z"):
        with pytest.raises(MetricsError, match="REPORT_OBSERVATION_NOT_ADVANCING"):
            report(baseline=replace(SAMPLE, observed_at=observed))


def test_prior_day_baseline_allows_new_day_counter_reset():
    baseline = replace(SAMPLE, utc_date="2026-10-07", observed_at="2026-10-07T23:59:00Z", rows_read=1000000)
    assert report(baseline=baseline)["snapshot"]["rows_read"] == 100


def test_bad_baseline_cannot_erase_previous_counter_guard():
    with pytest.raises(MetricsError, match="UNRELIABLE_REPORT_SAMPLE"):
        report(baseline=replace(SAMPLE, confidence="partial"))


def test_report_copies_shard_sizes_without_mutating_source():
    result = report()
    result["snapshot"]["shard_sizes"]["primary"] = 99
    assert SAMPLE.shard_sizes["primary"] == 1000


@pytest.mark.parametrize("revision", [0, "01", "-1", "18446744073709551616", "1.0", ""])
def test_request_revision_is_uint64_decimal_string(revision):
    with pytest.raises(MetricsError, match="INVALID_REPORT_REVISION"):
        build_metrics_request(SAMPLE, ACCOUNT, DEMAND, now=NOW, expected_revision=revision, idempotency_key="metrics:account-a:20261008T120500Z")


def test_generated_request_passes_actual_worker_typescript_validator():
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required for the cross-language contract check")
    request = build_metrics_request(SAMPLE, ACCOUNT, DEMAND, now=NOW,
                                    expected_revision="18446744073709551615", idempotency_key="metrics:account-a:20261008T120500Z")
    root = Path(__file__).resolve().parents[2]
    script = ("import {metricsRequest} from './worker/src/fleet/validation.ts'; "
              "let data = ''; for await (const chunk of process.stdin) data += chunk; "
              "process.stdout.write(JSON.stringify(metricsRequest(JSON.parse(data))));")
    checked = subprocess.run([node, "--experimental-strip-types", "--input-type=module", "-e", script],
                             cwd=root, input=json.dumps(request), capture_output=True, text=True, timeout=10, check=True)
    assert json.loads(checked.stdout) == request
