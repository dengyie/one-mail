from types import SimpleNamespace

import pytest

import one_mail_agg.mutation_jobs as mutations
from one_mail_agg.config import Config


def _silence_transport_retry_sleep(monkeypatch):
    """The retry's 0.5s pacing now lives in transport_retry, not in each caller."""
    monkeypatch.setattr("one_mail_agg.transport_retry.time.sleep", lambda _seconds: None)


def _config():
    return Config(
        worker_base_url="https://worker.example",
        admin_token="admin-token",
        accounts=[],
        state_path="state.json",
    )


class _Response:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"unexpected HTTP {self.status_code}")

    def json(self):
        return self._payload


def test_new_aggregator_prefers_v2_claim(monkeypatch):
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs["json"]))
        return _Response(200, {"jobs": [{"id": "move-1", "operation": "move"}]})

    monkeypatch.setattr(mutations.requests, "post", fake_post)
    _lease, jobs = mutations.claim_mutation_jobs(_config(), limit=7)

    assert jobs == [{"id": "move-1", "operation": "move"}]
    assert len(calls) == 1
    assert calls[0][0].endswith("/admin/unified/mutations/v2/claim")
    assert calls[0][1]["limit"] == 7


def test_new_aggregator_falls_back_to_v1_against_old_worker(monkeypatch):
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs["json"]))
        if url.endswith("/v2/claim"):
            return _Response(404)
        return _Response(200, {"jobs": [{"id": "read-1", "operation": "set_read"}]})

    monkeypatch.setattr(mutations.requests, "post", fake_post)
    lease, jobs = mutations.claim_mutation_jobs(_config())

    assert jobs == [{"id": "read-1", "operation": "set_read"}]
    assert len(calls) == 2
    assert calls[0][0].endswith("/admin/unified/mutations/v2/claim")
    assert calls[1][0].endswith("/admin/unified/mutations/claim")
    # The same lease token must be reused so fallback cannot create two claim
    # identities during a version transition.
    assert calls[0][1]["lease_token"] == lease
    assert calls[1][1]["lease_token"] == lease


def test_shard_v2_claim_fallback_keeps_lease_and_bearer_auth(monkeypatch):
    config = Config("https://worker.example", "admin-token", [], shards=[
        {"id": "s1", "base_url": "https://s1.example", "token": "x" * 32, "accounts": []}])
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return _Response(404 if url.endswith("/v2/claim") else 200, {"jobs": []})

    monkeypatch.setattr(mutations.requests, "post", fake_post)
    assert mutations.process_mutation_jobs(config)["claimed"] == 0
    assert [url for url, _ in calls] == [
        "https://worker.example/admin/unified/mutations/v2/claim",
        "https://worker.example/admin/unified/mutations/claim",
        "https://s1.example/shard/mutations/v2/claim",
        "https://s1.example/shard/mutations/claim"]
    assert calls[2][1]["json"]["lease_token"] == calls[3][1]["json"]["lease_token"]
    assert calls[0][1]["json"]["lease_token"] != calls[2][1]["json"]["lease_token"]
    assert calls[2][1]["headers"] == calls[3][1]["headers"] == {"Authorization": "Bearer " + "x" * 32}


# ---------------------------------------------------------- transient claim retry

def test_claim_retries_once_on_transport_timeout(monkeypatch):
    """A transient ReadTimeout must be retried instead of surfacing as a queue
    failure: a failed claim backs the drain off for 60-300s, delaying every
    pending user mutation. The claim is only a lease, so the retry is safe."""
    calls = []

    def fake_post(url, **kwargs):
        calls.append(url)
        if len(calls) == 1:
            raise mutations.requests.exceptions.ReadTimeout("read timed out")
        return _Response(200, {"jobs": [{"id": "read-1"}]})

    monkeypatch.setattr(mutations.requests, "post", fake_post)
    _silence_transport_retry_sleep(monkeypatch)

    _lease, jobs = mutations.claim_mutation_jobs(_config(), limit=5)

    assert jobs == [{"id": "read-1"}]
    assert len(calls) == 2


def test_claim_retry_covers_ssl_and_proxy_errors(monkeypatch):
    """SSLError and ProxyError subclass ConnectionError, so the same retry applies."""
    for error_cls in (
        mutations.requests.exceptions.SSLError,
        mutations.requests.exceptions.ProxyError,
    ):
        calls = []

        def fake_post(url, **kwargs):
            calls.append(url)
            if len(calls) == 1:
                raise error_cls("transient")
            return _Response(200, {"jobs": []})

        monkeypatch.setattr(mutations.requests, "post", fake_post)
        _silence_transport_retry_sleep(monkeypatch)

        _lease, jobs = mutations.claim_mutation_jobs(_config(), limit=5)
        assert jobs == []
        assert len(calls) == 2, error_cls.__name__


def test_claim_does_not_retry_http_error_status(monkeypatch):
    calls = []

    def fake_post(url, **kwargs):
        calls.append(url)
        return _Response(500)

    monkeypatch.setattr(mutations.requests, "post", fake_post)
    _silence_transport_retry_sleep(monkeypatch)

    with pytest.raises(AssertionError):  # fake _Response raises for >=400
        mutations.claim_mutation_jobs(_config(), limit=5)
    assert len(calls) == 1


def test_claim_raises_after_retry_budget_exhausted(monkeypatch):
    calls = []

    def fake_post(url, **kwargs):
        calls.append(url)
        raise mutations.requests.exceptions.ConnectionError("down")

    monkeypatch.setattr(mutations.requests, "post", fake_post)
    _silence_transport_retry_sleep(monkeypatch)

    with pytest.raises(mutations.requests.exceptions.ConnectionError):
        mutations.claim_mutation_jobs(_config(), limit=5)
    assert len(calls) == 2
