from types import SimpleNamespace

import pytest
import requests

import one_mail_agg.mutation_jobs as mutations
from one_mail_agg.config import AccountConfig, Config
from one_mail_agg.graph_source import GRAPH_IMMUTABLE_PREFER, graph_source_key
from one_mail_agg.imap_base import make_imap_uid


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
        folders=["INBOX", "Archive"],
        protocol=protocol,
        use_ssl=True,
    )


class _FakeImap:
    def __init__(
        self,
        uidvalidity=7,
        uids=(42,),
        *,
        capabilities=(b"IMAP4rev1", b"MOVE", b"UIDPLUS"),
        target_uidvalidity=9,
        target_uids=(84,),
        message_id="<m1@example.com>",
        move_response=None,
    ):
        self.capability_set = {c.upper() if isinstance(c, bytes) else str(c).upper().encode() for c in capabilities}
        self.folder_uidvalidity = {"INBOX": uidvalidity, "Archive": target_uidvalidity}
        self.folder_uids = {"INBOX": list(uids), "Archive": list(target_uids)}
        self.message_ids = {
            "Archive": {message_id: list(target_uids)},
            "INBOX": {message_id: list(uids)},
        }
        self.current_folder = None
        self.added = []
        self.removed = []
        self.selected = []
        self.moves = []
        self.deleted = []
        self.uid_expunged = []
        self.logged_out = False
        self.move_response = move_response

    def has_capability(self, capability):
        value = capability.upper() if isinstance(capability, bytes) else str(capability).upper().encode()
        return value in self.capability_set

    def select_folder(self, folder, readonly=True):
        self.current_folder = folder
        self.selected.append((folder, readonly))
        return {b"UIDVALIDITY": self.folder_uidvalidity[folder]}

    def search(self, criteria, charset=None):
        if criteria[0] == "UID":
            wanted = int(criteria[1])
            return [uid for uid in self.folder_uids.get(self.current_folder, []) if uid == wanted]
        if criteria[:2] == ["HEADER", "Message-ID"]:
            return list(self.message_ids.get(self.current_folder, {}).get(criteria[2], []))
        raise AssertionError(f"unexpected search criteria: {criteria!r}")

    def add_flags(self, uids, flags):
        self.added.append((list(uids), list(flags)))

    def remove_flags(self, uids, flags):
        self.removed.append((list(uids), list(flags)))

    def move(self, uids, target):
        source = self.current_folder
        source_uid = int(list(uids)[0])
        self.moves.append((list(uids), target))
        if source_uid in self.folder_uids.get(source, []):
            self.folder_uids[source].remove(source_uid)
        destination_uid = self.folder_uids[target][0]
        if self.move_response is not None:
            return self.move_response
        return f"OK [COPYUID {self.folder_uidvalidity[target]} {source_uid} {destination_uid}] moved"

    def delete_messages(self, uids, silent=False):
        self.deleted.append((list(uids), silent))

    def uid_expunge(self, uids):
        values = list(uids)
        self.uid_expunged.append(values)
        for uid in values:
            if uid in self.folder_uids.get(self.current_folder, []):
                self.folder_uids[self.current_folder].remove(uid)

    def logout(self):
        self.logged_out = True


def _imap_job(operation="set_read", desired=1, *, uidvalidity=7, uid=42, attempts=1):
    return {
        "id": "job-1",
        "account_id": "acc-1",
        "provider": "imap",
        "operation": operation,
        "desired_value": desired,
        "source_folder": "INBOX",
        "source_key": f"acc-1:imap.example.com:INBOX:{uidvalidity}:{uid}",
        "message_id_header": "<m1@example.com>",
        "attempts": attempts,
    }


def test_imap_read_and_star_are_desired_state_flags(monkeypatch):
    account = _imap_account()
    client = _FakeImap()
    monkeypatch.setattr(mutations, "default_client_factory", lambda _account: client)

    assert mutations.execute_mutation(_config([account]), account, _imap_job("set_read", 1)) is None
    assert client.selected == [("INBOX", False)]
    assert client.added == [([42], [b"\\Seen"])]

    client.added.clear()
    client.selected.clear()
    assert mutations.execute_mutation(_config([account]), account, _imap_job("set_starred", 0)) is None
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


