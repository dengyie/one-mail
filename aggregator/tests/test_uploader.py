import responses
from one_mail_agg.uploader import upload_emails, upload_folders
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
    assert b'"folders"' in req.body
    assert b'"canonical_name": "Empty"' in req.body


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
