"""D0 telemetry contracts: no production credentials or API calls."""
import asyncio
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
import json
import sqlite3

import pytest

from one_mail_agg import fleet_metrics as metrics


NOW = datetime(2026, 10, 8, 12, tzinfo=timezone.utc)
ACCOUNT_ID = "a" * 32
DB_A = "11111111-1111-1111-1111-111111111111"
DB_B = "22222222-2222-2222-2222-222222222222"
ACCOUNT = metrics.AccountConfig("main", ACCOUNT_ID, "env:CF_METRICS_TOKEN", (
    metrics.DatabaseConfig("primary", DB_A), metrics.DatabaseConfig("secondary", DB_B),
))


def graphql(dataset, sums, account_id=ACCOUNT_ID):
    return {"data": {"viewer": {"accounts": [{"accountTag": account_id, dataset: [{"sum": sums}]}]}}}


class FakeTransport:
    def __init__(self):
        self.calls = []
        self.reads = 101
        self.writes = 22
        self.requests = 44
        self.failures = {}
        self.delay = 0
        self.active = 0
        self.maximum_active = 0
        self.cancelled = 0

    async def request(self, account, path, payload, timeout):
        self.calls.append((account.account_key, path, payload))
        self.active += 1
        self.maximum_active = max(self.active, self.maximum_active)
        key = "d1" if payload and "d1Analytics" in payload["query"] else "workers" if payload else path.rsplit("/", 1)[1]
        try:
            await asyncio.sleep(self.delay)
            failure = self.failures.get(key)
            if isinstance(failure, Exception):
                raise failure
            if failure is not None:
                return failure
            if key == "d1":
                return graphql("d1AnalyticsAdaptiveGroups", {"rowsRead": self.reads, "rowsWritten": self.writes}, account.provider_account_id)
            if key == "workers":
                return graphql("workersInvocationsAdaptive", {"requests": self.requests}, account.provider_account_id)
            return {"success": True, "errors": [], "result": {"uuid": key, "file_size": 1000 if key == DB_A else 2000}}
        except asyncio.CancelledError:
            self.cancelled += 1
            raise
        finally:
            self.active -= 1


def sample(now=NOW, reads=101, writes=22, requests=44):
    return metrics.MetricSnapshot("main", now.date().isoformat(), metrics._iso(now),
                                  "cloudflare-account-api", reads, writes, requests,
                                  "authoritative", {"primary": 1000, "secondary": 2000})


@pytest.fixture
def history(tmp_path):
    private = tmp_path / "metrics"
    private.mkdir(mode=0o700)
    return private / "history.sqlite"


def record(path, item, now=None):
    return metrics.record_history(path, [item], now or metrics._parse_instant(item.observed_at))[0]


def config_value():
    return {"v": 1, "accounts": [asdict(ACCOUNT)]}


def test_config_has_only_refs_and_rejects_duplicate_account_quota():
    value = config_value()
    value["accounts"][0]["databases"] = list(value["accounts"][0]["databases"])
    parsed = metrics.parse_config(value)
    assert parsed.accounts == (ACCOUNT,)
    assert value["accounts"][0]["credential_ref"] == "env:CF_METRICS_TOKEN"
    value["accounts"].append({**value["accounts"][0], "account_key": "second-label"})
    with pytest.raises(metrics.MetricsError, match="DUPLICATE_ACCOUNT"):
        metrics.parse_config(value)


@pytest.mark.parametrize("field,value,code", [
    ("provider_account_id", "https://evil.example", "INVALID_PROVIDER_ACCOUNT_ID"),
    ("credential_ref", "secret-token-value", "INVALID_CREDENTIAL_REF"),
    ("credential_ref", "env:TOKEN\r\nX-Header: injected", "INVALID_CREDENTIAL_REF"),
    ("account_key", "../other", "INVALID_ACCOUNT_KEY"),
])
def test_invalid_config_rejected(field, value, code):
    raw = config_value()
    raw["accounts"][0][field] = value
    with pytest.raises(metrics.MetricsError, match=code):
        metrics.parse_config(raw)


def test_two_databases_share_one_account_counter_and_have_individual_sizes():
    transport = FakeTransport()
    result, = asyncio.run(metrics.collect(metrics.CollectorConfig((ACCOUNT,)), transport, NOW))
    assert result.rows_read == 101
    assert result.rows_written == 22
    assert result.worker_requests == 44
    assert result.shard_sizes == {"primary": 1000, "secondary": 2000}
    assert result.confidence == "authoritative"
    assert len(transport.calls) == 4
    assert "databaseId" not in transport.calls[0][2]["query"]
    assert not result.allocation_eligible


