import time
import requests

from .config import Config, WorkerDestination
from .d1_quota import DatabaseQuotaExceeded, database_quota_error


class UploadBatchError(RuntimeError):
    """An upload was incomplete; retain causes and acknowledged counters."""

    def __init__(self, kind: str, max_retries: int,
                 failures: list[tuple[str, Exception]], result: dict):
        self.failures = tuple(failures)
        self.result = result
        super().__init__(f"{kind} upload failed (up to {max_retries} attempts): " + "; ".join(
            f"{context}: {type(error).__name__}" for context, error in self.failures))


def quota_retry_at(error: Exception) -> float | None:
    if isinstance(error, DatabaseQuotaExceeded):
        return error.retry_at
    if isinstance(error, UploadBatchError):
        deadlines = [cause.retry_at for _, cause in error.failures if isinstance(cause, DatabaseQuotaExceeded)]
        return max(deadlines) if deadlines else None
    return None


def _upload(config: Config, rows: list[dict], *, kind: str, max_retries: int,
            chunk_size: int, timeout: int) -> dict:
    if max_retries < 1 or chunk_size < 1:
        raise ValueError("max_retries and chunk_size must be positive")
    totals = {"inserted": 0, "skipped": 0} if kind == "emails" else {"folders_upserted": 0}
    groups: dict[WorkerDestination, list[dict]] = {}
    for row in rows:
        groups.setdefault(config.destination_for(row), []).append(row)

    failures = []
    for destination, batch in groups.items():
        headers = {**destination.headers(), "Content-Type": "application/json"}
        for i in range(0, len(batch), chunk_size):
            chunk = batch[i:i + chunk_size]
            delay = 1.0
            last = None
            succeeded = False
            for attempt in range(max_retries):
                try:
                    response = requests.post(destination.api_url("/ingest"),
                                             json={kind: chunk}, headers=headers, timeout=timeout)
                    if response.status_code == 200:
                        payload = response.json()
                        # Parse all counters before updating totals, so a malformed
                        # response cannot double-count a chunk on retry.
                        counts = ({"inserted": int(payload.get("inserted", 0)),
                                   "skipped": int(payload.get("skipped", 0))}
                                  if kind == "emails" else
                                  {"folders_upserted": int(payload.get("folders_upserted", len(chunk)))})
                        for key, count in counts.items():
                            totals[key] += count
                        succeeded = True
                        break
                    quota = database_quota_error(response, time.time())
                    if quota is not None:
                        last = quota
                        break
                    last = requests.HTTPError(f"HTTP {response.status_code}", response=response)
                except Exception as error:
                    # Retain the cause without including its potentially sensitive
                    # text in the printable batch summary.
                    last = error
                if attempt < max_retries - 1:
                    time.sleep(delay)
                    delay = min(delay * 2, 30 if kind == "emails" else 10)
            if not succeeded:
                failures.append((f"{destination.id}: {len(chunk)} {kind}", last))
                # Retry this destination on the next sync; still service the other
                # destinations in this mixed batch before surfacing the failure.
                break
    if failures:
        raise UploadBatchError(kind, max_retries, failures, totals) from failures[0][1]
    return totals


def upload_emails(config: Config, emails: list[dict], max_retries: int = 5, chunk_size: int = 15) -> dict:
    """Group by static destination and upload bounded, idempotent chunks.

    The default 15-message chunks and 45s timeout keep large bodies and D1 writes
    bounded. Partial failure raises so callers do not commit sync watermarks.
    """
    return _upload(config, emails, kind="emails", max_retries=max_retries,
                   chunk_size=chunk_size, timeout=45)


def upload_folders(config: Config, folders: list[dict], max_retries: int = 3, chunk_size: int = 100) -> dict:
    """Route the provider folder catalog, including folders with no messages."""
    return _upload(config, folders, kind="folders", max_retries=max_retries,
                   chunk_size=chunk_size, timeout=20)