def test_imap_move_uses_copyuid_and_returns_new_provider_identity(monkeypatch):
    account = _imap_account()
    client = _FakeImap()
    monkeypatch.setattr(mutations, "default_client_factory", lambda _account: client)
    job = {**_imap_job("move", None), "target_folder": "Archive"}

    projection = mutations.execute_mutation(_config([account]), account, job)

    assert client.moves == [([42], "Archive")]
    assert projection == {
        "source_folder": "Archive",
        "source_folder_id": None,
        "source_key": make_imap_uid(account.id, account.host, "Archive", 9, 84),
    }


def test_imap_move_without_copyuid_recovers_exact_target_message_id(monkeypatch):
    account = _imap_account()
    client = _FakeImap(move_response="OK move completed")
    monkeypatch.setattr(mutations, "default_client_factory", lambda _account: client)
    job = {**_imap_job("move", None), "target_folder": "Archive"}

    projection = mutations.execute_mutation(_config([account]), account, job)
    assert projection["source_key"] == make_imap_uid(account.id, account.host, "Archive", 9, 84)


def test_imap_move_retry_recovers_when_source_uid_is_already_gone(monkeypatch):
    account = _imap_account()
    client = _FakeImap(uids=(), target_uids=(84,))
    monkeypatch.setattr(mutations, "default_client_factory", lambda _account: client)
    job = {**_imap_job("move", None, attempts=2), "target_folder": "Archive"}

    projection = mutations.execute_mutation(_config([account]), account, job)
    assert client.moves == []
    assert projection["source_folder"] == "Archive"
    assert projection["source_key"].endswith(":Archive:9:84")


def test_imap_move_requires_move_uidplus_and_message_id_before_mutating(monkeypatch):
    account = _imap_account()
    client = _FakeImap(capabilities=(b"IMAP4rev1", b"MOVE"))
    monkeypatch.setattr(mutations, "default_client_factory", lambda _account: client)
    job = {**_imap_job("move", None), "target_folder": "Archive"}

    with pytest.raises(mutations.MutationUnsupported, match="UIDPLUS"):
        mutations.execute_mutation(_config([account]), account, job)
    assert client.moves == []

    client = _FakeImap()
    monkeypatch.setattr(mutations, "default_client_factory", lambda _account: client)
    job["message_id_header"] = None
    with pytest.raises(mutations.MutationIdentityError, match="Message-ID"):
        mutations.execute_mutation(_config([account]), account, job)
    assert client.moves == []


def test_imap_delete_uses_uid_expunge_and_retry_absence_is_success(monkeypatch):
    account = _imap_account()
    client = _FakeImap()
    monkeypatch.setattr(mutations, "default_client_factory", lambda _account: client)

    assert mutations.execute_mutation(_config([account]), account, _imap_job("delete", None)) is None
    assert client.deleted == [([42], True)]
    assert client.uid_expunged == [[42]]

    retry_client = _FakeImap(uids=())
    monkeypatch.setattr(mutations, "default_client_factory", lambda _account: retry_client)
    assert mutations.execute_mutation(
        _config([account]), account, _imap_job("delete", None, attempts=2)
    ) is None
    assert retry_client.deleted == []
    assert retry_client.uid_expunged == []


def test_pop3_provider_is_explicitly_unsupported():
    account = _imap_account(protocol="pop3")
    with pytest.raises(mutations.MutationUnsupported, match="POP3"):
        mutations.execute_mutation(
            _config([account]),
            account,
            {"provider": "pop3", "operation": "set_read", "desired_value": 1},
        )


class _GraphResponse:
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


def _graph_account():
    return AccountConfig(
        id="graph-1",
        source="graph_outlook",
        host="graph.microsoft.com",
        port=443,
        username="u@outlook.com",
        password="",
        folders=["INBOX"],
        oauth={"provider": "graph", "client_id": "cid", "refresh_token": "rt"},
    )


