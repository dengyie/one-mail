"""Read-only, bounded Cloudflare fleet telemetry; see docs/fleet-metrics.md.

No SQL is executed. Counters cover the entire Cloudflare account, including
databases and Workers outside the managed fleet. This module never assigns an
owner, publishes KV, installs a scheduler, or interprets telemetry as a balance.
"""
from __future__ import annotations

import argparse
import asyncio
from dataclasses import asdict, dataclass, replace
from datetime import date, datetime, time, timedelta, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
import ssl
import sys
from typing import Literal, Mapping, Protocol, Sequence

MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_RESPONSE_BYTES = 512 * 1024
MAX_CONFIG_BYTES = 64 * 1024
MAX_ACCOUNTS = 12
MAX_DATABASES = 10
SAMPLE_SECONDS = 300
FRESH_SECONDS = 900
HISTORY_DAYS = 8
_HOST = "api.cloudflare.com"
_KEY = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_ACCOUNT_ID = re.compile(r"[a-fA-F0-9]{32}\Z")
_DATABASE_ID = re.compile(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\Z")
_ENV_REF = re.compile(r"env:([A-Za-z_][A-Za-z0-9_]*)\Z")


class MetricsError(Exception):
    """Safe public error with the original exception retained as __cause__."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class DatabaseConfig:
    shard_id: str
    database_id: str


@dataclass(frozen=True)
class AccountConfig:
    account_key: str
    provider_account_id: str
    credential_ref: str
    databases: tuple[DatabaseConfig, ...]


@dataclass(frozen=True)
class CollectorConfig:
    accounts: tuple[AccountConfig, ...]
    concurrency: int = 4
    request_timeout_seconds: int = 10
    account_timeout_seconds: int = 60


@dataclass(frozen=True)
class MetricSnapshot:
    account_key: str
    utc_date: str
    observed_at: str
    source: Literal["cloudflare-account-api"]
    rows_read: int | None
    rows_written: int | None
    worker_requests: int | None
    confidence: Literal["authoritative", "partial", "stale"]
    shard_sizes: dict[str, int]
    issues: tuple[str, ...] = ()
    consecutive_valid_samples: int = 0
    allocation_eligible: bool = False


class MetricsTransport(Protocol):
    async def request(self, account: AccountConfig, path: str,
                      payload: dict[str, object] | None, timeout: int) -> object: ...


def _integer(value: object, field: str, maximum: int = MAX_SAFE_INTEGER) -> int:
    if type(value) is not int or value < 0 or value > maximum:
        raise MetricsError(f"INVALID_{field.upper()}")
    return value


def _object(value: object, keys: set[str], field: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != keys:
        raise MetricsError(f"INVALID_{field.upper()}")
    return value


def _string(value: object, pattern: re.Pattern[str], field: str) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise MetricsError(f"INVALID_{field.upper()}")
    return value


def parse_config(value: object) -> CollectorConfig:
    raw = _object(value, {"v", "accounts"}, "config")
    if type(raw["v"]) is not int or raw["v"] != 1:
        raise MetricsError("INVALID_CONFIG_VERSION")
    accounts = raw["accounts"]
    if not isinstance(accounts, list) or not 1 <= len(accounts) <= MAX_ACCOUNTS:
        raise MetricsError("INVALID_ACCOUNT_COUNT")
    result: list[AccountConfig] = []
    account_keys: set[str] = set()
    provider_ids: set[str] = set()
    shard_ids: set[str] = set()
    database_ids: set[str] = set()
    for item in accounts:
        raw_account = _object(item, {"account_key", "provider_account_id", "credential_ref", "databases"}, "account")
        key = _string(raw_account["account_key"], _KEY, "account_key")
        provider_id = _string(raw_account["provider_account_id"], _ACCOUNT_ID, "provider_account_id").lower()
        credential = _string(raw_account["credential_ref"], _ENV_REF, "credential_ref")
        if key in account_keys or provider_id in provider_ids:
            raise MetricsError("DUPLICATE_ACCOUNT")
        account_keys.add(key)
        provider_ids.add(provider_id)
        databases = raw_account["databases"]
        if not isinstance(databases, list) or not 1 <= len(databases) <= MAX_DATABASES:
            raise MetricsError("INVALID_DATABASE_COUNT")
        parsed_databases: list[DatabaseConfig] = []
        for database in databases:
            raw_database = _object(database, {"shard_id", "database_id"}, "database")
            shard_id = _string(raw_database["shard_id"], _KEY, "shard_id")
            database_id = _string(raw_database["database_id"], _DATABASE_ID, "database_id").lower()
            if shard_id in shard_ids or database_id in database_ids:
                raise MetricsError("DUPLICATE_DATABASE")
            shard_ids.add(shard_id)
            database_ids.add(database_id)
            parsed_databases.append(DatabaseConfig(shard_id, database_id))
        result.append(AccountConfig(key, provider_id, credential, tuple(parsed_databases)))
    return CollectorConfig(tuple(result))


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise MetricsError("TIMEZONE_REQUIRED")
    return value.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return _utc(value).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_instant(value: str) -> datetime:
    try:
        instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError) as exc:
        raise MetricsError("INVALID_OBSERVED_AT") from exc
    return _utc(instant)


async def _read_line(reader: asyncio.StreamReader, maximum: int = 8192) -> bytes:
    line = await reader.readline()
    if not line.endswith(b"\r\n") or len(line) > maximum:
        raise MetricsError("INVALID_HTTP_FRAMING")
    return line[:-2]


async def _read_response(reader: asyncio.StreamReader) -> object:
    status = await _read_line(reader)
    status_match = re.fullmatch(rb"HTTP/1\.[01] ([0-9]{3})(?: [^\r\n]*)?", status)
    if not status_match:
        raise MetricsError("INVALID_HTTP_STATUS")
    if status_match[1] != b"200":
        raise MetricsError("HTTP_" + status_match[1].decode("ascii"))
    headers: dict[bytes, bytes] = {}
    framing_headers = {b"content-length", b"transfer-encoding", b"content-encoding"}
    header_bytes = len(status)
    while line := await _read_line(reader):
        header_bytes += len(line)
        key, separator, value = line.partition(b":")
        key = key.lower()
        if not separator or header_bytes > 32 * 1024 or key in headers:
            raise MetricsError("INVALID_HTTP_HEADERS")
        # Repeated Set-Cookie, Server-Timing and other unrelated headers are
        # valid HTTP; only framing headers affect this JSON reader.
        if key in framing_headers:
            headers[key] = value.strip().lower()
    encoding = headers.get(b"content-encoding", b"identity")
    if encoding != b"identity":
        raise MetricsError("UNSUPPORTED_HTTP_ENCODING")
    body = bytearray()
    if headers.get(b"transfer-encoding") == b"chunked":
        if b"content-length" in headers:
            raise MetricsError("INVALID_HTTP_FRAMING")
        while True:
            size_text = (await _read_line(reader, 256)).split(b";", 1)[0]
            if not re.fullmatch(rb"[0-9a-fA-F]+", size_text):
                raise MetricsError("INVALID_HTTP_CHUNK")
            size = int(size_text, 16)
            if len(body) + size > MAX_RESPONSE_BYTES:
                raise MetricsError("RESPONSE_TOO_LARGE")
            if size == 0:
                while trailer := await _read_line(reader):
                    header_bytes += len(trailer)
                    if header_bytes > 32 * 1024:
                        raise MetricsError("INVALID_HTTP_HEADERS")
                break
            body.extend(await reader.readexactly(size))
            if await reader.readexactly(2) != b"\r\n":
                raise MetricsError("INVALID_HTTP_CHUNK")
    else:
        if b"transfer-encoding" in headers:
            raise MetricsError("INVALID_HTTP_FRAMING")
        length = headers.get(b"content-length")
        if length is not None:
            if not length.isdigit() or int(length) > MAX_RESPONSE_BYTES:
                raise MetricsError("RESPONSE_TOO_LARGE")
            body.extend(await reader.readexactly(int(length)))
        else:
            while chunk := await reader.read(min(64 * 1024, MAX_RESPONSE_BYTES + 1 - len(body))):
                body.extend(chunk)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise MetricsError("RESPONSE_TOO_LARGE")
    try:
        return json.loads(body)
    except (ValueError, UnicodeError) as exc:
        raise MetricsError("INVALID_API_JSON") from exc


class CloudflareTransport:
    """Async HTTPS to one fixed origin, with an absolute deadline including DNS."""

    def __init__(self, credentials: Mapping[str, str]):
        self._credentials = credentials
        self._ssl = ssl.create_default_context()

    async def request(self, account: AccountConfig, path: str,
                      payload: dict[str, object] | None, timeout: int) -> object:
        ref = _ENV_REF.fullmatch(account.credential_ref)
        token = self._credentials.get(ref[1] if ref else "", "")
        if not token or len(token) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise MetricsError("CREDENTIAL_UNAVAILABLE")
        if not re.fullmatch(r"/client/v4/(?:graphql|accounts/[a-f0-9]{32}/d1/database/[a-f0-9-]{36})", path):
            raise MetricsError("INVALID_API_PATH")
        body = json.dumps(payload, separators=(",", ":")).encode() if payload is not None else b""
        method = "POST" if payload is not None else "GET"
        request = (f"{method} {path} HTTP/1.1\r\nHost: {_HOST}\r\n"
                   f"Authorization: Bearer {token}\r\nAccept: application/json\r\n"
                   "Accept-Encoding: identity\r\nConnection: close\r\n"
                   f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n").encode() + body
        writer: asyncio.StreamWriter | None = None
        try:
            async with asyncio.timeout(timeout):
                reader, writer = await asyncio.open_connection(_HOST, 443, ssl=self._ssl,
                                                               server_hostname=_HOST, limit=32 * 1024)
                writer.write(request)
                await writer.drain()
                return await _read_response(reader)
        except MetricsError:
            raise
        except TimeoutError as exc:
            raise MetricsError("REQUEST_TIMEOUT") from exc
        except (OSError, ValueError, asyncio.IncompleteReadError) as exc:
            raise MetricsError("TRANSPORT_FAILURE") from exc
        finally:
            if writer is not None:
                writer.close()
                # TLS close-notify can wait for an unresponsive peer. The entire
                # response has been consumed, or this request failed/cancelled;
                # abort the underlying transport to release the socket now.
                writer.transport.abort()


def _analytics(value: object, account_id: str, dataset: str, fields: tuple[str, ...]) -> tuple[int, ...]:
    try:
        if not isinstance(value, dict) or value.get("errors"):
            raise MetricsError("GRAPHQL_FAILURE")
        accounts = value["data"]["viewer"]["accounts"]
        if not isinstance(accounts, list) or len(accounts) != 1 or accounts[0]["accountTag"] != account_id:
            raise MetricsError("ACCOUNT_METRICS_MISSING")
        groups = accounts[0][dataset]
        if not isinstance(groups, list) or len(groups) > 1:
            raise MetricsError("INVALID_ANALYTICS_GROUPS")
        # A successful, explicit empty aggregate means no matching events. A
        # missing account/field, null sum, or GraphQL error never means zero.
        if not groups:
            return tuple(0 for _ in fields)
        sums = groups[0]["sum"]
        return tuple(_integer(sums[field], field) for field in fields)
    except (KeyError, TypeError, IndexError) as exc:
        raise MetricsError("INVALID_ANALYTICS_SCHEMA") from exc


def _size(value: object, database_id: str) -> int:
    try:
        if not isinstance(value, dict) or value.get("success") is not True or value.get("errors"):
            raise MetricsError("DATABASE_API_FAILURE")
        result = value["result"]
        if result["uuid"] != database_id:
            raise MetricsError("DATABASE_ID_MISMATCH")
        return _integer(result["file_size"], "file_size")
    except (KeyError, TypeError) as exc:
        raise MetricsError("INVALID_DATABASE_SCHEMA") from exc


async def _account_sample(account: AccountConfig, config: CollectorConfig,
                          transport: MetricsTransport, now: datetime, utc_day: date) -> MetricSnapshot:
    start = _iso(datetime.combine(utc_day, time(), timezone.utc))
    end = _iso(datetime.combine(utc_day + timedelta(days=1), time(), timezone.utc))
    rows_read: int | None = None
    rows_written: int | None = None
    worker_requests: int | None = None
    sizes: dict[str, int] = {}
    issues: list[str] = []
    account_filter = "accountTag: " + json.dumps(account.provider_account_id)
    d1_query = ("query { viewer { accounts(filter: {" + account_filter + "}) { accountTag "
                "d1AnalyticsAdaptiveGroups(limit: 1, filter: {date_geq: " + json.dumps(str(utc_day)) +
                ", date_leq: " + json.dumps(str(utc_day)) + "}) { sum { rowsRead rowsWritten } } } } }")
    worker_query = ("query { viewer { accounts(filter: {" + account_filter + "}) { accountTag "
                    "workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: " + json.dumps(start) +
                    ", datetime_lt: " + json.dumps(end) + "}) { sum { requests } } } } }")
    try:
        async with asyncio.timeout(config.account_timeout_seconds):
            try:
                result = await transport.request(account, "/client/v4/graphql", {"query": d1_query}, config.request_timeout_seconds)
                rows_read, rows_written = _analytics(result, account.provider_account_id, "d1AnalyticsAdaptiveGroups", ("rowsRead", "rowsWritten"))
            except MetricsError as exc:
                issues.append("d1:" + exc.code)
            try:
                result = await transport.request(account, "/client/v4/graphql", {"query": worker_query}, config.request_timeout_seconds)
                worker_requests, = _analytics(result, account.provider_account_id, "workersInvocationsAdaptive", ("requests",))
            except MetricsError as exc:
                issues.append("workers:" + exc.code)
            for database in account.databases:
                try:
                    result = await transport.request(account, f"/client/v4/accounts/{account.provider_account_id}/d1/database/{database.database_id}", None, config.request_timeout_seconds)
                    sizes[database.shard_id] = _size(result, database.database_id)
                except MetricsError as exc:
                    issues.append("size:" + database.shard_id + ":" + exc.code)
    except TimeoutError:
        issues.append("ACCOUNT_TIMEOUT")
    return MetricSnapshot(account.account_key, str(utc_day), _iso(now), "cloudflare-account-api",
                          rows_read, rows_written, worker_requests, "partial" if issues else "authoritative",
                          sizes, tuple(issues))


async def collect(config: CollectorConfig, transport: MetricsTransport, now: datetime,
                  utc_date: date | None = None) -> tuple[MetricSnapshot, ...]:
    """At most four requests in flight; caller cancellation cancels all children."""
    today = _utc(now).date()
    day = utc_date or today
    if type(day) is not date or not today - timedelta(days=HISTORY_DAYS - 1) <= day <= today:
        raise MetricsError("INVALID_METRIC_DATE")
    if not 1 <= config.concurrency <= 4 or not 1 <= config.request_timeout_seconds <= 30 or not 1 <= config.account_timeout_seconds <= 120:
        raise MetricsError("INVALID_COLLECTOR_LIMITS")
    semaphore = asyncio.Semaphore(config.concurrency)

    async def bounded(account: AccountConfig) -> MetricSnapshot:
        async with semaphore:
            return await _account_sample(account, config, transport, now, day)

    async with asyncio.TaskGroup() as group:
        tasks = [group.create_task(bounded(account)) for account in config.accounts]
    return tuple(task.result() for task in tasks)


def _evaluate(snapshot: MetricSnapshot, now: datetime, highwater: Sequence[int | None],
              previous: Sequence[tuple[int, int]], bucket: int) -> MetricSnapshot:
    observed = _parse_instant(snapshot.observed_at)
    issues = list(snapshot.issues)
    stale = (snapshot.utc_date != _utc(now).date().isoformat()
             or observed.date().isoformat() != snapshot.utc_date
             or not 0 <= (_utc(now) - observed).total_seconds() <= FRESH_SECONDS)
    if stale:
        issues.append("STALE_METRICS")
    counters = (snapshot.rows_read, snapshot.rows_written, snapshot.worker_requests)
    if any(counter is None for counter in counters) or not snapshot.shard_sizes:
        issues.append("MISSING_METRICS")
    if any(current is not None and old is not None and current < old for current, old in zip(counters, highwater)):
        issues.append("COUNTER_REGRESSION")
    valid = snapshot.confidence == "authoritative" and not issues
    consecutive = 1 if valid else 0
    for old_bucket, old_valid in previous:
        if not valid or not old_valid or old_bucket != bucket - consecutive or consecutive >= 3:
            break
        consecutive += 1
    confidence: Literal["authoritative", "partial", "stale"] = "stale" if stale else "partial" if issues else snapshot.confidence
    return replace(snapshot, confidence=confidence, issues=tuple(issues),
                   consecutive_valid_samples=consecutive, allocation_eligible=valid and consecutive >= 3)


def record_history(path: Path, snapshots: Sequence[MetricSnapshot], now: datetime) -> tuple[MetricSnapshot, ...]:
    """Atomic report transaction, max 288 samples/account/day and eight UTC days.

    Repeated calls in one five-minute bucket replace that bucket, never count as
    new valid samples. Same-day high-water marks include partial observations so
    a regression cannot be hidden by a second poll or an unrelated API failure.
    """
    now = _utc(now)
    if not 1 <= len(snapshots) <= MAX_ACCOUNTS or len({s.account_key for s in snapshots}) != len(snapshots):
        raise MetricsError("INVALID_SNAPSHOT_COUNT")
    if not path.parent.is_dir() or path.is_symlink():
        raise MetricsError("PRIVATE_HISTORY_DIRECTORY_REQUIRED")
    # Refuse shared directories: path and telemetry history are administrator data.
    if path.parent.stat().st_mode & 0o077:
        raise MetricsError("PRIVATE_HISTORY_DIRECTORY_REQUIRED")
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    os.close(descriptor)
    os.chmod(path, 0o600)
    result: list[MetricSnapshot] = []
    try:
        connection = sqlite3.connect(path, timeout=5)
    except sqlite3.Error as exc:
        raise MetricsError("HISTORY_OPEN_FAILED") from exc
    try:
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("CREATE TABLE IF NOT EXISTS fleet_samples (account_key TEXT NOT NULL, utc_date TEXT NOT NULL, bucket INTEGER NOT NULL, observed_at TEXT NOT NULL, rows_read INTEGER, rows_written INTEGER, worker_requests INTEGER, valid INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account_key, utc_date, bucket))")
        connection.execute("DELETE FROM fleet_samples WHERE utc_date < ?", ((now.date() - timedelta(days=HISTORY_DAYS - 1)).isoformat(),))
        for snapshot in snapshots:
            try:
                metric_day = date.fromisoformat(snapshot.utc_date)
            except ValueError as exc:
                raise MetricsError("INVALID_METRIC_DATE") from exc
            for counter in (snapshot.rows_read, snapshot.rows_written, snapshot.worker_requests):
                if counter is not None:
                    _integer(counter, "counter")
            if len(snapshot.shard_sizes) > MAX_DATABASES:
                raise MetricsError("INVALID_DATABASE_COUNT")
            for shard_id, size in snapshot.shard_sizes.items():
                _string(shard_id, _KEY, "shard_id")
                _integer(size, "file_size")
            # Historical daily reconciliation updates the final bucket of that
            # date instead of allocating unbounded extra buckets on later days.
            day_end = datetime.combine(metric_day + timedelta(days=1), time(), timezone.utc) - timedelta(seconds=1)
            bucket = int(min(_parse_instant(snapshot.observed_at), day_end).timestamp()) // SAMPLE_SECONDS
            highwater = connection.execute("SELECT MAX(rows_read), MAX(rows_written), MAX(worker_requests) FROM fleet_samples WHERE account_key=? AND utc_date=?", (snapshot.account_key, snapshot.utc_date)).fetchone()
            previous = connection.execute("SELECT bucket, valid FROM fleet_samples WHERE account_key=? AND utc_date=? AND bucket < ? ORDER BY bucket DESC LIMIT 2", (snapshot.account_key, snapshot.utc_date, bucket)).fetchall()
            sample = _evaluate(snapshot, now, highwater, previous, bucket)
            # Never replace newer data with delayed output from another collector.
            current = connection.execute("SELECT MAX(observed_at) FROM fleet_samples WHERE account_key=? AND utc_date=?", (sample.account_key, sample.utc_date)).fetchone()
            if current[0] is not None and _parse_instant(current[0]) > _parse_instant(sample.observed_at):
                raise MetricsError("OUT_OF_ORDER_SAMPLE")
            stored_counters = tuple(max(new, old) if new is not None and old is not None else new if new is not None else old for new, old in zip((sample.rows_read, sample.rows_written, sample.worker_requests), highwater))
            connection.execute("INSERT INTO fleet_samples VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_key, utc_date, bucket) DO UPDATE SET observed_at=excluded.observed_at, rows_read=excluded.rows_read, rows_written=excluded.rows_written, worker_requests=excluded.worker_requests, valid=excluded.valid, payload=excluded.payload", (sample.account_key, sample.utc_date, bucket, sample.observed_at, *stored_counters, int(sample.confidence == "authoritative"), json.dumps(asdict(sample), separators=(",", ":"))))
            result.append(sample)
        # Enforce an absolute bound even if account names/configuration rotate.
        connection.execute("DELETE FROM fleet_samples WHERE rowid IN (SELECT rowid FROM fleet_samples ORDER BY utc_date DESC, bucket DESC, account_key LIMIT -1 OFFSET ?)", (MAX_ACCOUNTS * HISTORY_DAYS * (86400 // SAMPLE_SECONDS),))
        connection.commit()
    except (sqlite3.Error, OSError) as exc:
        connection.rollback()
        raise MetricsError("HISTORY_WRITE_FAILED") from exc
    finally:
        connection.close()
    return tuple(result)


def _load_config(path: Path) -> CollectorConfig:
    try:
        with path.open("rb") as source:
            contents = source.read(MAX_CONFIG_BYTES + 1)
        if len(contents) > MAX_CONFIG_BYTES:
            raise MetricsError("CONFIG_TOO_LARGE")
        return parse_config(json.loads(contents))
    except (OSError, ValueError, UnicodeError) as exc:
        raise MetricsError("CONFIG_READ_FAILED") from exc


async def _run(config_path: Path, history_path: Path, utc_date: date | None = None) -> tuple[MetricSnapshot, ...]:
    config = await asyncio.to_thread(_load_config, config_path)
    started = datetime.now(timezone.utc)
    snapshots = await collect(config, CloudflareTransport(os.environ), started, utc_date)
    return await asyncio.to_thread(record_history, history_path, snapshots, datetime.now(timezone.utc))


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only account telemetry; requires a private 0700 history directory.")
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--history", required=True, type=Path, help="Local SQLite history file, bounded to eight UTC days")
    parser.add_argument("--utc-date", type=date.fromisoformat, help="Reconcile a prior complete UTC day within the retained eight-day window")
    args = parser.parse_args(argv)
    try:
        snapshots = asyncio.run(_run(args.config, args.history, args.utc_date))
    except (MetricsError, OSError) as exc:
        print(json.dumps({"error_code": exc.code if isinstance(exc, MetricsError) else "LOCAL_IO_FAILURE"}), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    print(json.dumps({"v": 1, "mode": "observe", "accounts": [asdict(item) for item in snapshots]}, separators=(",", ":")))
    return 2 if any(item.confidence != "authoritative" for item in snapshots) else 0


if __name__ == "__main__":
    raise SystemExit(main())
