from one_mail_agg.imap_base import make_imap_uid, fetch_new_messages
from one_mail_agg.state import SyncState
from one_mail_agg.config import AccountConfig


def acc(initial_sync_limit: int = 0):
    return AccountConfig(id="qq", source="imap_qq", host="imap.qq.com", port=993,
                         username="u", password="p", folders=["INBOX"],
                         initial_sync_limit=initial_sync_limit)


def test_make_imap_uid_format():
    assert make_imap_uid("qq", "imap.qq.com", "INBOX", 7, 123) == "qq:imap.qq.com:INBOX:7:123"


def test_state_roundtrip(tmp_path):
    s = SyncState(str(tmp_path / "st.json"))
    s.set_last_uid("qq", "INBOX", 50)
    s.set_uidvalidity("qq", "INBOX", 9)
    s2 = SyncState(str(tmp_path / "st.json"))
    assert s2.get_last_uid("qq", "INBOX") == 50
    assert s2.get_uidvalidity("qq", "INBOX") == 9


class FakeClient:
    def __init__(self, uids, uidvalidity=1, sizes=None):
        self._uids = uids
        self._uidvalidity = uidvalidity
        self._sizes = sizes or {}

    def select_folder(self, folder, readonly=True):
        return {b"UIDVALIDITY": self._uidvalidity}

    def search(self, criteria, charset=None):
        lo = int(criteria[1].split(":")[0])
        return [u for u in self._uids if u >= lo]

    def fetch(self, uids, data):
        out = {}
        for u in uids:
            if b"RFC822.SIZE" in data:
                out[u] = {b"RFC822.SIZE": self._sizes.get(u, 100)}
            elif b"RFC822" in data:
                out[u] = {b"RFC822": b"raw-%d" % u, b"INTERNALDATE": None}
            else:
                out[u] = {}
        return out


def test_fetch_new_messages_only_after_last_uid(tmp_path):
    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 50)
    client = FakeClient([48, 49, 51, 52])
    msgs = fetch_new_messages(client, acc(), "INBOX", state)
    assert [m.uid for m in msgs] == [51, 52]


def test_fetch_resets_on_uidvalidity_change(tmp_path):
    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 50)
    state.set_uidvalidity("qq", "INBOX", 1)
    client = FakeClient([10, 11], uidvalidity=2)
    msgs = fetch_new_messages(client, acc(), "INBOX", state)
    assert [m.uid for m in msgs] == [10, 11]
    assert state.get_uidvalidity("qq", "INBOX") == 2


def test_fetch_initial_sync_limit_bounds_to_latest(tmp_path):
    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    big = list(range(1, 201))
    client = FakeClient(big)
    account = AccountConfig(id="qq", source="imap_qq", host="imap.qq.com", port=993,
                            username="u", password="p", folders=["INBOX"],
                            initial_sync_limit=50)
    msgs = fetch_new_messages(client, account, "INBOX", state)
    assert len(msgs) == 50
    assert msgs[0].uid == 151
    assert msgs[-1].uid == 200
    assert state.get_last_uid("qq", "INBOX") == 150


def test_fetch_batches_large_mailbox(tmp_path):
    from one_mail_agg.imap_base import BATCH_SIZE
    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    big = list(range(1, BATCH_SIZE * 3 + 1))
    client = FakeClient(big)
    msgs = fetch_new_messages(client, acc(), "INBOX", state)
    assert len(msgs) == BATCH_SIZE
    assert msgs[0].uid == 1
    assert msgs[-1].uid == BATCH_SIZE
    state.set_last_uid_max("qq", "INBOX", max(m.uid for m in msgs))
    msgs2 = fetch_new_messages(client, acc(), "INBOX", state)
    assert [m.uid for m in msgs2] == list(range(BATCH_SIZE + 1, BATCH_SIZE * 2 + 1))
    state.set_last_uid_max("qq", "INBOX", max(m.uid for m in msgs2))
    msgs3 = fetch_new_messages(client, acc(), "INBOX", state)
    assert [m.uid for m in msgs3] == list(range(BATCH_SIZE * 2 + 1, BATCH_SIZE * 3 + 1))
    state.set_last_uid_max("qq", "INBOX", max(m.uid for m in msgs3))
    assert fetch_new_messages(client, acc(), "INBOX", state) == []


