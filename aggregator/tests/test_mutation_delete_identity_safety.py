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
        folders=["INBOX"],
        protocol="imap",
        use_ssl=True,
    )


class _ResetMailboxImap:
    def __init__(self):
        self.deleted = []
        self.uid_expunged = []
        self.searches = []
        self.logged_out = False

    def select_folder(self, folder, readonly=True):
        assert folder == "INBOX"
        return {b"UIDVALIDITY": 99}

    def search(self, criteria, charset=None):
        self.searches.append(criteria)
        return [42]

    def has_capability(self, capability):
        return True

    def delete_messages(self, uids, silent=False):
        self.deleted.append((list(uids), silent))

    def uid_expunge(self, uids):
        self.uid_expunged.append(list(uids))

    def logout(self):
        self.logged_out = True


def test_imap_delete_retry_uidvalidity_reset_is_not_false_success(monkeypatch):
    account = _imap_account()
    client = _ResetMailboxImap()
    monkeypatch.setattr(mutations, "default_client_factory", lambda _account: client)

    job = {
        "id": "delete-1",
        "account_id": account.id,
        "provider": "imap",
        "operation": "delete",
        "source_folder": "INBOX",
        "source_key": "acc-1:imap.example.com:INBOX:7:42",
        "attempts": 2,
    }

    with pytest.raises(mutations.MutationIdentityError, match="UIDVALIDITY changed"):
        mutations.execute_mutation(_config(account), account, job)

    # A UIDVALIDITY reset invalidates the old UID namespace but does not prove
    # the message was deleted. Never mutate a UID from the reset mailbox and
    # never report provider success from this state.
    assert client.searches == []
    assert client.deleted == []
    assert client.uid_expunged == []
    assert client.logged_out is True
