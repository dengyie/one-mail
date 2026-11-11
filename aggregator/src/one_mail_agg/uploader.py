import time
import copy
import json
import logging
from urllib.parse import quote
import requests
import re

from .config import Config, WorkerDestination
from .d1_quota import DatabaseQuotaExceeded, database_quota_error

log = logging.getLogger("one-mail-agg")


STORAGE_KEY_RE = re.compile(r"^unified/[A-Za-z0-9_-]{43}$")


class UploadBatchError(RuntimeError):
    """An upload was incomplete; retain causes and acknowledged counters."""

    def __init__(self, kind: str, max_retries: int,
                 failures: list[tuple[str, Exception]], result: dict):
        self.failures = tuple(failures)
        self.result = result
        super().__init__(f"{kind} upload failed (up to {max_retries} attempts): " + "; ".join(
            f"{context}: {type(error).__name__}" for context, error in self.failures))


def _safe_header(value: object, fallback: str) -> str:
    text = str(value or fallback)
    return "".join(char if 0x20 <= ord(char) <= 0x7e else "_" for char in text)[:255] or fallback


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
            if kind == "emails":
                try:
                    chunk = _upload_attachment_payloads(destination, chunk, max_retries=max_retries, timeout=timeout)
                except UploadBatchError as error:
                    failures.extend(error.failures)
                    break
            delay = 1.0
            last = None
            succeeded = False
            attempts_used = 0
            started = time.monotonic()
            for attempt in range(max_retries):
                attempts_used = attempt + 1
                error = None
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
                    error = requests.HTTPError(f"HTTP {response.status_code}", response=response)
                    last = error
                except Exception as exc:
                    # Retain the cause without including its potentially sensitive
                    # text in the printable batch summary.
                    error = exc
                    last = exc
                if attempt < max_retries - 1:
                    # 静默重试曾把 45s 超时×5 连败变成数分钟不可见停顿（2026-11-11 QQ 收信劣化复盘），
                    # 每次失败必须留下 WARNING 轨迹。HTTPError 的消息体只有 "HTTP <code>"
                    #（无响应体，无泄漏面），带上状态码才能区分限流与 D1 过载；
                    # 其它异常只打类型名，避免把可能敏感的异常文本写进日志。
                    reason = str(error) if isinstance(error, requests.HTTPError) else type(error).__name__
                    log.warning("%s ingest attempt %d/%d failed (%s) for destination=%s: retrying in %.0fs",
                                kind, attempt + 1, max_retries, reason, destination.id, delay)
                    time.sleep(delay)
                    delay = min(delay * 2, 30 if kind == "emails" else 10)
            if succeeded and attempts_used > 1:
                log.warning("%s ingest recovered after %d attempts (%.1fs): destination=%s",
                            kind, attempts_used, time.monotonic() - started, destination.id)
            if not succeeded:
                failures.append((f"{destination.id}: {len(chunk)} {kind}", last))
                # Retry this destination on the next sync; still service the other
                # destinations in this mixed batch before surfacing the failure.
                break
    if failures:
        raise UploadBatchError(kind, max_retries, failures, totals) from failures[0][1]
    return totals


