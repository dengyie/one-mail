import responses
from one_mail_agg.uploader import upload_emails
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