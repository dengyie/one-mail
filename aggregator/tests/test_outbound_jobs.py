import json

import pytest
import requests
from imapclient.exceptions import IMAPClientAbortError, IMAPClientError

import one_mail_agg.outbound_jobs as outbound
from one_mail_agg.config import AccountConfig, Config


def _config(accounts=None):
    return Config(
        worker_base_url="https://worker.example",
        admin_token="admin-token",
        accounts=accounts or [],
        state_path="state.json",
    )


def _account(source="imap_qq", can_send=True, **overrides):
    kwargs = {
        "id": "acc-1",
        "source": source,
        "host": "imap.example.com",
        "port": 993,
        "username": "user@example.com",
        "password": "app-password",
        "use_ssl": True,
        "can_send": can_send,
    }
    kwargs.update(overrides)
    return AccountConfig(**kwargs)


def _job(**overrides):
    job = {
        "id": "job-1",
        "account_id": "acc-1",
        "from_addr": "user@example.com",
        "to_addr": "to@example.com",
        "subject": "Hello",
        "body_text": "plain body",
        "attempts": 1,
    }
    job.update(overrides)
    return job


class _Response:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}

    def raise_for_status(self):
        if self.status_code >= 400:
            response = requests.Response()
            response.status_code = self.status_code
            raise requests.HTTPError(response=response)
        return None

    def json(self):
        return self._payload


# ---------------------------------------------------------------------- payload reconstruction

def test_payload_from_job_prefers_payload_json():
    job = _job(payload_json=json.dumps({
        "from_addr": "f@example.com",
        "to_addr": "t@example.com",
        "subject": "JSON subject",
        "body_text": "json body",
        "is_html": False,
    }))
    payload = outbound._payload_from_job(job)
    assert payload["subject"] == "JSON subject"
    assert payload["from_addr"] == "f@example.com"


def test_payload_from_job_falls_back_to_fields():
    job = _job()
    payload = outbound._payload_from_job(job)
    assert payload["from_addr"] == "user@example.com"
    assert payload["to_addr"] == "to@example.com"
    assert payload["subject"] == "Hello"


def test_payload_from_job_malformed_json_falls_back():
    job = _job(payload_json="{not valid json")
    payload = outbound._payload_from_job(job)
    assert payload["subject"] == "Hello"


def test_payload_from_job_non_dict_json_falls_back():
    job = _job(payload_json='"just a string"')
    payload = outbound._payload_from_job(job)
    assert payload["subject"] == "Hello"


# ---------------------------------------------------------------------- retryability

def test_retryable_classification():
    assert outbound._retryable(outbound.OutboundOutcomeUnknown("x")) is True
    assert outbound._retryable(outbound.ReconcileError("x")) is True
    assert outbound._retryable(requests.Timeout("x")) is True
    assert outbound._retryable(requests.ConnectionError("x")) is True
    assert outbound._retryable(OSError("x")) is True
    assert outbound._retryable(IMAPClientAbortError("x")) is True
    # Non-retryable: identity / send / unsupported / generic IMAP client error.
    assert outbound._retryable(outbound.OutboundIdentityError("x")) is False
    assert outbound._retryable(outbound.OutboundSendError("x")) is False
    assert outbound._retryable(outbound.OutboundUnsupported("x")) is False
    assert outbound._retryable(IMAPClientError("x")) is False
    assert outbound._retryable(ValueError("x")) is False


def test_retryable_http_error_statuses():
    def http_error(status):
        response = requests.Response()
        response.status_code = status
        error = requests.HTTPError(response=response)
        error.response = response
        return error

    assert outbound._retryable(http_error(408)) is True
    assert outbound._retryable(http_error(429)) is True
    assert outbound._retryable(http_error(500)) is True
    assert outbound._retryable(http_error(503)) is True
    assert outbound._retryable(http_error(400)) is False
    assert outbound._retryable(http_error(404)) is False


# ---------------------------------------------------------------------- execute_outbound

def test_execute_outbound_missing_to_addr_is_identity_error():
    account = _account()
    with pytest.raises(outbound.OutboundIdentityError, match="no recipient"):
        outbound.execute_outbound(_config([account]), account, _job(to_addr=""))


def test_execute_outbound_missing_from_addr_is_identity_error():
    account = _account()
    with pytest.raises(outbound.OutboundIdentityError, match="no from"):
        outbound.execute_outbound(_config([account]), account, _job(from_addr=""))


def test_execute_outbound_rejects_spoofed_from_addr():
    account = _account()
    with pytest.raises(outbound.OutboundIdentityError, match="does not match account"):
        outbound.execute_outbound(_config([account]), account, _job(from_addr="victim@example.com"))


