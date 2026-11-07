"""D1 backup contracts: no network, no production credentials."""
import gzip
import json
import os
from datetime import datetime, timezone

import pytest

from one_mail_agg import d1_backup as d1b


ACCOUNT = "0123456789abcdef0123456789abcdef"
DATABASE = "5f3e1c0a-9b2d-4e7a-8c61-1d2e3f4a5b6c"
TOKEN = "t" * 40
DUMP = b"CREATE TABLE t (id INTEGER);\n" * 100
NOW = datetime(2026, 11, 7, 3, 10, tzinfo=timezone.utc)


class FakeResponse:
    def __init__(self, *, status_code=200, payload=None, body=None, chunks=None):
        self.status_code = status_code
        self._payload = payload
        self._body = body
        self._chunks = chunks

    @property
    def content(self):
        if self._body is not None:
            return self._body
        if self._payload is None:
            return b""
        return json.dumps(self._payload).encode()

    def json(self):
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload

    def iter_content(self, size):
        yield from (self._chunks or [])

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeSession:
    def __init__(self, posts=(), download=None):
        self._posts = list(posts)
        self._download = download
        self.post_calls = []
        self.get_calls = []

    def post(self, url, **kwargs):
        self.post_calls.append((url, kwargs))
        if not self._posts:
            raise AssertionError("unexpected POST")
        return self._posts.pop(0)

    def get(self, url, **kwargs):
        self.get_calls.append((url, kwargs))
        if self._download is None:
            raise AssertionError("unexpected GET")
        return self._download


def created(bookmark="b1"):
    return FakeResponse(payload={"success": True, "result": {"at_bookmark": bookmark}})


def active(bookmark):
    return FakeResponse(payload={"success": True,
                                 "result": {"status": "active", "at_bookmark": bookmark}})


def completed(url="https://download.example/dump.sql"):
    return FakeResponse(payload={"success": True, "result": {
        "status": "complete", "result": {"signed_url": url}}})


def session_for(tmp_path, *, download=None, polls=None):
    if polls is None:
        polls = [completed()]
    return FakeSession(posts=[created(), *polls],
                       download=download or FakeResponse(chunks=[DUMP]))


def settings_for(tmp_path, **overrides):
    return d1b.BackupSettings(
        account_id=ACCOUNT, database_id=DATABASE, root=tmp_path / "backups",
        token=TOKEN, **overrides)


def test_export_endpoint_builds_the_polling_url():
    assert d1b.export_endpoint(ACCOUNT, DATABASE) == (
        "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef"
        "/d1/database/5f3e1c0a-9b2d-4e7a-8c61-1d2e3f4a5b6c/export"
    )


@pytest.mark.parametrize("account,database", [
    ("not-hex", DATABASE),
    (ACCOUNT, "one-mail-db"),
    (ACCOUNT[:-1], DATABASE),
    ("", ""),
])
def test_export_endpoint_rejects_malformed_ids(account, database):
    with pytest.raises(d1b.BackupError) as caught:
        d1b.export_endpoint(account, database)
    assert caught.value.code.startswith("invalid_")


