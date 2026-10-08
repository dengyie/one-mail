import json

import pytest
import requests
import responses
from one_mail_agg.uploader import UploadBatchError, upload_emails, upload_folders
from one_mail_agg.config import Config


def cfg():
    return Config(worker_base_url="https://w.example", admin_token="tok", accounts=[])


@responses.activate
def test_upload_posts_to_ingest():
    responses.add(responses.POST, "https://w.example/admin/unified/ingest",
                  json={"inserted": 1, "skipped": 0}, status=200)
    out = upload_emails(cfg(), [{"id": "x", "source": "imap_qq"}])
    assert out["inserted"] == 1
    assert responses.calls[0].request.headers["x-admin-auth"] == "tok"


@responses.activate
def test_upload_retries_on_500():
    responses.add(responses.POST, "https://w.example/admin/unified/ingest", status=500)
    responses.add(responses.POST, "https://w.example/admin/unified/ingest",
                  json={"inserted": 1}, status=200)
    out = upload_emails(cfg(), [{"id": "x"}], max_retries=3)
    assert out["inserted"] == 1
    assert len(responses.calls) == 2


@responses.activate
def test_upload_folders_uses_same_ingest_endpoint():
    responses.add(responses.POST, "https://w.example/admin/unified/ingest",
                  json={"inserted": 0, "skipped": 0, "folders_upserted": 1}, status=200)
    folder = {
        "account_id": "a", "provider": "imap", "canonical_name": "Empty",
        "display_name": "Empty",
    }
    out = upload_folders(cfg(), [folder])
    assert out == {"folders_upserted": 1}
    req = responses.calls[0].request
    assert req.headers["x-admin-auth"] == "tok"
    body = req.body.decode("utf-8") if isinstance(req.body, bytes) else str(req.body)
    assert '"folders"' in body
    assert '"canonical_name": "Empty"' in body


@responses.activate
def test_upload_folders_retries_on_transient_failure():
    responses.add(responses.POST, "https://w.example/admin/unified/ingest", status=503)
    responses.add(responses.POST, "https://w.example/admin/unified/ingest",
                  json={"folders_upserted": 1}, status=200)
    out = upload_folders(
        cfg(),
        [{"account_id": "a", "provider": "graph", "canonical_name": "Archive"}],
        max_retries=2,
    )
    assert out["folders_upserted"] == 1
    assert len(responses.calls) == 2


@pytest.mark.parametrize("kind,upload", [("emails", upload_emails), ("folders", upload_folders)])
@responses.activate
def test_daily_d1_quota_is_not_retried_inside_the_same_batch(monkeypatch, kind, upload):
    from datetime import datetime, timezone
    monkeypatch.setattr("one_mail_agg.uploader.time.sleep", lambda _: None)
    now = datetime(2026, 10, 8, 12, tzinfo=timezone.utc).timestamp()
    monkeypatch.setattr("one_mail_agg.uploader.time.time", lambda: now)
    responses.add(responses.POST, "https://w.example/admin/unified/ingest", status=503,
                  json={"code": "D1_DAILY_WRITE_LIMIT", "retry_at": "2026-10-09T00:00:00.000Z",
                        "error": "Database daily write quota exhausted"},
                  headers={"Retry-After": "43200"})
    with pytest.raises(UploadBatchError) as caught:
        upload(cfg(), [{"id": "retained", "account_id": "a"}], max_retries=5)
    assert len(responses.calls) == 1
    assert caught.value.result == ({"inserted": 0, "skipped": 0} if kind == "emails" else {"folders_upserted": 0})


def _sharded_config():
    return Config("https://w.example", "tok", [], shards=[
        {"id": "s1", "base_url": "https://s1.example", "token": "1" * 32, "accounts": ["a"]},
        {"id": "s2", "base_url": "https://s2.example", "token": "2" * 32, "accounts": ["b"]},
    ])