def test_execute_outbound_accepts_case_insensitive_account_match(monkeypatch):
    account = _account()
    monkeypatch.setattr(outbound, "send_with_reconcile", lambda *a: "msg-42")
    projection = outbound.execute_outbound(
        _config([account]), account, _job(from_addr="USER@example.com"))
    assert projection == {"provider_message_id": "msg-42"}


def test_execute_outbound_app_password_dispatch(monkeypatch):
    account = _account(source="imap_qq")
    monkeypatch.setattr(outbound, "send_with_reconcile", lambda *a: "msg-42")
    projection = outbound.execute_outbound(_config([account]), account, _job())
    assert projection == {"provider_message_id": "msg-42"}


def test_execute_outbound_oauth_dispatch(monkeypatch):
    account = _account(source="imap_gmail", oauth={"provider": "gmail", "refresh_token": "rt"})
    monkeypatch.setattr(outbound, "send_oauth_with_reconcile", lambda *a: None)
    assert outbound.execute_outbound(_config([account]), account, _job()) is None


def test_execute_outbound_unknown_source_is_unsupported():
    account = _account(source="imap_unknown")
    with pytest.raises(outbound.OutboundUnsupported, match="unknown outbound provider"):
        outbound.execute_outbound(_config([account]), account, _job())


# ---------------------------------------------------------------------- claim / report shape

def test_claim_outbound_jobs_posts_correct_shape(monkeypatch):
    config = _config()
    captured = {}
    monkeypatch.setattr(
        outbound.requests,
        "post",
        lambda url, **kwargs: captured.update(url=url, kwargs=kwargs) or _Response(payload={"jobs": []}),
    )
    lease, jobs = outbound.claim_outbound_jobs(config, limit=7)
    assert jobs == []
    assert captured["url"] == "https://worker.example/admin/unified/outbound/claim"
    assert captured["kwargs"]["headers"] == {"x-admin-auth": "admin-token"}
    body = captured["kwargs"]["json"]
    assert body["limit"] == 7
    assert body["lease_token"] == lease


def test_report_outbound_result_posts_correct_shape(monkeypatch):
    config = _config()
    captured = {}
    monkeypatch.setattr(
        outbound.requests,
        "post",
        lambda url, **kwargs: captured.update(url=url, kwargs=kwargs) or _Response(),
    )
    outbound.report_outbound_result(
        config, "job-1", "lease-1", "succeeded",
        error=None, retry_after_ms=None, provider_message_id="msg-42",
    )
    assert captured["url"] == "https://worker.example/admin/unified/outbound/job-1/result"
    assert captured["kwargs"]["json"] == {
        "lease_token": "lease-1",
        "status": "succeeded",
        "provider_message_id": "msg-42",
    }


def test_report_outbound_result_truncates_long_error(monkeypatch):
    config = _config()
    captured = {}
    monkeypatch.setattr(
        outbound.requests,
        "post",
        lambda url, **kwargs: captured.update(kwargs=kwargs) or _Response(),
    )
    outbound.report_outbound_result(config, "job-1", "lease-1", "failed", error="x" * 2000)
    assert len(captured["kwargs"]["json"]["error"]) == 1000


# ---------------------------------------------------------------------- process_outbound_jobs

def test_process_empty_claim_never_fetches_accounts(monkeypatch):
    config = _config()
    monkeypatch.setattr(outbound, "claim_outbound_jobs", lambda config, limit=20: ("lease", []))

    def should_not_run(*args, **kwargs):
        raise AssertionError("must not fetch accounts for an empty queue")

    monkeypatch.setattr(outbound, "fetch_user_accounts", should_not_run)
    assert outbound.process_outbound_jobs(config) == {
        "claimed": 0, "succeeded": 0, "failed": 0, "retried": 0, "unsupported": 0,
    }


def test_process_can_send_false_is_unsupported(monkeypatch):
    account = _account(can_send=False)
    config = _config([account])
    monkeypatch.setattr(outbound, "claim_outbound_jobs", lambda config, limit=20: ("lease-1", [_job()]))
    reports = []
    monkeypatch.setattr(
        outbound, "report_outbound_result",
        lambda *args, **kwargs: reports.append((args, kwargs)),
    )
    result = outbound.process_outbound_jobs(config)
    assert result["unsupported"] == 1
    assert reports[0][0][2:4] == ("lease-1", "unsupported")
    assert "can_send" in reports[0][1]["error"]


