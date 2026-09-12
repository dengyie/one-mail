from types import SimpleNamespace

import one_mail_agg.mutation_jobs as mutations
from one_mail_agg.config import Config


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