@pytest.mark.parametrize("failure,code", [
    ({"errors": [{"message": "token-secret should never reach output"}]}, "GRAPHQL_FAILURE"),
    ({"data": {"viewer": {"accounts": []}}}, "ACCOUNT_METRICS_MISSING"),
    (graphql("d1AnalyticsAdaptiveGroups", {"rowsRead": None, "rowsWritten": 1}), "INVALID_ROWSREAD"),
    (graphql("d1AnalyticsAdaptiveGroups", {"rowsRead": True, "rowsWritten": 1}), "INVALID_ROWSREAD"),
    (graphql("d1AnalyticsAdaptiveGroups", {"rowsRead": 1.5, "rowsWritten": 1}), "INVALID_ROWSREAD"),
    (graphql("d1AnalyticsAdaptiveGroups", {"rowsRead": -1, "rowsWritten": 1}), "INVALID_ROWSREAD"),
    (graphql("d1AnalyticsAdaptiveGroups", {"rowsRead": 2**53, "rowsWritten": 1}), "INVALID_ROWSREAD"),
    (graphql("d1AnalyticsAdaptiveGroups", {"rowsRead": 1}), "INVALID_ANALYTICS_SCHEMA"),
])
def test_bad_analytics_remains_unknown_while_other_sources_collect(failure, code):
    transport = FakeTransport()
    transport.failures["d1"] = failure
    result, = asyncio.run(metrics.collect(metrics.CollectorConfig((ACCOUNT,)), transport, NOW))
    assert result.rows_read is None and result.rows_written is None
    assert result.worker_requests == 44
    assert len(result.shard_sizes) == 2
    assert result.confidence == "partial"
    assert result.issues == ("d1:" + code,)
    assert "token-secret" not in json.dumps(asdict(result))


def test_explicit_empty_aggregate_is_zero_but_missing_field_is_unknown():
    value = {"data": {"viewer": {"accounts": [{"accountTag": ACCOUNT_ID, "d1AnalyticsAdaptiveGroups": []}]}}}
    assert metrics._analytics(value, ACCOUNT_ID, "d1AnalyticsAdaptiveGroups", ("rowsRead", "rowsWritten")) == (0, 0)
    del value["data"]["viewer"]["accounts"][0]["d1AnalyticsAdaptiveGroups"]
    with pytest.raises(metrics.MetricsError, match="INVALID_ANALYTICS_SCHEMA"):
        metrics._analytics(value, ACCOUNT_ID, "d1AnalyticsAdaptiveGroups", ("rowsRead",))


def test_partial_size_failure_preserves_other_database_and_denies_allocation(history):
    transport = FakeTransport()
    transport.failures[DB_B] = metrics.MetricsError("REQUEST_TIMEOUT")
    result, = asyncio.run(metrics.collect(metrics.CollectorConfig((ACCOUNT,)), transport, NOW))
    assert result.shard_sizes == {"primary": 1000}
    assert result.issues == ("size:secondary:REQUEST_TIMEOUT",)
    assert not record(history, result).allocation_eligible


def test_account_timeout_cancels_io_and_leaves_unknown_counters():
    transport = FakeTransport()
    transport.delay = 10
    result, = asyncio.run(metrics.collect(metrics.CollectorConfig((ACCOUNT,), account_timeout_seconds=1), transport, NOW))
    assert result.rows_read is None
    assert result.worker_requests is None
    assert result.issues == ("ACCOUNT_TIMEOUT",)
    assert transport.cancelled == 1 and transport.active == 0


def test_concurrency_is_bounded_and_calling_task_cancellation_drains_children():
    transport = FakeTransport()
    transport.delay = 10
    accounts = tuple(replace(ACCOUNT, account_key=f"account-{i}") for i in range(12))

    async def exercise():
        task = asyncio.create_task(metrics.collect(metrics.CollectorConfig(accounts), transport, NOW))
        while len(transport.calls) < 4:
            await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert transport.active == 0

    asyncio.run(exercise())
    assert transport.maximum_active == 4
    assert transport.cancelled == 4


def test_three_distinct_contiguous_buckets_required_and_duplicates_do_not_count(history):
    first = record(history, sample())
    assert first.consecutive_valid_samples == 1 and not first.allocation_eligible
    duplicate = record(history, sample(NOW + timedelta(seconds=30)))
    assert duplicate.consecutive_valid_samples == 1 and not duplicate.allocation_eligible
    second = record(history, sample(NOW + timedelta(minutes=5)))
    assert second.consecutive_valid_samples == 2 and not second.allocation_eligible
    third = record(history, sample(NOW + timedelta(minutes=10)))
    assert third.consecutive_valid_samples == 3 and third.allocation_eligible
    gap = record(history, sample(NOW + timedelta(minutes=20)))
    assert gap.consecutive_valid_samples == 1 and not gap.allocation_eligible