def test_fetch_byte_budget_caps_window(tmp_path, monkeypatch):
    from one_mail_agg import imap_base
    monkeypatch.setattr(imap_base, "BATCH_BYTES", 1000)
    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    sizes = {1: 300, 2: 400, 3: 500, 4: 200}
    client = FakeClient([1, 2, 3, 4], sizes=sizes)
    msgs = fetch_new_messages(client, acc(), "INBOX", state)
    assert [m.uid for m in msgs] == [1, 2]


def test_fetch_missing_size_stops_at_first_retryable_hole(tmp_path):
    class NoSizeClient(FakeClient):
        def fetch(self, uids, data):
            if b"RFC822.SIZE" in data:
                return {}
            return super().fetch(uids, data)

    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    client = NoSizeClient([1, 2, 3])
    oversize = []
    msgs = fetch_new_messages(client, acc(), "INBOX", state, oversize=oversize)
    assert msgs == []
    assert oversize == [1, 2, 3]
    assert state.get_last_uid("qq", "INBOX") == 0


def test_fetch_missing_size_retries_next_success_no_loss(tmp_path):
    class NoSizeThenOkClient(FakeClient):
        def __init__(self):
            super().__init__([1, 2, 3])
            self.ok = False

        def fetch(self, uids, data):
            if b"RFC822.SIZE" in data and not self.ok:
                return {}
            return super().fetch(uids, data)

    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    client = NoSizeThenOkClient()
    oversize = []
    assert fetch_new_messages(client, acc(), "INBOX", state, oversize=oversize) == []
    assert oversize == [1, 2, 3]
    assert state.get_last_uid("qq", "INBOX") == 0

    client.ok = True
    oversize.clear()
    msgs = fetch_new_messages(client, acc(), "INBOX", state, oversize=oversize)
    assert [m.uid for m in msgs] == [1, 2, 3]
    assert oversize == []


def test_fetch_partial_missing_size_never_crosses_hole(tmp_path):
    class PartialSizeClient(FakeClient):
        def fetch(self, uids, data):
            if b"RFC822.SIZE" in data:
                out = {}
                for u in uids:
                    if u == 2:
                        out[u] = {}
                    else:
                        out[u] = {b"RFC822.SIZE": self._sizes.get(u, 100)}
                return out
            return super().fetch(uids, data)

    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    client = PartialSizeClient([1, 2, 3])
    oversize = []
    msgs = fetch_new_messages(client, acc(), "INBOX", state, oversize=oversize)
    assert [m.uid for m in msgs] == [1]
    assert oversize == [2]
    assert state.get_last_uid("qq", "INBOX") == 0

    state.set_last_uid_max("qq", "INBOX", 1)
    recovered = FakeClient([2, 3], sizes={2: 100, 3: 100})
    retry = fetch_new_messages(recovered, acc(), "INBOX", state)
    assert [m.uid for m in retry] == [2, 3]


def test_fetch_mixed_known_stops_before_first_unknown(tmp_path):
    class PartlyKnownClient(FakeClient):
        def fetch(self, uids, data):
            if b"RFC822.SIZE" in data:
                out = {}
                for u in uids:
                    if u in (2, 5):
                        out[u] = {}
                    else:
                        out[u] = {b"RFC822.SIZE": self._sizes.get(u, 100)}
                return out
            return super().fetch(uids, data)

    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    client = PartlyKnownClient([1, 2, 3, 4, 5])
    oversize = []
    msgs = fetch_new_messages(client, acc(), "INBOX", state, oversize=oversize)
    assert [m.uid for m in msgs] == [1]
    assert oversize == [2, 5]
    assert state.get_last_uid("qq", "INBOX") == 0

    state.set_last_uid_max("qq", "INBOX", 1)
    recovered = FakeClient([2, 3, 4, 5, 6], sizes={2: 10, 3: 10, 4: 10, 5: 10, 6: 20})
    msgs2 = fetch_new_messages(recovered, acc(), "INBOX", state)
    assert [m.uid for m in msgs2] == [2, 3, 4, 5, 6]


def test_fetch_huge_single_message_skipped(tmp_path, monkeypatch):
    from one_mail_agg import imap_base
    monkeypatch.setattr(imap_base, "BATCH_BYTES", 1000 ** 2)
    monkeypatch.setattr(imap_base, "MAX_SINGLE_BYTES", 20 * 1024)
    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    client = FakeClient([1, 2, 3], sizes={1: 99_999, 2: 200, 3: 300})
    msgs = fetch_new_messages(client, acc(), "INBOX", state)
    assert [m.uid for m in msgs] == [2, 3]
    assert state.get_last_uid("qq", "INBOX") >= 1
