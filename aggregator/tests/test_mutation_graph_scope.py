from types import SimpleNamespace

import pytest

import one_mail_agg.mutation_jobs as mutations
from one_mail_agg.config import Config


def _config():
    return Config(worker_base_url="https://worker.example", admin_token="token", accounts=[])


def _account(scope):
    return SimpleNamespace(
        id="graph-1",
        oauth={
            "provider": "graph",
            "client_id": "cid",
            "refresh_token": "rt",
            "scope": scope,
        },
        user_managed=False,
    )


def _job():
    return {
        "provider": "graph",
        "provider_message_id": "immutable-1",
        "operation": "set_read",
        "desired_value": 1,
    }


def test_explicit_mail_read_only_scope_requires_reauthorization(monkeypatch):
    token_calls = []
    monkeypatch.setattr(
        mutations,
        "graph_access_token",
        lambda *args, **kwargs: token_calls.append(True) or "AT",
    )

    with pytest.raises(mutations.MutationUnsupported, match="Mail.Read only"):
        mutations.execute_mutation(
            _config(),
            _account("https://graph.microsoft.com/Mail.Read offline_access"),
            _job(),
        )

    assert token_calls == []


def test_mail_readwrite_scope_allows_graph_patch(monkeypatch):
    monkeypatch.setattr(mutations, "graph_access_token", lambda *args, **kwargs: "AT")
    calls = []

    class Response:
        def raise_for_status(self):
            return None

    monkeypatch.setattr(
        mutations.requests,
        "patch",
        lambda url, headers=None, json=None, timeout=None:
            calls.append((url, headers, json, timeout)) or Response(),
    )

    mutations.execute_mutation(
        _config(),
        _account("Mail.ReadWrite offline_access"),
        _job(),
    )
    assert len(calls) == 1
    assert calls[0][2] == {"isRead": True}


def test_missing_or_default_scope_does_not_guess_permissions(monkeypatch):
    assert mutations._graph_scope_allows_write({}) is True
    assert mutations._graph_scope_allows_write({"scope": "https://graph.microsoft.com/.default"}) is True