def test_partial_sample_breaks_consecutive_chain(history):
    record(history, sample())
    partial = replace(sample(NOW + timedelta(minutes=5)), confidence="partial", issues=("d1:REQUEST_TIMEOUT",), rows_read=None)
    record(history, partial)
    result = record(history, sample(NOW + timedelta(minutes=10)))
    assert result.consecutive_valid_samples == 1 and not result.allocation_eligible


def test_regression_stays_invalid_until_highwater_recovered(history):
    record(history, sample(reads=1000))
    regressed = record(history, sample(NOW + timedelta(minutes=5), reads=100))
    assert regressed.confidence == "partial" and "COUNTER_REGRESSION" in regressed.issues
    still_low = record(history, sample(NOW + timedelta(minutes=10), reads=500))
    assert "COUNTER_REGRESSION" in still_low.issues
    recovered = record(history, sample(NOW + timedelta(minutes=15), reads=1001))
    assert recovered.confidence == "authoritative" and recovered.consecutive_valid_samples == 1


def test_regression_inside_same_bucket_does_not_erase_highwater(history):
    record(history, sample(reads=1000))
    record(history, sample(NOW + timedelta(seconds=30), reads=100))
    result = record(history, sample(NOW + timedelta(minutes=5), reads=500))
    assert "COUNTER_REGRESSION" in result.issues


def test_utc_midnight_resets_counters_and_streak(history):
    before = datetime(2026, 10, 8, 23, 55, tzinfo=timezone.utc)
    record(history, sample(before, reads=100000))
    after = before + timedelta(minutes=5)
    result = record(history, sample(after, reads=0, writes=0, requests=0))
    assert result.confidence == "authoritative" and not result.issues
    assert result.consecutive_valid_samples == 1


@pytest.mark.parametrize("delta", [timedelta(minutes=16), timedelta(seconds=-1)])
def test_expired_or_future_samples_are_stale(history, delta):
    result = record(history, sample(), NOW + delta)
    assert result.confidence == "stale" and not result.allocation_eligible


def test_sample_completed_across_midnight_is_stale(history):
    started = datetime(2026, 10, 8, 23, 59, 59, tzinfo=timezone.utc)
    result = record(history, sample(started), started + timedelta(seconds=2))
    assert result.confidence == "stale"


def test_timezone_conversion_and_naive_time_rejection():
    local = datetime(2026, 10, 9, 7, 55, tzinfo=timezone(timedelta(hours=8)))
    transport = FakeTransport()
    result, = asyncio.run(metrics.collect(metrics.CollectorConfig((ACCOUNT,)), transport, local))
    assert result.utc_date == "2026-10-08"
    assert result.observed_at == "2026-10-08T23:55:00Z"
    query = transport.calls[1][2]["query"]
    assert '"2026-10-08T00:00:00Z"' in query
    assert '"2026-10-09T00:00:00Z"' in query
    with pytest.raises(metrics.MetricsError, match="TIMEZONE_REQUIRED"):
        asyncio.run(metrics.collect(metrics.CollectorConfig((ACCOUNT,)), transport, NOW.replace(tzinfo=None)))


def test_history_prunes_old_days_and_remains_private(history):
    for age in range(10, -1, -1):
        moment = NOW - timedelta(days=age)
        record(history, sample(moment))
    with sqlite3.connect(history) as connection:
        rows = connection.execute("SELECT utc_date FROM fleet_samples ORDER BY utc_date").fetchall()
    assert len(rows) == 8
    assert rows[0][0] == "2026-10-01"
    assert history.stat().st_mode & 0o777 == 0o600


def test_history_refuses_shared_directory_and_symlinks(history, tmp_path):
    history.parent.chmod(0o755)
    with pytest.raises(metrics.MetricsError, match="PRIVATE_HISTORY_DIRECTORY_REQUIRED"):
        record(history, sample())
    history.parent.chmod(0o700)
    target = tmp_path / "secret"
    target.write_text("unrelated", encoding="utf-8")
    history.symlink_to(target)
    with pytest.raises(metrics.MetricsError, match="PRIVATE_HISTORY_DIRECTORY_REQUIRED"):
        record(history, sample())
    assert target.read_text() == "unrelated"