def _upload_attachment_payloads(destination: WorkerDestination, rows: list[dict], *, max_retries: int,
                                timeout: int) -> list[dict]:
    """Persist binary parts before acknowledging the corresponding email batch."""
    prepared = []
    for original in rows:
        row = copy.deepcopy(original)
        has_payloads = "_attachment_payloads" in row
        payloads = row.pop("_attachment_payloads", []) or []
        if not has_payloads:
            prepared.append(row)
            continue
        metadata = []
        for payload in payloads:
            content = payload.get("_content", b"")
            if not isinstance(content, (bytes, bytearray)):
                raise ValueError("attachment content must be bytes")
            attachment_id = str(payload.get("id") or "")
            account_id = str(row.get("account_id") or "")
            email_id = str(row.get("id") or "")
            if not attachment_id or not account_id or not email_id:
                raise ValueError("attachment identity is incomplete")
            if len(content) > 30 * 1024 * 1024:
                error = ValueError("attachment exceeds 30 MiB storage limit")
                raise UploadBatchError(
                    "attachment", max_retries,
                    [(f"{destination.id}: attachment {attachment_id}", error)],
                    {"inserted": 0, "skipped": 0},
                ) from error
            path = "/attachments/{}/{}/{}".format(
                quote(account_id, safe=""), quote(email_id, safe=""), quote(attachment_id, safe=""))
            upload_headers = {
                **destination.headers(),
                "Content-Type": "application/octet-stream",
                "Content-Length": str(len(content)),
                "x-one-mail-name": _safe_header(payload.get("name"), "attachment"),
                "x-one-mail-mime-type": _safe_header(payload.get("mimeType"), "application/octet-stream"),
            }
            if destination.api_prefix == "/shard":
                upload_headers["x-one-mail-shard-scope"] = quote(
                    json.dumps({"account_ids": [account_id], "sources": None}, separators=(",", ":")))
            response = None
            last_error = None
            for attempt in range(max_retries):
                try:
                    response = requests.put(destination.api_url(path), data=bytes(content),
                                            headers=upload_headers, timeout=timeout)
                    if response.status_code == 200:
                        break
                    quota = database_quota_error(response, time.time())
                    if quota is not None:
                        last_error = quota
                        break
                    last_error = requests.HTTPError(
                        f"attachment upload failed: HTTP {response.status_code}", response=response)
                    if attempt < max_retries - 1:
                        time.sleep(min(2 ** attempt, 10))
                except Exception as error:
                    last_error = error
                    if attempt >= max_retries - 1:
                        break
                    time.sleep(min(2 ** attempt, 10))
            if response is None or response.status_code != 200:
                raise UploadBatchError(
                    "attachment", max_retries,
                    [(f"{destination.id}: attachment {attachment_id}", last_error or requests.HTTPError("attachment upload failed"))],
                    {"inserted": 0, "skipped": 0},
                ) from last_error
            try:
                reply = response.json()
            except Exception as error:
                raise UploadBatchError(
                    "attachment", max_retries,
                    [(f"{destination.id}: attachment {attachment_id}", error)],
                    {"inserted": 0, "skipped": 0},
                ) from error
            storage_key = reply.get("storage_key") if isinstance(reply, dict) else None
            if not isinstance(storage_key, str) or not STORAGE_KEY_RE.fullmatch(storage_key):
                error = ValueError("attachment upload acknowledgement missing valid storage_key")
                raise UploadBatchError(
                    "attachment", max_retries,
                    [(f"{destination.id}: attachment {attachment_id}", error)],
                    {"inserted": 0, "skipped": 0},
                ) from error
            metadata.append({"id": attachment_id, "name": str(payload.get("name") or "attachment"),
                             "size": len(content), "mimeType": str(payload.get("mimeType") or "application/octet-stream"),
                             "storage_key": storage_key})
        row["attachments_json"] = json.dumps(metadata, ensure_ascii=False)
        row["has_attachments"] = 1 if metadata else 0
        prepared.append(row)
    return prepared


def upload_emails(config: Config, emails: list[dict], max_retries: int = 5, chunk_size: int = 15) -> dict:
    """Group by static destination and upload bounded, idempotent chunks.

    The default 15-message chunks and 90s timeout keep large bodies and D1 writes
    bounded. The 2026-11-11 QQ latency review showed 45s attempts turning slow
    (not dead) links into 5-failure silent retry storms measured in minutes, so
    the per-attempt timeout absorbs the slow tail instead of multiplying retries.
    Partial failure raises so callers do not commit sync watermarks.
    """
    return _upload(config, emails, kind="emails", max_retries=max_retries,
                   chunk_size=chunk_size, timeout=90)


def upload_folders(config: Config, folders: list[dict], max_retries: int = 3, chunk_size: int = 100) -> dict:
    """Route the provider folder catalog, including folders with no messages."""
    return _upload(config, folders, kind="folders", max_retries=max_retries,
                   chunk_size=chunk_size, timeout=20)