@pytest.mark.parametrize("kind,upload,counter", [("emails", upload_emails, "inserted"), ("folders", upload_folders, "folders_upserted")])
@responses.activate
def test_quota_failure_stops_its_destination_but_still_uploads_to_healthy_shards(monkeypatch, kind, upload, counter):
    from datetime import datetime, timezone
    from one_mail_agg.uploader import quota_retry_at
    now = datetime(2026, 10, 8, 12, tzinfo=timezone.utc).timestamp()
    monkeypatch.setattr("one_mail_agg.uploader.time.time", lambda: now)
    responses.add(responses.POST, "https://s1.example/shard/ingest", status=503,
                  json={"code": "D1_DAILY_WRITE_LIMIT", "retry_at": "2026-10-09T00:00:00.000Z"})
    for url in ["https://s2.example/shard/ingest", "https://w.example/admin/unified/ingest"]:
        responses.add(responses.POST, url, json={counter: 1})

    with pytest.raises(UploadBatchError) as caught:
        upload(_sharded_config(), [{"account_id": "a"}, {"account_id": "a"},
                                   {"account_id": "b"}, {"account_id": "unknown"}], chunk_size=1)

    assert len(responses.calls) == 3
    assert caught.value.result[counter] == 2
    assert quota_retry_at(caught.value) == now + 43200
    assert len(caught.value.failures) == 1


@responses.activate
def test_mixed_email_routing_groups_then_chunks_and_sums_counts():
    for url in ["https://w.example/admin/unified/ingest",
                "https://s1.example/shard/ingest", "https://s2.example/shard/ingest"]:
        responses.add_callback(responses.POST, url, callback=lambda request: (
            200, {}, json.dumps({"inserted": len(json.loads(request.body)["emails"]), "skipped": 1})))
    emails = [{"id": "a1", "account_id": "a", "source": "imap_custom"},
              {"id": "local", "account_id": "unknown"},
              {"id": "b1", "account_id": "b"},
              {"id": "a2", "account_id": "a"},
              {"id": "cf", "account_id": "a", "source": "cf_routing"},
              {"id": "no-account"}]
    config = _sharded_config()
    assert upload_emails(config, emails, chunk_size=2) == {"inserted": 6, "skipped": 4}
    ids_by_url = {}
    for call in responses.calls:
        req = call.request
        batch = json.loads(req.body)["emails"]
        assert len(batch) <= 2
        ids_by_url.setdefault(req.url, []).extend(row["id"] for row in batch)
        if "w.example/" in req.url:
            assert req.headers["x-admin-auth"] == "tok"
            assert "Authorization" not in req.headers
        else:
            assert req.headers["Authorization"] == "Bearer " + ("1" if "s1" in req.url else "2") * 32
            assert "x-admin-auth" not in req.headers
    assert ids_by_url == {"https://s1.example/shard/ingest": ["a1", "a2"],
                          "https://s2.example/shard/ingest": ["b1"],
                          "https://w.example/admin/unified/ingest": ["local", "cf", "no-account"]}
    assert config.worker_base_url == "https://w.example" and config.admin_token == "tok"


@responses.activate
def test_mixed_folder_catalog_routing_including_cf_routing():
    rows = [{"account_id": "a"}, {"account_id": "b"}, {"account_id": "unassigned"},
            {"account_id": "a", "source": "cf_routing"}]
    for url, count in [("https://w.example/admin/unified/ingest", 2),
                       ("https://s1.example/shard/ingest", 1), ("https://s2.example/shard/ingest", 1)]:
        responses.add(responses.POST, url, json={"folders_upserted": count})
    assert upload_folders(_sharded_config(), rows) == {"folders_upserted": 4}
    assert json.loads(responses.calls[2].request.body)["folders"] == rows[2:]
    assert responses.calls[0].request.headers["Authorization"] == "Bearer " + "1" * 32


@pytest.mark.parametrize("kind,upload", [("emails", upload_emails), ("folders", upload_folders)])
@pytest.mark.parametrize("unavailable", ["primary", "s1"])
@responses.activate
def test_unavailable_destination_does_not_starve_other_uploads(kind, upload, unavailable):
    urls = {"primary": "https://w.example/admin/unified/ingest",
            "s1": "https://s1.example/shard/ingest", "s2": "https://s2.example/shard/ingest"}
    for destination, url in urls.items():
        if destination == unavailable:
            responses.add(responses.POST, url, body=requests.ConnectionError("unavailable"))
        else:
            responses.add(responses.POST, url, json={"inserted": 1, "folders_upserted": 1})
    with pytest.raises(RuntimeError, match=unavailable):
        upload(_sharded_config(), [{"account_id": "unknown"}, {"account_id": "a"},
                                   {"account_id": "b"}], max_retries=1)
    assert {call.request.url for call in responses.calls} == set(urls.values())


