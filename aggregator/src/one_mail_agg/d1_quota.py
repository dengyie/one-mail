"""Decode authoritative Worker D1 exhaustion without guessing from usage counters."""
from datetime import datetime, timedelta, timezone

import requests


class DatabaseQuotaExceeded(RuntimeError):
    def __init__(self, code: str, retry_at: float):
        self.code = code
        self.retry_at = retry_at
        reset = datetime.fromtimestamp(retry_at, timezone.utc).isoformat()
        super().__init__(f"{code}: database sync paused until {reset}")


def database_quota_error(response: requests.Response, now: float) -> DatabaseQuotaExceeded | None:
    if response.status_code != 503:
        return None
    try:
        body = response.json()
    except ValueError:
        return None  # A non-JSON 503 retains the ordinary transport retry policy.
    if not isinstance(body, dict):
        return None
    code = body.get("code")
    if not isinstance(code, str) or code not in {
        "D1_DAILY_READ_LIMIT", "D1_DAILY_WRITE_LIMIT", "D1_HOURLY_READ_BUDGET",
    }:
        return None
    value = body.get("retry_at")
    if not isinstance(value, str):
        return None
    try:
        reset = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if reset.tzinfo is None or reset.utcoffset() != timedelta(0):
        return None
    retry_at = reset.timestamp()
    if retry_at > now + 86_400:
        return None
    # A response crossing midnight may arrive just after its deadline. Do not
    # spin inside the current batch; allow the next scheduled attempt to retry.
    error = DatabaseQuotaExceeded(code, max(now + 1, retry_at))
    error.__cause__ = requests.HTTPError(f"HTTP 503 ({code})", response=response)
    return error


def batch_quota_retry_at(error: Exception) -> float | None:
    """Extract the quota pause deadline from a batch error's failure causes.

    MutationBatchError/OutboundBatchError pair context strings with the claim
    exceptions; a claim failing on a Worker D1 budget 503 carries its
    DatabaseQuotaExceeded there. Callers pause the queue loop until that epoch
    instead of paying a full-table claim scan every backoff tick.
    """
    if isinstance(error, DatabaseQuotaExceeded):
        return error.retry_at
    failures = getattr(error, "failures", None)
    if not failures:
        return None
    deadlines = [cause.retry_at for _, cause in failures if isinstance(cause, DatabaseQuotaExceeded)]
    return max(deadlines) if deadlines else None
