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


class _MoveWithoutRecoverableProof:
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
            # First-attempt preflight proves the target was empty. After MOVE the
            # server still fails to expose a unique Message-ID match, so the side
            # effect may have committed but its new UID cannot be proven.
            return []
        if criteria[0] == "UID":
            return [42] if self.current_folder == "INBOX" else []
        raise AssertionError(f"unexpected search criteria: {criteria!r}")

    def move(self, uids, target):
        self.moves.append((list(uids), target))
        return "OK move completed"

    def logout(self):
        self.logged_out = True


def test_imap_move_post_side_effect_identity_failure_stays_retryable(monkeypatch):
    account = _imap_account()
    client = _MoveWithoutRecoverableProof()
    monkeypatch.setattr(mutations, "default_client_factory", lambda _account: client)

    with pytest.raises(mutations.MutationOutcomeUnknown, match="MOVE outcome is unknown") as caught:
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
                "message_id_header": "<m1@example.com>",
            },
        )

    assert client.moves == [([42], "Archive")]
    assert mutations._retryable(caught.value) is True
    assert client.logged_out is True
