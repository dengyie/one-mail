"""Pure adapter from observed Cloudflare samples to registry MetricReport JSON.

The caller supplies measured/conservative remaining demand. This module never
extrapolates a day's traffic, reads credentials, publishes, or mutates routing.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import re
from typing import Literal, TypedDict

from .fleet_metrics import AccountConfig, MAX_DATABASES, MAX_SAFE_INTEGER, MetricSnapshot, MetricsError

_INSTANT = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\Z")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}\Z")
_EPOCH = re.compile(r"(?:0|[1-9][0-9]{0,19})\Z")
_MAX_EPOCH = 18_446_744_073_709_551_615


@dataclass(frozen=True)
class RemainingDemand:
    """Unobserved traffic plus expected work for the remainder of this UTC day."""

    rows_read: int
    rows_written: int
    worker_requests: int


class RegistryMetricSnapshot(TypedDict):
    account_key: str
    utc_date: str
    observed_at: str
    source: Literal["cloudflare_graphql"]
    rows_read: int
    rows_written: int
    worker_requests: int
    confidence: Literal["authoritative"]
    shard_sizes: dict[str, int]


class MetricReport(TypedDict):
    snapshot: RegistryMetricSnapshot
    projected_rows_read: int
    projected_rows_written: int
    projected_worker_requests: int


class MetricsRequest(TypedDict):
    expected_revision: str
    idempotency_key: str
    report: MetricReport


def _counter(value: object) -> int:
    if type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER:
        raise MetricsError("INVALID_REPORT_COUNTER")
    return value


def _id(value: object) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise MetricsError("INVALID_REPORT_ID")
    return value


def _instant(value: str) -> datetime:
    if not isinstance(value, str) or not _INSTANT.fullmatch(value):
        raise MetricsError("INVALID_REPORT_TIMESTAMP")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise MetricsError("INVALID_REPORT_TIMESTAMP") from exc


def _sample(snapshot: MetricSnapshot, account: AccountConfig) -> tuple[datetime, tuple[int, int, int]]:
    if snapshot.account_key != account.account_key:
        raise MetricsError("REPORT_ACCOUNT_MISMATCH")
    _id(snapshot.account_key)
    if snapshot.source != "cloudflare-account-api" or snapshot.confidence != "authoritative" or snapshot.issues:
        raise MetricsError("UNRELIABLE_REPORT_SAMPLE")
    observed = _instant(snapshot.observed_at)
    if snapshot.utc_date != observed.date().isoformat():
        raise MetricsError("REPORT_DATE_MISMATCH")
    expected = {_id(database.shard_id) for database in account.databases}
    if not 1 <= len(expected) == len(account.databases) <= MAX_DATABASES or set(snapshot.shard_sizes) != expected:
        raise MetricsError("REPORT_SHARDS_MISMATCH")
    for size in snapshot.shard_sizes.values():
        _counter(size)
    return observed, (_counter(snapshot.rows_read), _counter(snapshot.rows_written), _counter(snapshot.worker_requests))


def _projection(observed: int, remaining: int) -> int:
    remaining = _counter(remaining)
    if observed > MAX_SAFE_INTEGER - remaining:
        raise MetricsError("REPORT_COUNTER_OVERFLOW")
    return observed + remaining


def build_metric_report(snapshot: MetricSnapshot, account: AccountConfig,
                        remaining: RemainingDemand, *, now: datetime,
                        baseline: MetricSnapshot | None = None) -> MetricReport:
    """Validate a current sample and add explicit demand, O(managed databases).

    baseline is the last accepted authoritative sample, never a failed latest
    poll. A previous UTC day may reset cumulative counters; same-day regressions
    and duplicate/out-of-order observation times are rejected. Historical
    baseline age is intentionally unrestricted so a long gap cannot erase its
    cumulative high-water mark. The registry independently enforces its series.
    """
    if now.tzinfo is None or now.utcoffset() is None:
        raise MetricsError("TIMEZONE_REQUIRED")
    now = now.astimezone(timezone.utc)
    observed, counters = _sample(snapshot, account)
    if snapshot.utc_date != now.date().isoformat() or not 0 <= (now - observed).total_seconds() <= 900:
        raise MetricsError("STALE_REPORT_SAMPLE")
    if baseline is not None:
        previous_time, previous = _sample(baseline, account)
        if previous_time >= observed:
            raise MetricsError("REPORT_OBSERVATION_NOT_ADVANCING")
        if baseline.utc_date == snapshot.utc_date and any(current < old for current, old in zip(counters, previous)):
            raise MetricsError("REPORT_COUNTER_REGRESSION")
    reads, writes, requests = counters
    return {
        "snapshot": {
            "account_key": snapshot.account_key,
            "utc_date": snapshot.utc_date,
            "observed_at": snapshot.observed_at,
            "source": "cloudflare_graphql",
            "rows_read": reads,
            "rows_written": writes,
            "worker_requests": requests,
            "confidence": "authoritative",
            "shard_sizes": dict(snapshot.shard_sizes),
        },
        "projected_rows_read": _projection(reads, remaining.rows_read),
        "projected_rows_written": _projection(writes, remaining.rows_written),
        "projected_worker_requests": _projection(requests, remaining.worker_requests),
    }


def build_metrics_request(snapshot: MetricSnapshot, account: AccountConfig,
                          remaining: RemainingDemand, *, now: datetime,
                          expected_revision: str, idempotency_key: str,
                          baseline: MetricSnapshot | None = None) -> MetricsRequest:
    """Construct the exact POST body; all time, revision and IDs come from caller."""
    if (not isinstance(expected_revision, str) or not _EPOCH.fullmatch(expected_revision)
            or int(expected_revision) > _MAX_EPOCH):
        raise MetricsError("INVALID_REPORT_REVISION")
    key = _id(idempotency_key)
    report = build_metric_report(snapshot, account, remaining, now=now, baseline=baseline)
    return {"expected_revision": expected_revision, "idempotency_key": key, "report": report}