def test_graph_read_patch_uses_immutable_id_preference(monkeypatch):
    account = _graph_account()
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


def test_graph_move_uses_stable_folder_id_and_preserves_immutable_id(monkeypatch):
    account = _graph_account()
    captured = {}
    monkeypatch.setattr(mutations, "graph_access_token", lambda oauth, callback=None: "AT")

    def fake_post(url, headers=None, json=None, timeout=None):
        captured.update(url=url, headers=headers, json=json)
        return _GraphResponse(201, {"id": "immutable-1", "parentFolderId": "archive-id"})

    monkeypatch.setattr(mutations.requests, "post", fake_post)
    job = {
        "provider": "graph",
        "provider_message_id": "immutable-1",
        "operation": "move",
        "target_folder": "Archive",
        "target_folder_id": "archive-id",
        "attempts": 1,
    }
    projection = mutations.execute_mutation(_config([account]), account, job)

    assert captured["url"].endswith("/me/messages/immutable-1/move")
    assert captured["headers"]["Prefer"] == GRAPH_IMMUTABLE_PREFER
    assert captured["json"] == {"destinationId": "archive-id"}
    assert projection == {
        "source_folder": "Archive",
        "source_folder_id": "archive-id",
        "source_key": graph_source_key(account, "immutable-1"),
        "provider_message_id": "immutable-1",
    }


def test_graph_move_retry_observes_target_before_reissuing_move(monkeypatch):
    account = _graph_account()
    monkeypatch.setattr(mutations, "graph_access_token", lambda oauth, callback=None: "AT")
    monkeypatch.setattr(
        mutations.requests,
        "get",
        lambda *a, **k: _GraphResponse(200, {"id": "immutable-1", "parentFolderId": "archive-id"}),
    )
    monkeypatch.setattr(
        mutations.requests,
        "post",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("move must not be reissued")),
    )
    projection = mutations.execute_mutation(
        _config([account]),
        account,
        {
            "provider": "graph",
            "provider_message_id": "immutable-1",
            "operation": "move",
            "target_folder": "Archive",
            "target_folder_id": "archive-id",
            "attempts": 2,
        },
    )
    assert projection["source_folder_id"] == "archive-id"


def test_graph_delete_retry_404_is_success_but_first_attempt_404_is_identity_error(monkeypatch):
    account = _graph_account()
    monkeypatch.setattr(mutations, "graph_access_token", lambda oauth, callback=None: "AT")
    monkeypatch.setattr(mutations.requests, "delete", lambda *a, **k: _GraphResponse(404))

    with pytest.raises(mutations.MutationIdentityError, match="no longer exists"):
        mutations.execute_mutation(
            _config([account]),
            account,
            {"provider": "graph", "provider_message_id": "immutable-1", "operation": "delete", "attempts": 1},
        )

    assert mutations.execute_mutation(
        _config([account]),
        account,
        {"provider": "graph", "provider_message_id": "immutable-1", "operation": "delete", "attempts": 2},
    ) is None


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


def test_successful_provider_projection_is_forwarded_to_worker(monkeypatch):
    account = _imap_account()
    config = _config([account])
    job = {"id": "job-1", "account_id": account.id, "provider": "imap", "attempts": 1}
    projection = {"source_folder": "Archive", "source_key": "new-key"}
    monkeypatch.setattr(mutations, "claim_mutation_jobs", lambda config, limit=20: ("lease-1", [job]))
    monkeypatch.setattr(mutations, "execute_mutation", lambda *a, **k: projection)
    reports = []
    monkeypatch.setattr(
        mutations,
        "report_mutation_result",
        lambda *args, **kwargs: reports.append((args, kwargs)),
    )

    result = mutations.process_mutation_jobs(config)
    assert result["succeeded"] == 1
    assert reports[0][0][2:4] == ("lease-1", "succeeded")
    assert reports[0][1]["projection"] == projection