def test_delayed_same_bucket_sample_cannot_replace_newer_report(history):
    record(history, sample(NOW + timedelta(seconds=30), reads=100))
    with pytest.raises(metrics.MetricsError, match="OUT_OF_ORDER_SAMPLE"):
        record(history, sample(NOW, reads=101))
    with sqlite3.connect(history) as connection:
        stored, = connection.execute("SELECT payload FROM fleet_samples").fetchone()
    assert json.loads(stored)["observed_at"] == "2026-10-08T12:00:30Z"


async def parse_response(raw):
    reader = asyncio.StreamReader(limit=32 * 1024)
    reader.feed_data(raw)
    reader.feed_eof()
    return await metrics._read_response(reader)


@pytest.mark.parametrize("framing", ["length", "chunked", "close"])
def test_async_http_body_framing(framing):
    body = b'{"success":true}'
    if framing == "length":
        raw = b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
    elif framing == "chunked":
        raw = b"Transfer-Encoding: chunked\r\n\r\n" + format(len(body), "x").encode() + b"\r\n" + body + b"\r\n0\r\n\r\n"
    else:
        raw = b"\r\n" + body
    result = asyncio.run(parse_response(b"HTTP/1.1 200 OK\r\n" + raw))
    assert result == {"success": True}


def test_repeated_non_framing_http_headers_are_legal():
    raw = (b"HTTP/1.1 200 OK\r\nSet-Cookie: a=one\r\nSet-Cookie: b=two\r\n"
           b"Server-Timing: first;dur=1\r\nServer-Timing: second;dur=2\r\n"
           b"Content-Length: 2\r\n\r\n{}")
    assert asyncio.run(parse_response(raw)) == {}


@pytest.mark.parametrize("header,value", [(b"Content-Length", b"2"), (b"Transfer-Encoding", b"chunked"), (b"Content-Encoding", b"identity")])
def test_duplicate_framing_headers_remain_rejected(header, value):
    raw = b"HTTP/1.1 200 OK\r\n" + header + b": " + value + b"\r\n" + header + b": " + value + b"\r\n\r\n{}"
    with pytest.raises(metrics.MetricsError, match="INVALID_HTTP_HEADERS"):
        asyncio.run(parse_response(raw))