@responses.activate
def test_shard_retry_keeps_destination_and_auth(monkeypatch):
    monkeypatch.setattr("one_mail_agg.uploader.time.sleep", lambda _: None)
    responses.add(responses.POST, "https://s1.example/shard/ingest", status=503)
    responses.add(responses.POST, "https://s1.example/shard/ingest", json={"inserted": 1})
    assert upload_emails(_sharded_config(), [{"account_id": "a"}], max_retries=2)["inserted"] == 1
    assert len(responses.calls) == 2
    assert all(call.request.headers["Authorization"] == "Bearer " + "1" * 32
               for call in responses.calls)


@pytest.mark.parametrize("kind,upload,counters", [
    ("emails", upload_emails, {"inserted": 1, "skipped": 0}),
    ("folders", upload_folders, {"folders_upserted": 1}),
])
def test_partial_chunks_retain_causes_service_other_destinations_and_retry_all(
        monkeypatch, kind, upload, counters):
    config = _sharded_config()
    rows = [{"id": "a1", "account_id": "a"}, {"id": "a2", "account_id": "a"},
            {"id": "a3", "account_id": "a"}, {"id": "local"},
            {"id": "b1", "account_id": "b"}]
    root_error = requests.Timeout("private transport detail")
    http_response = requests.Response()
    http_response.status_code = 503
    calls = []
    failing = True

    def fake_post(url, **kwargs):
        chunk = kwargs["json"][kind]
        assert len(chunk) == 1
        calls.append((url, chunk[0]["id"]))
        if failing and chunk[0]["id"] == "a2":
            raise root_error
        if failing and chunk[0]["id"] == "b1":
            return http_response
        response = requests.Response()
        response.status_code = 200
        response._content = json.dumps(counters).encode()
        return response

    monkeypatch.setattr("one_mail_agg.uploader.requests.post", fake_post)
    with pytest.raises(UploadBatchError) as caught:
        upload(config, rows, max_retries=1, chunk_size=1)
    error = caught.value
    assert error.result == {key: value * 2 for key, value in counters.items()}
    assert error.failures[0] == (f"s1: 1 {kind}", root_error)
    assert error.__cause__ is root_error
    assert error.failures[1][0] == f"s2: 1 {kind}"
    assert isinstance(error.failures[1][1], requests.HTTPError)
    assert error.failures[1][1].response is http_response
    assert "private" not in str(error)
    assert [row_id for _, row_id in calls] == ["a1", "a2", "local", "b1"]

    failing = False
    calls.clear()
    assert upload(config, rows, max_retries=1, chunk_size=1) == {
        key: value * len(rows) for key, value in counters.items()}
    assert [row_id for _, row_id in calls] == ["a1", "a2", "a3", "local", "b1"]


@pytest.mark.parametrize("upload,counter", [(upload_emails, "inserted"),
                                           (upload_folders, "folders_upserted")])
@responses.activate
def test_default_chunk_sizes_are_bounded_per_destination(upload, counter):
    bound = 15 if upload is upload_emails else 100
    for url in ["https://w.example/admin/unified/ingest",
                "https://s1.example/shard/ingest", "https://s2.example/shard/ingest"]:
        responses.add(responses.POST, url, json={counter: 1})
    rows = [{"account_id": account_id} for _ in range(bound + 1)
            for account_id in ["a", "b", "unknown"]]
    upload(_sharded_config(), rows)
    kind = "emails" if upload is upload_emails else "folders"
    assert len(responses.calls) == 6
    assert [len(json.loads(call.request.body)[kind]) for call in responses.calls] == [bound, 1] * 3


@responses.activate
def test_malformed_success_counters_do_not_double_count_retry(monkeypatch):
    monkeypatch.setattr("one_mail_agg.uploader.time.sleep", lambda _: None)
    responses.add(responses.POST, "https://s1.example/shard/ingest",
                  json={"inserted": 7, "skipped": "not-a-count"})
    responses.add(responses.POST, "https://s1.example/shard/ingest",
                  json={"inserted": 0, "skipped": 1})
    assert upload_emails(_sharded_config(), [{"account_id": "a"}], max_retries=2) == {
        "inserted": 0, "skipped": 1}
    assert len(responses.calls) == 2
