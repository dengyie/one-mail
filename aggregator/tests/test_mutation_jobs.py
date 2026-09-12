from types import SimpleNamespace

import pytest

import one_mail_agg.mutation_jobs as mutations
from one_mail_agg.config import AccountConfig, Config
from one_mail_agg.graph_source import GRAPH_IMMUTABLE_PREFER


def _config(accounts=None):
    return Config(
        worker_base_url="https://worker.example",
        admin_token="admin-token",
        accounts=accounts or [],
        state_path="state.json",
    )


def _imap_account(protocol="imap"):
    return AccountConfig(
        id="acc-1",
        source="imap_custom",
        host="imap.example.com",
        port=993,
        username="user@example.com",
        password="secret",
        folders=["INBOX"],
        protocol=protocol,
        use_ssl=True,
    )


class _FakeImap:
    def __init__(self, uidvalidity=7, uids=(42,)):
        self.uidvalidity = uidvalidity
        self.uids = list(uids)
        self.added = []
        self.removed = []
        self.selected = []
        self.logged_out = False

    def select_folder(self, folder, readonly=True):
        self.selected.append((folder, readonly))
        return {b"UIDVALIDITY": self.uidvalidity}

    def search(self, criteria, charset=None):
        assert criteria[0] == "UID"
        wanted = int(criteria[1])
        return [uid for uid in self.uids if uid == wanted]

    def add_flags(self, uids, flags):
        self.added.append((list(uids), list(flags)))

    def remove_flags(self, uids, flags):
        self.removed.append((list(uids), list(flags)))

    def logout(self):
        self.logged_out = True


def _imap_job(operation="set_read", desired=1, *, uidvalidity=7, uid=42):
    return {
        "id": "job-1",
        "account_id": "acc-1",
        "provider": "imap",
        "operation": operation,
        "desired_value": desired,
        "source_folder": "INBOX",
        "source_key": f"acc-1:imap.example.com:INBOX:{uidvalidity}:{uid}",
    }


def test_imap_read_and_star_are_desired_state_flags(monkeypatch):
    account = _imap_account()
    client = _FakeImap()
    monkeypatch.setattr(mutations, "default_client_factory", lambda _account: client)

    mutations.execute_mutation(_config([account]), account, _imap_job("set_read", 1))
    assert client.selected == [("INBOX", False)]
    assert client.added == [([42], [b"\\Seen"])]

    client.added.clear()
    mutations.execute_mutation(_config([account]), account, _imap_job("set_starred", 0))
    assert client.removed == [([42], [b"\\Flagged"])]


def test_imap_uidvalidity_change_fails_before_store(monkeypatch):
    account = _imap_account()
    client = _FakeImap(uidvalidity=99)
    monkeypatch.setattr(mutations, "default_client_factory", lambda _account: client)

    with pytest.raises(mutations.MutationIdentityError, match="UIDVALIDITY changed"):
        mutations.execute_mutation(_config([account]), account, _imap_job(uidvalidity=7))

    assert client.added == []
    assert client.removed == []
    assert client.logged_out is True


def test_imap_missing_uid_fails_before_store(monkeypatch):
    account = _imap_account()
    client = _FakeImap(uidvalidity=7, uids=())
    monkeypatch.setattr(mutations, "default_client_factory", lambda _account: client)

    with pytest.raises(mutations.MutationIdentityError, match="no longer exists"):
        mutations.execute_mutation(_config([account]), account, _imap_job())

    assert client.added == []
    assert client.removed == []


def test_pop3_provider_is_explicitly_unsupported():
    account = _imap_account(protocol="pop3")
    with pytest.raises(mutations.MutationUnsupported, match="POP3"):
        mutations.execute_mutation(
            _config([account]),
            account,
            {"provider": "pop3", "operation": "set_read", "desired_value": 1},
        )


class _GraphResponse:
    status_code = 200

    def raise_for_status(self):
        return None


def test_graph_read_patch_uses_immutable_id_preference(monkeypatch):
    account = AccountConfig(
        id="graph-1",
        source="graph_outlook",
        host="graph.microsoft.com",
        port=443,
        username="u@outlook.com",
        password="",
        folders=["INBOX"],
        oauth={"provider": "graph", "client_id": "cid", "refresh_token": "rt"},
    )
    captured = {}
    monkeypatch.setattr(mutations, "graph_access_token", lambda oauth, callback=None: "AT")

    def fake_patch(url, headers=None, json=None, timeout=None):
        captured.update(url=url, headers=headers, json=json, timeout=timeout)
        return _GraphResponse()

    monkeypatch.setattr(mutations.requests, "patch", fake_patch)
    mutations.execute_mutation(
        _config([account]),
        account,
        {
            "provider": "graph",
            "provider_message_id": "immutable/id+1",
            "operation": "set_read",
            "desired_value": 1,
        },
    )

    assert captured["url"].endswith("/me/messages/immutable%2Fid%2B1")
    assert captured["headers"]["Prefer"] == GRAPH_IMMUTABLE_PREFER
    assert captured["json"] == {"isRead": True}


def test_graph_star_patch_maps_to_followup_flag(monkeypatch):
    account = SimpleNamespace(
        id="graph-1",
        oauth={"provider": "graph", "client_id": "cid", "refresh_token": "rt"},
        user_managed=False,
    )
    captured = {}
    monkeypatch.setattr(mutations, "graph_access_token", lambda oauth, callback=None: "AT")
    monkeypatch.setattr(
        mutations.requests,
        "patch",
        lambda url, headers=None, json=None, timeout=None:
            captured.update(json=json, headers=headers) or _GraphResponse(),
    )

    mutations.execute_mutation(
        _config(),
        account,
        {
            "provider": "graph",
            "provider_message_id": "immutable-1",
            "operation": "set_starred",
            "desired_value": 0,
        },
    )
    assert captured["json"] == {"flag": {"flagStatus": "notFlagged"}}


def test_empty_claim_never_exports_user_credentials(monkeypatch):
    config = _config()
    monkeypatch.setattr(mutations, "claim_mutation_jobs", lambda config, limit=20: ("lease", []))

    def should_not_run(*args, **kwargs):
        raise AssertionError("user credentials must not be exported for an empty mutation queue")

    monkeypatch.setattr(mutations, "fetch_user_accounts", should_not_run)
    assert mutations.process_mutation_jobs(config) == {
        "claimed": 0,
        "succeeded": 0,
        "failed": 0,
        "retried": 0,
        "unsupported": 0,
    }


def test_transient_provider_error_is_reported_for_retry(monkeypatch):
    account = _imap_account()
    config = _config([account])
    job = {"id": "job-1", "account_id": account.id, "provider": "imap", "attempts": 2}
    monkeypatch.setattr(mutations, "claim_mutation_jobs", lambda config, limit=20: ("lease-1", [job]))
    monkeypatch.setattr(mutations, "execute_mutation", lambda *a, **k: (_ for _ in ()).throw(OSError("network down")))
    reports = []
    monkeypatch.setattr(
        mutations,
        "report_mutation_result",
        lambda *args, **kwargs: reports.append((args, kwargs)),
    )

    result = mutations.process_mutation_jobs(config)
    assert result["retried"] == 1
    assert reports[0][0][2:4] == ("lease-1", "retry")
    assert reports[0][1]["retry_after_ms"] == 10000