@pytest.mark.parametrize("raw,code", [
    (b"HTTP/1.1 302 Found\r\nLocation: https://evil.example\r\n\r\n", "HTTP_302"),
    (b"HTTP/1.1 200 OK\r\nContent-Length: 99999999\r\n\r\n", "RESPONSE_TOO_LARGE"),
    (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\n", "INVALID_HTTP_FRAMING"),
    (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n", "INVALID_HTTP_CHUNK"),
    (b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\n", "UNSUPPORTED_HTTP_ENCODING"),
    (b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nnull", None),
])
def test_async_http_rejects_redirects_oversize_and_ambiguous_framing(raw, code):
    if code is None:
        assert asyncio.run(parse_response(raw)) is None
    else:
        with pytest.raises(metrics.MetricsError, match=code):
            asyncio.run(parse_response(raw))


def test_transport_timeout_includes_dns_and_preserves_cause(monkeypatch):
    async def stuck_connection(*args, **kwargs):
        await asyncio.sleep(100)
    monkeypatch.setattr(metrics.asyncio, "open_connection", stuck_connection)
    transport = metrics.CloudflareTransport({"CF_METRICS_TOKEN": "private-secret"})
    with pytest.raises(metrics.MetricsError, match="REQUEST_TIMEOUT") as error:
        asyncio.run(transport.request(ACCOUNT, "/client/v4/graphql", {}, 0.01))
    assert isinstance(error.value.__cause__, TimeoutError)
    assert "private-secret" not in str(error.value)


def test_transport_does_not_open_socket_without_credentials(monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("missing credentials must fail before network")
    monkeypatch.setattr(metrics.asyncio, "open_connection", forbidden)
    with pytest.raises(metrics.MetricsError, match="CREDENTIAL_UNAVAILABLE"):
        asyncio.run(metrics.CloudflareTransport({}).request(ACCOUNT, "/client/v4/graphql", {}, 1))


def test_historical_reconciliation_reads_complete_day_but_cannot_allocate(history):
    yesterday = NOW.date() - timedelta(days=1)
    transport = FakeTransport()
    result, = asyncio.run(metrics.collect(metrics.CollectorConfig((ACCOUNT,)), transport, NOW, yesterday))
    assert result.utc_date == "2026-10-07"
    assert 'date_leq: "2026-10-07"' in transport.calls[0][2]["query"]
    assert 'datetime_lt: "2026-10-08T00:00:00Z"' in transport.calls[1][2]["query"]
    persisted = record(history, result, NOW)
    assert persisted.confidence == "stale" and not persisted.allocation_eligible
    with sqlite3.connect(history) as connection:
        bucket, = connection.execute("SELECT bucket FROM fleet_samples").fetchone()
    expected = datetime(2026, 10, 7, 23, 55, tzinfo=timezone.utc)
    assert bucket == int(expected.timestamp()) // 300


def test_out_of_retention_or_future_collection_is_rejected_before_io():
    transport = FakeTransport()
    for days in (-8, 1):
        with pytest.raises(metrics.MetricsError, match="INVALID_METRIC_DATE"):
            asyncio.run(metrics.collect(metrics.CollectorConfig((ACCOUNT,)), transport, NOW, NOW.date() + timedelta(days=days)))
    assert not transport.calls


def test_historical_reconciliation_reuses_final_bucket(history):
    yesterday = NOW.date() - timedelta(days=1)
    first = replace(sample(), utc_date=yesterday.isoformat())
    record(history, first, NOW)
    later = replace(sample(NOW + timedelta(minutes=5)), utc_date=yesterday.isoformat())
    record(history, later, NOW + timedelta(minutes=5))
    with sqlite3.connect(history) as connection:
        assert connection.execute("SELECT count(*) FROM fleet_samples").fetchone()[0] == 1


def test_history_is_atomic_if_later_account_fails_validation(history):
    broken = replace(sample(), account_key="other", rows_read=-1)
    with pytest.raises(metrics.MetricsError, match="INVALID_COUNTER"):
        metrics.record_history(history, (sample(), broken), NOW)
    record(history, sample())
    with sqlite3.connect(history) as connection:
        assert connection.execute("SELECT count(*) FROM fleet_samples").fetchone()[0] == 1


def test_history_open_error_has_stable_code_and_original_cause(history, monkeypatch):
    def unavailable(*args, **kwargs):
        raise sqlite3.OperationalError("filesystem unavailable")
    monkeypatch.setattr(metrics.sqlite3, "connect", unavailable)
    with pytest.raises(metrics.MetricsError, match="HISTORY_OPEN_FAILED") as error:
        record(history, sample())
    assert isinstance(error.value.__cause__, sqlite3.OperationalError)


def test_missing_counters_never_become_authoritative_in_history(history):
    result = record(history, replace(sample(), rows_read=None))
    assert result.confidence == "partial" and "MISSING_METRICS" in result.issues
    assert not result.allocation_eligible


def test_size_api_cannot_cross_associate_another_database():
    with pytest.raises(metrics.MetricsError, match="DATABASE_ID_MISMATCH"):
        metrics._size({"success": True, "result": {"uuid": DB_B, "file_size": 1}}, DB_A)


def test_transport_closes_socket_on_cancellation(monkeypatch):
    class Writer:
        closed = False
        aborted = False
        @property
        def transport(self):
            return self
        def write(self, data):
            assert b"Authorization: Bearer private-secret\r\n" in data
        async def drain(self):
            return None
        def close(self):
            self.closed = True
        def abort(self):
            self.aborted = True

    writer = Writer()

    async def connection(*args, **kwargs):
        return asyncio.StreamReader(), writer

    monkeypatch.setattr(metrics.asyncio, "open_connection", connection)

    async def exercise():
        transport = metrics.CloudflareTransport({"CF_METRICS_TOKEN": "private-secret"})
        task = asyncio.create_task(transport.request(ACCOUNT, "/client/v4/graphql", {}, 10))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert writer.closed and writer.aborted

    asyncio.run(exercise())


def test_cli_exit_codes_and_sanitized_output(monkeypatch, capsys):
    async def good(*args):
        return (sample(),)
    monkeypatch.setattr(metrics, "_run", good)
    assert metrics.main(["--config", "config.json", "--history", "history.sqlite"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["mode"] == "observe"
    assert report["accounts"][0]["rows_read"] == 101

    async def partial(*args):
        return (replace(sample(), confidence="partial"),)
    monkeypatch.setattr(metrics, "_run", partial)
    assert metrics.main(["--config", "config.json", "--history", "history.sqlite"]) == 2
    capsys.readouterr()

    async def failed(*args):
        raise metrics.MetricsError("CREDENTIAL_UNAVAILABLE") from ValueError("private-secret")
    monkeypatch.setattr(metrics, "_run", failed)
    assert metrics.main(["--config", "config.json", "--history", "history.sqlite"]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert json.loads(captured.err) == {"error_code": "CREDENTIAL_UNAVAILABLE"}
    assert "private-secret" not in captured.err