def test_process_missing_account_with_fetch_success_is_failed(monkeypatch):
    config = _config()
    monkeypatch.setattr(outbound, "claim_outbound_jobs", lambda config, limit=20: ("lease-1", [_job()]))
    monkeypatch.setattr(outbound, "fetch_user_accounts", lambda *a, **k: [])
    reports = []
    monkeypatch.setattr(
        outbound, "report_outbound_result",
        lambda *args, **kwargs: reports.append((args, kwargs)),
    )
    result = outbound.process_outbound_jobs(config)
    assert result["failed"] == 1
    assert reports[0][0][3] == "failed"


def test_process_missing_account_with_fetch_failure_is_retry(monkeypatch):
    config = _config()

    def fetch_broken(*a, **k):
        raise requests.ConnectionError("primary metadata down")

    monkeypatch.setattr(outbound, "claim_outbound_jobs", lambda config, limit=20: ("lease-1", [_job()]))
    monkeypatch.setattr(outbound, "fetch_user_accounts", fetch_broken)
    reports = []
    monkeypatch.setattr(
        outbound, "report_outbound_result",
        lambda *args, **kwargs: reports.append((args, kwargs)),
    )
    with pytest.raises(outbound.OutboundBatchError, match="account fetch"):
        outbound.process_outbound_jobs(config)
    assert reports[0][0][3] == "retry"
    assert reports[0][1]["retry_after_ms"] == 5000


def test_process_retryable_execution_error_is_reported_for_retry(monkeypatch):
    account = _account()
    config = _config([account])
    monkeypatch.setattr(outbound, "claim_outbound_jobs", lambda config, limit=20: ("lease-1", [_job()]))
    monkeypatch.setattr(
        outbound, "execute_outbound",
        lambda *a: (_ for _ in ()).throw(outbound.OutboundOutcomeUnknown("lost")),
    )
    reports = []
    monkeypatch.setattr(
        outbound, "report_outbound_result",
        lambda *args, **kwargs: reports.append((args, kwargs)),
    )
    result = outbound.process_outbound_jobs(config)
    assert result["retried"] == 1
    assert reports[0][0][3] == "retry"


def test_process_identity_error_is_reported_failed(monkeypatch):
    account = _account()
    config = _config([account])
    monkeypatch.setattr(outbound, "claim_outbound_jobs", lambda config, limit=20: ("lease-1", [_job()]))
    monkeypatch.setattr(
        outbound, "execute_outbound",
        lambda *a: (_ for _ in ()).throw(outbound.OutboundIdentityError("bad credentials")),
    )
    reports = []
    monkeypatch.setattr(
        outbound, "report_outbound_result",
        lambda *args, **kwargs: reports.append((args, kwargs)),
    )
    result = outbound.process_outbound_jobs(config)
    assert result["failed"] == 1
    assert reports[0][0][3] == "failed"


def test_process_success_with_provider_message_id(monkeypatch):
    account = _account()
    config = _config([account])
    monkeypatch.setattr(outbound, "claim_outbound_jobs", lambda config, limit=20: ("lease-1", [_job()]))
    monkeypatch.setattr(
        outbound, "execute_outbound",
        lambda *a: {"provider_message_id": "msg-42"},
    )
    reports = []
    monkeypatch.setattr(
        outbound, "report_outbound_result",
        lambda *args, **kwargs: reports.append((args, kwargs)),
    )
    result = outbound.process_outbound_jobs(config)
    assert result["succeeded"] == 1
    assert reports[0][1]["provider_message_id"] == "msg-42"


def test_process_report_failure_surfaces_batch_error(monkeypatch):
    account = _account()
    config = _config([account])
    report_error = requests.Timeout("report lost")
    monkeypatch.setattr(outbound, "claim_outbound_jobs", lambda config, limit=20: ("lease-1", [_job()]))
    monkeypatch.setattr(outbound, "execute_outbound", lambda *a: None)
    monkeypatch.setattr(
        outbound, "report_outbound_result",
        lambda *a, **k: (_ for _ in ()).throw(report_error),
    )
    with pytest.raises(outbound.OutboundBatchError, match="result job job-1") as caught:
        outbound.process_outbound_jobs(config)
    assert caught.value.result["claimed"] == 1
    assert caught.value.__cause__ is report_error


def test_process_unsupported_provider_is_unsupported(monkeypatch):
    account = _account(source="imap_unknown")
    config = _config([account])
    monkeypatch.setattr(outbound, "claim_outbound_jobs", lambda config, limit=20: ("lease-1", [_job()]))
    reports = []
    monkeypatch.setattr(
        outbound, "report_outbound_result",
        lambda *args, **kwargs: reports.append((args, kwargs)),
    )
    result = outbound.process_outbound_jobs(config)
    assert result["unsupported"] == 1
    assert reports[0][0][3] == "unsupported"