def test_create_export_posts_the_polling_format():
    session = FakeSession(posts=[created("bookmark-1")])
    endpoint = d1b.export_endpoint(ACCOUNT, DATABASE)
    assert d1b.create_export(session, endpoint, TOKEN) == "bookmark-1"
    url, kwargs = session.post_calls[0]
    assert url == endpoint
    assert kwargs["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert kwargs["json"] == {"output_format": "polling"}


def test_create_export_surfaces_transport_and_api_errors():
    endpoint = d1b.export_endpoint(ACCOUNT, DATABASE)
    cases = [
        (FakeResponse(status_code=502, body=b"<html>"), "api_non_json"),
        (FakeResponse(payload={"success": False, "errors": [{"message": "nope"}]}), "api_error"),
        (FakeResponse(payload={"success": True, "result": {}}), "missing_bookmark"),
        (FakeResponse(payload={"success": True, "result": "text"}), "api_missing_result"),
        (FakeResponse(payload={"success": True, "result": {}, "big": "x" * 70000}), "api_response_too_large"),
    ]
    for response, code in cases:
        session = FakeSession(posts=[response])
        with pytest.raises(d1b.BackupError) as caught:
            d1b.create_export(session, endpoint, TOKEN)
        assert caught.value.code == code


def test_wait_for_export_polls_with_a_current_bookmark_body():
    session = FakeSession(posts=[active("b2"), active("b3"), completed()])
    endpoint = d1b.export_endpoint(ACCOUNT, DATABASE)
    export = d1b.wait_for_export(session, endpoint, TOKEN, "b1", sleep=lambda _: None)

    assert export.signed_url == "https://download.example/dump.sql"
    assert export.polls == 3
    bodies = [kwargs["json"] for _url, kwargs in session.post_calls]
    assert bodies == [
        {"output_format": "polling", "current_bookmark": "b1"},
        {"output_format": "polling", "current_bookmark": "b2"},
        {"output_format": "polling", "current_bookmark": "b3"},
    ]
    # A GET is rejected with 405 by the real API, so every poll must POST.
    assert all(url == endpoint for url, _kwargs in session.post_calls)


def test_wait_for_export_reads_the_nested_download_url():
    session = FakeSession(posts=[FakeResponse(payload={"success": True, "result": {
        "status": "complete",
        "signed_url": "https://wrong.example/top-level.sql",
        "result": {"signed_url": "https://right.example/dump.sql"},
    }})])
    export = d1b.wait_for_export(
        session, d1b.export_endpoint(ACCOUNT, DATABASE), TOKEN, "b1", sleep=lambda _: None)
    assert export.signed_url == "https://right.example/dump.sql"


def test_wait_for_export_surfaces_an_error_status():
    session = FakeSession(posts=[FakeResponse(payload={"success": True, "result": {
        "status": "error", "error": "export cancelled"}})])
    with pytest.raises(d1b.BackupError) as caught:
        d1b.wait_for_export(session, d1b.export_endpoint(ACCOUNT, DATABASE), TOKEN, "b1",
                            sleep=lambda _: None)
    assert caught.value.code == "export_failed"
    assert "export cancelled" in str(caught.value)


def test_wait_for_export_rejects_a_complete_status_without_a_url():
    session = FakeSession(posts=[FakeResponse(payload={"success": True, "result": {
        "status": "complete", "result": {}}})])
    with pytest.raises(d1b.BackupError) as caught:
        d1b.wait_for_export(session, d1b.export_endpoint(ACCOUNT, DATABASE), TOKEN, "b1",
                            sleep=lambda _: None)
    assert caught.value.code == "missing_signed_url"


def test_wait_for_export_gives_up_without_sleeping_after_the_last_poll():
    sleeps = []
    session = FakeSession(posts=[active("b2")] * 3)
    with pytest.raises(d1b.BackupError) as caught:
        d1b.wait_for_export(session, d1b.export_endpoint(ACCOUNT, DATABASE), TOKEN, "b1",
                            max_polls=3, sleep=sleeps.append)
    assert caught.value.code == "export_timeout"
    assert sleeps == [d1b.POLL_INTERVAL_SECONDS, d1b.POLL_INTERVAL_SECONDS]


def test_download_dump_streams_gzip_and_hashes_the_artifact(tmp_path):
    session = FakeSession(download=FakeResponse(chunks=[DUMP[:1000], b"", DUMP[1000:]]))
    target = tmp_path / "daily" / "2026-11-07.sql.gz"
    meta = d1b.download_dump(session, "https://download.example/dump.sql", target)

    assert target.read_bytes()[:2] == b"\x1f\x8b"
    assert gzip.decompress(target.read_bytes()) == DUMP
    assert meta["raw_bytes"] == len(DUMP)
    assert meta["bytes"] == target.stat().st_size
    assert len(meta["sha256"]) == 64
    assert not target.with_name(target.name + ".part").exists()
    # The presigned url carries its own signature; no token may be attached.
    assert "headers" not in session.get_calls[0][1]


def test_download_dump_rejects_a_failed_download(tmp_path):
    session = FakeSession(download=FakeResponse(status_code=500, chunks=[b"boom"]))
    target = tmp_path / "daily" / "2026-11-07.sql.gz"
    with pytest.raises(d1b.BackupError) as caught:
        d1b.download_dump(session, "https://download.example/dump.sql", target)
    assert caught.value.code == "download_failed"
    assert not target.exists()
    assert not target.with_name(target.name + ".part").exists()


def test_download_dump_rejects_an_html_error_page(tmp_path):
    session = FakeSession(download=FakeResponse(chunks=[b"<!DOCTYPE html><html>denied"]))
    with pytest.raises(d1b.BackupError) as caught:
        d1b.download_dump(session, "https://download.example/dump.sql",
                          tmp_path / "daily" / "2026-11-07.sql.gz")
    assert caught.value.code == "dump_not_sql"


def test_download_dump_rejects_an_oversize_dump(tmp_path, monkeypatch):
    monkeypatch.setattr(d1b, "MAX_DUMP_BYTES", 100)
    session = FakeSession(download=FakeResponse(chunks=[DUMP]))
    target = tmp_path / "daily" / "2026-11-07.sql.gz"
    with pytest.raises(d1b.BackupError) as caught:
        d1b.download_dump(session, "https://download.example/dump.sql", target)
    assert caught.value.code == "dump_too_large"
    assert not target.exists()


def test_download_dump_rejects_an_empty_dump(tmp_path):
    session = FakeSession(download=FakeResponse(chunks=[b"x"]))
    with pytest.raises(d1b.BackupError) as caught:
        d1b.download_dump(session, "https://download.example/dump.sql",
                          tmp_path / "daily" / "2026-11-07.sql.gz")
    assert caught.value.code == "dump_too_small"


@pytest.mark.parametrize("url", [
    "http://download.example/dump.sql",
    "https://user:pass@download.example/dump.sql",
    "https://localhost/dump.sql",
    "file:///etc/passwd",
])
def test_download_dump_refuses_a_non_https_url(tmp_path, url):
    with pytest.raises(d1b.BackupError) as caught:
        d1b.download_dump(FakeSession(), url, tmp_path / "daily" / "x.sql.gz")
    assert caught.value.code == "insecure_download_url"


def test_run_backup_writes_daily_and_links_weekly_and_monthly(tmp_path):
    settings = settings_for(tmp_path)
    session = session_for(tmp_path)
    result = d1b.run_backup(settings, session=session, now=NOW)

    assert result.ok is True
    root = settings.root
    daily = root / "daily" / "2026-11-07.sql.gz"
    assert daily.exists()
    # 2026-11-07 is an ISO Saturday of week 45.
    assert (root / "weekly" / "2026-W45.sql.gz").exists()
    assert (root / "monthly" / "2026-11.sql.gz").exists()
    assert gzip.decompress(daily.read_bytes()) == DUMP
    assert result.files == ("daily/2026-11-07.sql.gz", "weekly/2026-W45.sql.gz",
                            "monthly/2026-11.sql.gz")
    assert result.polls == 1
    # A second tier entry shares the inode instead of paying for a second copy.
    assert daily.stat().st_ino == (root / "weekly" / "2026-W45.sql.gz").stat().st_ino

    ledger = [json.loads(line) for line in
              (root / "runs.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len(ledger) == 1
    assert ledger[0]["ok"] is True
    assert ledger[0]["files"] == list(result.files)
    assert ledger[0]["sha256"] == result.sha256


def test_run_backup_does_not_relink_an_existing_weekly_snapshot(tmp_path):
    settings = settings_for(tmp_path)
    root = settings.root
    (root / "weekly").mkdir(parents=True)
    (root / "weekly" / "2026-W45.sql.gz").write_bytes(b"earlier")

    result = d1b.run_backup(settings, session=session_for(tmp_path), now=NOW)

    assert result.ok is True
    assert result.files == ("daily/2026-11-07.sql.gz", "monthly/2026-11.sql.gz")
    assert (root / "weekly" / "2026-W45.sql.gz").read_bytes() == b"earlier"


def test_run_backup_records_a_failure_without_leaving_partial_files(tmp_path):
    settings = settings_for(tmp_path)
    session = FakeSession(posts=[FakeResponse(status_code=500, body=b"<html>")])

    result = d1b.run_backup(settings, session=session, now=NOW)

    assert result.ok is False
    assert result.error.startswith("api_non_json")
    assert not any((settings.root / "daily").iterdir())
    ledger = [json.loads(line) for line in
              (settings.root / "runs.jsonl").read_text(encoding="utf-8").splitlines()]
    assert ledger[0]["ok"] is False
    assert ledger[0]["error"] == "api_non_json"


def test_run_backup_refuses_to_start_without_disk_headroom(tmp_path):
    settings = settings_for(tmp_path, min_free_bytes=1 << 50)
    result = d1b.run_backup(settings, session=session_for(tmp_path), now=NOW)
    assert result.ok is False
    assert result.error.startswith("insufficient_disk_space")


def test_prune_keeps_the_newest_snapshots_per_tier(tmp_path):
    daily = tmp_path / "daily"
    daily.mkdir()
    for name in ("2026-11-01.sql.gz", "2026-11-02.sql.gz", "2026-11-03.sql.gz",
                 "notes.txt", "2026-11-04.sql.gz.part"):
        (daily / name).write_bytes(b"x")

    removed = d1b._prune(daily, d1b._DAILY_RE, 2)

    assert (daily / "2026-11-02.sql.gz").exists()
    assert (daily / "2026-11-03.sql.gz").exists()
    assert not (daily / "2026-11-01.sql.gz").exists()
    assert (daily / "notes.txt").exists(), "unrelated files are never touched"
    assert not (daily / "2026-11-04.sql.gz.part").exists(), "stale partials are swept"
    assert removed == ["daily/2026-11-01.sql.gz"]


def test_prune_all_applies_each_tier_budget(tmp_path):
    settings = settings_for(tmp_path, keep_daily=1, keep_weekly=1, keep_monthly=1)
    for tier, names in (
        ("daily", ["2026-11-05.sql.gz", "2026-11-06.sql.gz"]),
        ("weekly", ["2026-W44.sql.gz", "2026-W45.sql.gz"]),
        ("monthly", ["2026-10.sql.gz", "2026-11.sql.gz"]),
    ):
        directory = settings.root / tier
        directory.mkdir(parents=True)
        for name in names:
            (directory / name).write_bytes(b"x")

    removed = d1b._prune_all(settings)

    assert sorted(removed) == ["daily/2026-11-05.sql.gz", "monthly/2026-10.sql.gz",
                              "weekly/2026-W44.sql.gz"]


def test_next_run_at_rolls_to_tomorrow_once_the_slot_has_passed():
    morning = datetime(2026, 11, 7, 2, 0, tzinfo=timezone.utc)
    assert d1b.next_run_at(morning, 3, 10) == datetime(2026, 11, 7, 3, 10, tzinfo=timezone.utc)
    late = datetime(2026, 11, 7, 14, 0, tzinfo=timezone.utc)
    assert d1b.next_run_at(late, 3, 10) == datetime(2026, 11, 8, 3, 10, tzinfo=timezone.utc)
    exact = datetime(2026, 11, 7, 3, 10, tzinfo=timezone.utc)
    assert d1b.next_run_at(exact, 3, 10) == datetime(2026, 11, 8, 3, 10, tzinfo=timezone.utc)


def test_needs_today_tracks_the_daily_artifact(tmp_path):
    settings = settings_for(tmp_path)
    assert d1b.needs_today(settings, NOW) is True
    (settings.root / "daily").mkdir(parents=True)
    (settings.root / "daily" / "2026-11-07.sql.gz").write_bytes(b"x")
    assert d1b.needs_today(settings, NOW) is False


class StopLoop(Exception):
    pass


def test_run_forever_catches_up_immediately_then_waits_for_tomorrow(tmp_path):
    settings = settings_for(tmp_path)
    now = datetime(2026, 11, 7, 14, 0, tzinfo=timezone.utc)
    session = session_for(tmp_path)
    delays = []

    def sleep(seconds):
        delays.append(seconds)
        raise StopLoop

    with pytest.raises(StopLoop):
        d1b.run_forever(settings, session_factory=lambda: session,
                        clock=lambda: now, sleep=sleep)

    assert (settings.root / "daily" / "2026-11-07.sql.gz").exists()
    assert delays == [13 * 3600 + 10 * 60]


def test_run_forever_skips_a_day_that_already_has_a_snapshot(tmp_path):
    settings = settings_for(tmp_path)
    (settings.root / "daily").mkdir(parents=True)
    (settings.root / "daily" / "2026-11-07.sql.gz").write_bytes(b"x")
    now = datetime(2026, 11, 7, 14, 0, tzinfo=timezone.utc)
    session = session_for(tmp_path)
    delays = []

    def sleep(seconds):
        delays.append(seconds)
        raise StopLoop

    with pytest.raises(StopLoop):
        d1b.run_forever(settings, session_factory=lambda: session,
                        clock=lambda: now, sleep=sleep)

    assert session.post_calls == []
    assert delays == [13 * 3600 + 10 * 60]


def write_config(tmp_path, **overrides):
    data = {"account_id": ACCOUNT, "database_id": DATABASE,
            "root": str(tmp_path / "backups")}
    data.update(overrides)
    path = tmp_path / "d1-backup.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def write_token(tmp_path, value=TOKEN, mode=0o600):
    path = tmp_path / "d1-backup.token"
    path.write_text(value, encoding="utf-8")
    os.chmod(path, mode)
    return path


def test_load_settings_reads_targets_retention_and_token(tmp_path):
    path = write_config(tmp_path, keep_daily=3, hour=4, minute=5)
    settings = d1b.load_settings(path, write_token(tmp_path))
    assert settings.account_id == ACCOUNT
    assert settings.database_id == DATABASE
    assert settings.root == tmp_path / "backups"
    assert settings.token == TOKEN
    assert (settings.keep_daily, settings.keep_weekly, settings.keep_monthly) == (
        3, d1b.DEFAULT_KEEP_WEEKLY, d1b.DEFAULT_KEEP_MONTHLY)
    assert (settings.hour, settings.minute) == (4, 5)


@pytest.mark.parametrize("overrides,code", [
    ({"account_id": "nope"}, "invalid_account_id"),
    ({"database_id": "one-mail-db"}, "invalid_database_id"),
    ({"root": "backups"}, "invalid_root"),
    ({"root": "/"}, "invalid_root"),
    ({"keep_daily": 0}, "invalid_config_value"),
    ({"hour": 24}, "invalid_config_value"),
    ({"keep_daily": True}, "invalid_config_value"),
    ({"keep_daily": "7"}, "invalid_config_value"),
    ({"backup_bucket": "x"}, "unknown_config_key"),
])
def test_load_settings_rejects_unsafe_configuration(tmp_path, overrides, code):
    path = write_config(tmp_path, **overrides)
    with pytest.raises(d1b.BackupError) as caught:
        d1b.load_settings(path, write_token(tmp_path))
    assert caught.value.code == code


def test_load_settings_rejects_a_missing_or_oversize_config(tmp_path):
    with pytest.raises(d1b.BackupError) as caught:
        d1b.load_settings(tmp_path / "absent.json", write_token(tmp_path))
    assert caught.value.code == "config_missing"

    path = tmp_path / "d1-backup.json"
    path.write_bytes(b"{" + b"x" * d1b.MAX_CONFIG_BYTES + b"}")
    with pytest.raises(d1b.BackupError) as caught:
        d1b.load_settings(path, write_token(tmp_path))
    assert caught.value.code == "config_too_large"


def test_read_token_rejects_short_and_non_printable_values(tmp_path):
    for value in ("short", TOKEN + "\nsecond", TOKEN[:10] + " " + TOKEN[10:]):
        with pytest.raises(d1b.BackupError) as caught:
            d1b._read_token(write_token(tmp_path, value=value))
        assert caught.value.code == "token_invalid"


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits only")
def test_read_token_refuses_group_or_world_readable_files(tmp_path):
    with pytest.raises(d1b.BackupError) as caught:
        d1b._read_token(write_token(tmp_path, mode=0o644))
    assert caught.value.code == "token_file_permissions"
    assert d1b._read_token(write_token(tmp_path, mode=0o400)) == TOKEN
