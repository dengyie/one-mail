from one_mail_agg.imap_base import make_imap_uid, fetch_new_messages
from one_mail_agg.state import SyncState
from one_mail_agg.config import AccountConfig


def acc():
    return AccountConfig(id="qq", source="imap_qq", host="imap.qq.com", port=993,
                         username="u", password="p", folders=["INBOX"])


def test_make_imap_uid_format():
    assert make_imap_uid("imap.qq.com", "INBOX", 7, 123) == "imap.qq.com:INBOX:7:123"


def test_state_roundtrip(tmp_path):
    s = SyncState(str(tmp_path / "st.json"))
    s.set_last_uid("qq", "INBOX", 50)
    s.set_uidvalidity("qq", "INBOX", 9)
    s2 = SyncState(str(tmp_path / "st.json"))  # reload
    assert s2.get_last_uid("qq", "INBOX") == 50
    assert s2.get_uidvalidity("qq", "INBOX") == 9


class FakeClient:
    def __init__(self, uids, uidvalidity=1):
        self._uids = uids
        self._uidvalidity = uidvalidity
    def select_folder(self, folder, readonly=True):
        return {b"UIDVALIDITY": self._uidvalidity}
    def search(self, criteria, charset=None):
        # criteria like ["UID", "51:*"] — 真实 IMAP 语义：UID >= 51 全部返回
        lo = int(criteria[1].split(":")[0])
        return [u for u in self._uids if u >= lo]
    def fetch(self, uids, data):
        return {u: {b"RFC822": b"raw-%d" % u, b"INTERNALDATE": None} for u in uids}


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
    client = FakeClient([10, 11], uidvalidity=2)   # UIDVALIDITY 变了
    msgs = fetch_new_messages(client, acc(), "INBOX", state)
    assert [m.uid for m in msgs] == [10, 11]        # 全量重拉
    assert state.get_uidvalidity("qq", "INBOX") == 2


def test_fetch_batches_large_mailbox(tmp_path):
    # 大批量收件箱：每次取最小窗口 BATCH_SIZE 封，多轮收敛到最后一窗
    from one_mail_agg.imap_base import BATCH_SIZE
    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    big = list(range(1, BATCH_SIZE * 3 + 1))          # 600 封
    client = FakeClient(big)
    # 第一轮：最低 200 封（1..200），last_uid 推进到 200
    msgs = fetch_new_messages(client, acc(), "INBOX", state)
    assert len(msgs) == BATCH_SIZE
    assert msgs[0].uid == 1
    assert msgs[-1].uid == BATCH_SIZE                 # 200
    # 落库端推进 watermark（模拟 sync.py 行为）
    state.set_last_uid("qq", "INBOX", max(m.uid for m in msgs))
    # 第二轮：201..400
    msgs2 = fetch_new_messages(client, acc(), "INBOX", state)
    assert [m.uid for m in msgs2] == list(range(BATCH_SIZE + 1, BATCH_SIZE * 2 + 1))
    state.set_last_uid("qq", "INBOX", max(m.uid for m in msgs2))
    # 第三轮：401..600（末窗）
    msgs3 = fetch_new_messages(client, acc(), "INBOX", state)
    assert [m.uid for m in msgs3] == list(range(BATCH_SIZE * 2 + 1, BATCH_SIZE * 3 + 1))
    state.set_last_uid("qq", "INBOX", max(m.uid for m in msgs3))
    # 全部收敛后再跑一轮：无新邮件
    assert fetch_new_messages(client, acc(), "INBOX", state) == []