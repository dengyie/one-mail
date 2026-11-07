"""Daily logical D1 backups on the aggregator host, without Cloudflare R2.

The Worker's scheduled backup path stays dark until a bucket is bound, and the
account has no R2 subscription. This module backs the same database up from the
VPS that already runs the aggregator: it calls the D1 export REST API, polls it
with the protocol the Worker uses (POST with ``current_bookmark``, download url
nested under ``result.result``), streams the dump through gzip onto local disk
and prunes per tier. No object storage is billed and nothing leaves the host.

The API token is read from a 0600 file so it never appears in argv, in the
process environment or in a log line. The presigned download url is a
credential too: it is never logged.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import logging
import os
import re
import shutil
import stat
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlsplit

import requests


log = logging.getLogger("one_mail_agg.d1_backup")

API_ORIGIN = "https://api.cloudflare.com"
POLL_FORMAT = "polling"

# The export is a server-side job, so the poll budget is unrelated to the free
# plan's 50-subrequest-per-invocation ceiling. A 169 MiB dump finished in four
# polls; 120 leaves room for a slow day without hanging the scheduler forever.
MAX_POLLS = 120
POLL_INTERVAL_SECONDS = 1.0
REQUEST_TIMEOUT = (10, 60)
DOWNLOAD_TIMEOUT = (10, 120)
DOWNLOAD_CHUNK_BYTES = 256 * 1024

MAX_API_RESPONSE_BYTES = 64 * 1024
MAX_DUMP_BYTES = 4 * 1024 * 1024 * 1024
MIN_DUMP_BYTES = 1024
MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024
GZIP_LEVEL = 6
RETRY_SECONDS = 30 * 60

DEFAULT_KEEP_DAILY = 7
DEFAULT_KEEP_WEEKLY = 4
DEFAULT_KEEP_MONTHLY = 6
DEFAULT_HOUR = 3
DEFAULT_MINUTE = 10

MAX_CONFIG_BYTES = 4096
MIN_TOKEN_LENGTH = 20
MAX_TOKEN_LENGTH = 4096

_ACCOUNT_ID_RE = re.compile(r"[a-fA-F0-9]{32}\Z")
_DATABASE_ID_RE = re.compile(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\Z")
_DAILY_RE = re.compile(r"\d{4}-\d{2}-\d{2}\.sql\.gz\Z")
_WEEKLY_RE = re.compile(r"\d{4}-W\d{2}\.sql\.gz\Z")
_MONTHLY_RE = re.compile(r"\d{4}-\d{2}\.sql\.gz\Z")
_CONFIG_KEYS = frozenset({
    "account_id", "database_id", "root", "keep_daily", "keep_weekly",
    "keep_monthly", "hour", "minute", "min_free_bytes",
})

TIERS = (
    ("daily", _DAILY_RE, "keep_daily"),
    ("weekly", _WEEKLY_RE, "keep_weekly"),
    ("monthly", _MONTHLY_RE, "keep_monthly"),
)


class BackupError(RuntimeError):
    """A safe, single-word failure code plus an optional non-secret detail."""

    def __init__(self, code: str, detail: str | None = None):
        self.code = code
        self.detail = detail
        super().__init__(code if detail is None else f"{code}: {detail}")


class ExportUrl(NamedTuple):
    signed_url: str
    polls: int


@dataclass(frozen=True)
class BackupSettings:
    account_id: str
    database_id: str
    root: Path
    token: str = field(repr=False)
    keep_daily: int = DEFAULT_KEEP_DAILY
    keep_weekly: int = DEFAULT_KEEP_WEEKLY
    keep_monthly: int = DEFAULT_KEEP_MONTHLY
    hour: int = DEFAULT_HOUR
    minute: int = DEFAULT_MINUTE
    min_free_bytes: int = MIN_FREE_BYTES

    def keep(self, tier: str) -> int:
        return {"daily": self.keep_daily, "weekly": self.keep_weekly,
                "monthly": self.keep_monthly}[tier]


@dataclass(frozen=True)
class BackupResult:
    ok: bool
    error: str | None = None
    files: tuple[str, ...] = ()
    removed: tuple[str, ...] = ()
    raw_bytes: int = 0
    bytes: int = 0
    sha256: str | None = None
    polls: int = 0


def export_endpoint(account_id: str, database_id: str) -> str:
    if not _ACCOUNT_ID_RE.match(account_id):
        raise BackupError("invalid_account_id")
    if not _DATABASE_ID_RE.match(database_id):
        raise BackupError("invalid_database_id")
    return (f"{API_ORIGIN}/client/v4/accounts/{account_id.lower()}"
            f"/d1/database/{database_id.lower()}/export")


def new_session() -> requests.Session:
    # Unlike the read-only metrics collector, this job must inherit the proxy
    # the aggregator uses: api.cloudflare.com is not directly reachable from
    # the VPS, and the same egress path is already proven by the mail loops.
    session = requests.Session()
    session.trust_env = True
    return session


def create_export(session, endpoint: str, token: str,
                  timeout=REQUEST_TIMEOUT) -> str:
    response = session.post(endpoint, headers=_auth(token),
                            json={"output_format": POLL_FORMAT}, timeout=timeout)
    result = _api_result(response, "create")
    bookmark = result.get("at_bookmark")
    if not isinstance(bookmark, str) or not bookmark:
        raise BackupError("missing_bookmark")
    return bookmark


def wait_for_export(session, endpoint: str, token: str, bookmark: str, *,
                    max_polls: int = MAX_POLLS,
                    interval: float = POLL_INTERVAL_SECONDS,
                    sleep=time.sleep, timeout=REQUEST_TIMEOUT) -> ExportUrl:
    if max_polls < 1:
        raise BackupError("invalid_poll_budget")
    current = bookmark
    for attempt in range(1, max_polls + 1):
        response = session.post(
            endpoint,
            headers=_auth(token),
            json={"output_format": POLL_FORMAT, "current_bookmark": current},
            timeout=timeout,
        )
        result = _api_result(response, f"poll {attempt}")
        status = result.get("status")
        if status == "complete":
            # The real API nests the download url one level deeper than the
            # rest of the poll payload; a top-level signed_url is never sent.
            completion = result.get("result")
            url = completion.get("signed_url") if isinstance(completion, dict) else None
            if not isinstance(url, str) or not url:
                raise BackupError("missing_signed_url")
            return ExportUrl(url, attempt)
        if status == "error":
            raise BackupError("export_failed", _detail(result.get("error")))
        next_bookmark = result.get("at_bookmark")
        if isinstance(next_bookmark, str) and next_bookmark:
            current = next_bookmark
        if attempt < max_polls:
            sleep(interval)
    raise BackupError("export_timeout", f"after {max_polls} polls")


def download_dump(session, url: str, target: Path, *,
                  timeout=DOWNLOAD_TIMEOUT) -> dict:
    """Stream a presigned dump url into a gzip file at ``target``.

    Nothing is buffered whole: a 169 MiB export is compressed chunk by chunk,
    so memory stays flat on a small VPS.
    """
    if not _is_https(url):
        raise BackupError("insecure_download_url")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    part = target.with_name(target.name + ".part")
    part.unlink(missing_ok=True)
    raw_bytes = 0
    head = b""
    try:
        # No Authorization header: the url carries its own signature.
        with session.get(url, stream=True, timeout=timeout) as response:
            if response.status_code != 200:
                raise BackupError("download_failed", f"HTTP {response.status_code}")
            with part.open("wb") as raw_file, gzip.GzipFile(
                fileobj=raw_file, mode="wb", compresslevel=GZIP_LEVEL, mtime=0
            ) as zipped:
                for chunk in response.iter_content(DOWNLOAD_CHUNK_BYTES):
                    if not chunk:
                        continue
                    raw_bytes += len(chunk)
                    if raw_bytes > MAX_DUMP_BYTES:
                        raise BackupError("dump_too_large", f">{MAX_DUMP_BYTES} bytes")
                    if len(head) < 16:
                        head += chunk[:16 - len(head)]
                    zipped.write(chunk)
        _require_sql(head, raw_bytes)
        size = part.stat().st_size
        if size == 0:
            raise BackupError("empty_dump")
        digest = _sha256(part)
        part.chmod(0o600)
        os.replace(part, target)
        return {"bytes": size, "sha256": digest, "raw_bytes": raw_bytes}
    except BaseException:
        part.unlink(missing_ok=True)
        raise


def run_backup(settings: BackupSettings, *, session=None,
               now: datetime | None = None, sleep=time.sleep) -> BackupResult:
    now = now or datetime.now().astimezone()
    root = settings.root
    try:
        _prepare_root(root)
        _require_free_space(root, settings.min_free_bytes)
        endpoint = export_endpoint(settings.account_id, settings.database_id)
        session = session or new_session()
        bookmark = create_export(session, endpoint, settings.token)
        export = wait_for_export(session, endpoint, settings.token, bookmark, sleep=sleep)

        stamp = now.date()
        daily = root / "daily" / f"{stamp.isoformat()}.sql.gz"
        meta = download_dump(session, export.signed_url, daily)

        linked = []
        year, week, _ = stamp.isocalendar()
        weekly = root / "weekly" / f"{year:04d}-W{week:02d}.sql.gz"
        if not weekly.exists():
            linked.append(_link(daily, weekly))
        monthly = root / "monthly" / f"{stamp:%Y-%m}.sql.gz"
        if not monthly.exists():
            linked.append(_link(daily, monthly))

        removed = _prune_all(settings)
    except BackupError as error:
        _record(root, now, ok=False, error=error.code, detail=error.detail)
        log.error("D1 backup failed: %s", error)
        return BackupResult(ok=False, error=str(error))
    except (requests.RequestException, OSError) as error:
        code = "local_io" if isinstance(error, OSError) else "transport_error"
        _record(root, now, ok=False, error=code, detail=type(error).__name__)
        log.error("D1 backup failed: %s (%s)", code, type(error).__name__)
        return BackupResult(ok=False, error=f"{code}: {type(error).__name__}")

    files = (str(daily.relative_to(root)).replace(os.sep, "/"), *linked)
    _record(root, now, ok=True, files=files, raw_bytes=meta["raw_bytes"],
            bytes=meta["bytes"], sha256=meta["sha256"], polls=export.polls,
            removed=removed)
    log.info("D1 backup ok: %s raw=%d gz=%d polls=%d removed=%d",
             files[0], meta["raw_bytes"], meta["bytes"], export.polls, len(removed))
    return BackupResult(ok=True, files=files, removed=tuple(removed),
                        raw_bytes=meta["raw_bytes"], bytes=meta["bytes"],
                        sha256=meta["sha256"], polls=export.polls)


def load_settings(config_path: str | os.PathLike, token_path: str | os.PathLike) -> BackupSettings:
    path = Path(config_path)
    raw = _read_config(path)
    unknown = set(raw) - _CONFIG_KEYS
    if unknown:
        raise BackupError("unknown_config_key", ",".join(sorted(unknown)))
    account_id = _require_string(raw, "account_id")
    database_id = _require_string(raw, "database_id")
    if not _ACCOUNT_ID_RE.match(account_id):
        raise BackupError("invalid_account_id")
    if not _DATABASE_ID_RE.match(database_id):
        raise BackupError("invalid_database_id")
    root_text = _require_string(raw, "root")
    if not os.path.isabs(root_text) or "\x00" in root_text:
        raise BackupError("invalid_root", "must be an absolute path")
    root = Path(root_text)
    if root.parent == root:
        raise BackupError("invalid_root", "refusing the filesystem root")
    return BackupSettings(
        account_id=account_id.lower(),
        database_id=database_id.lower(),
        root=root,
        token=_read_token(Path(token_path)),
        keep_daily=_bounded_int(raw, "keep_daily", DEFAULT_KEEP_DAILY, 1, 365),
        keep_weekly=_bounded_int(raw, "keep_weekly", DEFAULT_KEEP_WEEKLY, 1, 260),
        keep_monthly=_bounded_int(raw, "keep_monthly", DEFAULT_KEEP_MONTHLY, 1, 120),
        hour=_bounded_int(raw, "hour", DEFAULT_HOUR, 0, 23),
        minute=_bounded_int(raw, "minute", DEFAULT_MINUTE, 0, 59),
        min_free_bytes=_bounded_int(raw, "min_free_bytes", MIN_FREE_BYTES, 0, 1 << 40),
    )


def needs_today(settings: BackupSettings, now: datetime) -> bool:
    return not (settings.root / "daily" / f"{now.date().isoformat()}.sql.gz").exists()


def next_run_at(now: datetime, hour: int, minute: int) -> datetime:
    candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate


def run_forever(settings: BackupSettings, *, session_factory=new_session,
                clock=lambda: datetime.now().astimezone(), sleep=time.sleep) -> int:
    log.info("D1 backup scheduler started: daily at %02d:%02d into %s",
             settings.hour, settings.minute, settings.root)
    retry_at: datetime | None = None
    while True:
        now = clock()
        if needs_today(settings, now) and (retry_at is None or now >= retry_at):
            result = run_backup(settings, session=session_factory(), now=now, sleep=sleep)
            if result.ok:
                retry_at = None
                target = next_run_at(clock(), settings.hour, settings.minute)
            else:
                retry_at = clock() + timedelta(seconds=RETRY_SECONDS)
                target = retry_at
        else:
            target = next_run_at(now, settings.hour, settings.minute)
        delay = max(1.0, (target - clock()).total_seconds())
        log.info("next D1 backup attempt in %d s", int(delay))
        sleep(delay)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Daily logical D1 backup on the aggregator host.")
    parser.add_argument("--config", required=True, help="0600 JSON target/retention config")
    parser.add_argument("--token-file", required=True, help="0600 file holding the D1 API token")
    parser.add_argument("--loop", action="store_true", help="stay resident and run daily")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                        format="%(asctime)s %(levelname)s %(message)s")
    try:
        settings = load_settings(args.config, args.token_file)
    except (OSError, BackupError) as error:
        log.error("invalid D1 backup configuration: %s", error)
        return 2
    if args.loop:
        return run_forever(settings)
    result = run_backup(settings)
    return 0 if result.ok else 1


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


def _api_result(response, context: str) -> dict:
    if len(response.content) > MAX_API_RESPONSE_BYTES:
        raise BackupError("api_response_too_large", context)
    try:
        body = response.json()
    except ValueError as error:
        raise BackupError("api_non_json", f"{context}: HTTP {response.status_code}") from error
    if not isinstance(body, dict):
        raise BackupError("api_non_json", context)
    if body.get("success") is not True:
        raise BackupError("api_error", f"{context}: {_errors(body)}")
    result = body.get("result")
    if not isinstance(result, dict):
        raise BackupError("api_missing_result", context)
    return result


def _errors(body: dict) -> str:
    errors = body.get("errors")
    if isinstance(errors, list):
        messages = [str(item.get("message")) for item in errors
                    if isinstance(item, dict) and item.get("message")]
        if messages:
            return "; ".join(messages)[:200]
    return "no error detail"


def _detail(value) -> str:
    if isinstance(value, str):
        return value[:200]
    if value is None:
        return "no error detail"
    return json.dumps(value, sort_keys=True)[:200]


def _is_https(url: str) -> bool:
    try:
        parsed = urlsplit(url)
    except ValueError:
        return False
    return (parsed.scheme == "https" and bool(parsed.hostname)
            and "." in (parsed.hostname or "")
            and parsed.username is None and parsed.password is None)


def _require_sql(head: bytes, raw_bytes: int) -> None:
    # A D1 export is SQL text. An HTML error page from a proxy starts with "<";
    # checking the prefix first reports the real cause even for a tiny page.
    stripped = head.lstrip()
    if not stripped or stripped[:1] == b"<":
        raise BackupError("dump_not_sql")
    if raw_bytes < MIN_DUMP_BYTES:
        raise BackupError("dump_too_small", f"{raw_bytes} bytes")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _prepare_root(root: Path) -> None:
    for name, _pattern, _keep in TIERS:
        (root / name).mkdir(parents=True, exist_ok=True, mode=0o700)
        (root / name).chmod(0o700)


def _require_free_space(root: Path, min_free_bytes: int) -> None:
    free = shutil.disk_usage(root).free
    if free < min_free_bytes:
        raise BackupError("insufficient_disk_space", f"{free} < {min_free_bytes}")


def _link(source: Path, target: Path) -> str:
    """Expose one dump under a second tier name, sharing the inode when possible."""
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    part = target.with_name(target.name + ".part")
    part.unlink(missing_ok=True)
    try:
        os.link(source, part)
    except OSError:
        shutil.copyfile(source, part)
    part.chmod(0o600)
    os.replace(part, target)
    return f"{target.parent.name}/{target.name}"


def _prune_all(settings: BackupSettings) -> list[str]:
    removed = []
    for name, pattern, _keep in TIERS:
        removed.extend(_prune(settings.root / name, pattern, settings.keep(name)))
    return removed


def _prune(directory: Path, pattern: re.Pattern, keep: int) -> list[str]:
    """Delete only files that match this tier's exact naming scheme."""
    if not directory.is_dir():
        return []
    removed = []
    for path in directory.iterdir():
        if path.name.endswith(".part"):
            path.unlink(missing_ok=True)
    names = sorted((path.name for path in directory.iterdir()
                    if path.is_file() and pattern.match(path.name)), reverse=True)
    for name in names[keep:]:
        (directory / name).unlink(missing_ok=True)
        removed.append(f"{directory.name}/{name}")
    return removed


