"""Freshness-aware checks for one-mail aggregator smoke logs."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import re
from typing import Iterable


_TIMESTAMP = re.compile(
    r"^(?P<value>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?)"
)
_FETCH = re.compile(r"fetched\s+(?P<count>\d+)\s+user\s+mail\s+account", re.I)
# Any timeout in the window is a failure to observe: the aggregator's own worker
# calls, and its IMAP reads, both surface as "timed out". Scoping this to worker
# wording only would silently drop an IMAP timeout from the verdict.
_TIMEOUT = re.compile(r"(?:read\s+timed\s+out|timed\s*out|timeout)", re.I)


@dataclass(frozen=True)
class AggregatorHealth:
    recent_lines: int
    fetch_events: int
    latest_account_count: int | None
    timeout_events: int
    gmail_idle_events: int

    @property
    def ok(self) -> bool:
        return (
            self.fetch_events > 0
            and self.latest_account_count is not None
            and self.latest_account_count > 0
            and self.timeout_events == 0
            and self.gmail_idle_events > 0
        )

    def message(self) -> str:
        return (
            f"recent_lines={self.recent_lines}, fetch_events={self.fetch_events}, "
            f"latest_account_count={self.latest_account_count}, "
            f"timeout_events={self.timeout_events}, "
            f"gmail_idle_events={self.gmail_idle_events}"
        )


def _timestamp(line: str) -> float | None:
    match = _TIMESTAMP.match(line)
    if not match:
        return None
    value = match.group("value").replace(",", ".")
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed.timestamp()


def assess_aggregator_health(
    lines: Iterable[str],
    *,
    since: float,
    gmail_account_id: str,
) -> AggregatorHealth:
    """Assess only timestamped log lines at or after ``since``.

    Unparseable lines are intentionally excluded instead of being treated as
    current evidence; otherwise an old tail or a stale grep result can produce
    a false healthy result.
    """
    recent = [line for line in lines if (_timestamp(line) or float("-inf")) >= since]
    fetch_counts = [int(match.group("count")) for line in recent if (match := _FETCH.search(line))]
    timeout_events = sum(1 for line in recent if _TIMEOUT.search(line))
    idle_events = sum(
        1
        for line in recent
        if re.search(r"\bIDLE\b", line, re.I) and gmail_account_id in line
    )
    return AggregatorHealth(
        recent_lines=len(recent),
        fetch_events=len(fetch_counts),
        latest_account_count=fetch_counts[-1] if fetch_counts else None,
        timeout_events=timeout_events,
        gmail_idle_events=idle_events,
    )
