import pytest

import one_mail_agg.mutation_jobs as mutations
from one_mail_agg.config import AccountConfig, Config


def _config(account):
    return Config(
        worker_base_url="https://worker.example",
        admin_token="admin-token",
        accounts=[account],
        state_path="state.json",
    )


def _imap_account():
    return AccountConfig(
        id="acc-1",
        source="imap_custom",
        host="imap.example.com",
        port=993,
        username="user@example.com",
        password="secret",
        folders=["INBOX", "Archive"],
        protocol="imap",
        use_ssl=True,
    )


class _PreflightImap:
    def __init__(self):
        self.current_folder = None
        self.moves = []
        self.logged_out = False

    def has_capability(self, capability):
        return str(capability).upper() in {"MOVE", "UIDPLUS"}

    def select_folder(self, folder, readonly=True):
        self.current_folder = folder
        return {b"UIDVALIDITY": 9 if folder == "Archive" else 7}

    def search(self, criteria, charset=None):
        if criteria[:2] == ["HEADER", "Message-ID"]:
            return [84] if self.current_folder == "Archive" else []
        if criteria[0] == "UID":
            return [42]
        raise AssertionError(f"unexpected search criteria: {criteria!r}")

    def move(self, uids, target):
        self.moves.append((list(uids), target))
        return "OK [COPYUID 9 42 84] moved"

    def logout(self):
        self.logged_out = True


def test_imap_first_move_refuses_ambiguous_preexisting_message_id(monkeypatch):
    account = _imap_account()
    client = _PreflightImap()
    monkeypatch.setattr(mutations, "default_client_factory", lambda _account: client)

    with pytest.raises(mutations.MutationIdentityError, match="target already contains"):
        mutations.execute_mutation(
            _config(account),
            account,
            {
                "provider": "imap",
                "operation": "move",
                "attempts": 1,
                "source_folder": "INBOX",
                "source_key": "acc-1:imap.example.com:INBOX:7:42",
                "target_folder": "Archive",
                "message_id_header": "<same@example.com>",
            },
        )

    assert client.moves == []
    assert client.logged_out is True


def test_graph_move_projection_requires_provider_proof_fields():
    account = AccountConfig(
        id="graph-1",
        source="graph_outlook",
        host="graph.microsoft.com",
        port=443,
        username="u@example.com",
        password="",
        folders=["INBOX"],
        oauth={"provider": "graph", "client_id": "cid", "refresh_token": "rt"},
    )
    job = {
        "provider_message_id": "immutable-1",
        "target_folder": "Archive",
        "target_folder_id": "archive-id",
    }

    for payload in [
        {"parentFolderId": "archive-id"},
        {"id": "immutable-1"},
        {"id": "immutable-1", "parentFolderId": "wrong-id"},
        {"id": "changed-id", "parentFolderId": "archive-id"},
    ]:
        with pytest.raises(mutations.MutationIdentityError):
            mutations._graph_move_projection(account, job, payload)

    projection = mutations._graph_move_projection(
        account,
        job,
        {"id": "immutable-1", "parentFolderId": "archive-id"},
    )
    assert projection["provider_message_id"] == "immutable-1"
    assert projection["source_folder_id"] == "archive-id"