def _record(root: Path, now: datetime, **entry) -> None:
    """Append one audit line; a broken ledger must never fail the backup."""
    line = json.dumps({"at": now.isoformat(timespec="seconds"), **entry},
                      sort_keys=True, separators=(",", ":")) + "\n"
    path = root / "runs.jsonl"
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
            handle.write(line)
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as error:
        log.warning("could not append %s: %s", path, type(error).__name__)


def _read_config(path: Path) -> dict:
    if not path.is_file():
        raise BackupError("config_missing", str(path))
    size = path.stat().st_size
    if size > MAX_CONFIG_BYTES:
        raise BackupError("config_too_large", f"{size} bytes")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise BackupError("config_not_json", str(path)) from error
    if not isinstance(raw, dict):
        raise BackupError("config_not_object")
    return raw


def _read_token(path: Path) -> str:
    if os.name == "posix":
        try:
            mode = stat.S_IMODE(path.stat().st_mode)
        except OSError as error:
            raise BackupError("token_file_unreadable", str(path)) from error
        if mode & 0o077:
            raise BackupError("token_file_permissions", "must not be group/world accessible")
    try:
        raw = path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError) as error:
        raise BackupError("token_file_unreadable", str(path)) from error
    if not MIN_TOKEN_LENGTH <= len(raw) <= MAX_TOKEN_LENGTH:
        raise BackupError("token_invalid", "unexpected length")
    if any(character.isspace() or ord(character) < 33 or ord(character) > 126
           for character in raw):
        raise BackupError("token_invalid", "contains a non-printable character")
    return raw


def _require_string(raw: dict, key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise BackupError("invalid_config_value", key)
    return value.strip()


def _bounded_int(raw: dict, key: str, default: int, low: int, high: int) -> int:
    value = raw.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise BackupError("invalid_config_value", f"{key} must be an integer in [{low}, {high}]")
    return value


if __name__ == "__main__":
    sys.exit(main())
