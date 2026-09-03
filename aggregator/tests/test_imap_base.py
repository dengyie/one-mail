from one_mail_agg.imap_base import make_imap_uid, fetch_new_messages
from one_mail_agg.state import SyncState
from one_mail_agg.config import AccountConfig


def acc(initial_sync_limit: int = 0):
    return AccountConfig(id="qq", source="imap_qq", host="imap.qq.com", port=993,
                         username="u", password="p", folders=["INBOX"],
                         initial_sync_limit=initial_sync_limit)


def test_make_imap_uid_format():
    # 键含账号维度：account_id 打头，同主机多账号不同 uid 不撞唯一索引
    assert make_imap_uid("qq", "imap.qq.com", "INBOX", 7, 123) == "qq:imap.qq.com:INBOX:7:123"


def test_state_roundtrip(tmp_path):
    s = SyncState(str(tmp_path / "st.json"))
    s.set_last_uid("qq", "INBOX", 50)
    s.set_uidvalidity("qq", "INBOX", 9)
    s2 = SyncState(str(tmp_path / "st.json"))  # reload
    assert s2.get_last_uid("qq", "INBOX") == 50
    assert s2.get_uidvalidity("qq", "INBOX") == 9


class FakeClient:
    def __init__(self, uids, uidvalidity=1, sizes=None):
        self._uids = uids
        self._uidvalidity = uidvalidity
        self._sizes = sizes or {}          # uid -> int bytes（RFC822.SIZE 响应）
    def select_folder(self, folder, readonly=True):
        return {b"UIDVALIDITY": self._uidvalidity}
    def search(self, criteria, charset=None):
        # criteria like ["UID", "51:*"] — 真实 IMAP 语义：UID >= 51 全部返回
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
    client = FakeClient([10, 11], uidvalidity=2)   # UIDVALIDITY 变了
    msgs = fetch_new_messages(client, acc(), "INBOX", state)
    assert [m.uid for m in msgs] == [10, 11]        # 全量重拉
    assert state.get_uidvalidity("qq", "INBOX") == 2


def test_fetch_initial_sync_limit_bounds_to_latest(tmp_path):
    """首次同步且邮件量超过 initial_sync_limit 时，只拉最新的 N 封，旧邮件推过水印。"""
    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    big = list(range(1, 201))  # 200 封邮件
    client = FakeClient(big)
    account = AccountConfig(id="qq", source="imap_qq", host="imap.qq.com", port=993,
                            username="u", password="p", folders=["INBOX"],
                            initial_sync_limit=50)
    msgs = fetch_new_messages(client, account, "INBOX", state)
    assert len(msgs) == 50
    assert msgs[0].uid == 151
    assert msgs[-1].uid == 200
    # 旧邮件已推过水印
    assert state.get_last_uid("qq", "INBOX") == 150


def test_fetch_batches_large_mailbox(tmp_path):
    # 大批量收件箱：每次取最小窗口 BATCH_SIZE 封，多轮收敛到最后一窗
    from one_mail_agg.imap_base import BATCH_SIZE
    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    big = list(range(1, BATCH_SIZE * 3 + 1))          # 600 封
    client = FakeClient(big)
    # 第一轮：最低 BATCH_SIZE 封（1..50），last_uid 推进到 50
    msgs = fetch_new_messages(client, acc(), "INBOX", state)
    assert len(msgs) == BATCH_SIZE
    assert msgs[0].uid == 1
    assert msgs[-1].uid == BATCH_SIZE
    # 落库端推进 watermark（模拟 sync.py 行为）
    state.set_last_uid_max("qq", "INBOX", max(m.uid for m in msgs))
    # 第二轮：51..100
    msgs2 = fetch_new_messages(client, acc(), "INBOX", state)
    assert [m.uid for m in msgs2] == list(range(BATCH_SIZE + 1, BATCH_SIZE * 2 + 1))
    state.set_last_uid_max("qq", "INBOX", max(m.uid for m in msgs2))
    # 第三轮：101..150
    msgs3 = fetch_new_messages(client, acc(), "INBOX", state)
    assert [m.uid for m in msgs3] == list(range(BATCH_SIZE * 2 + 1, BATCH_SIZE * 3 + 1))
    state.set_last_uid_max("qq", "INBOX", max(m.uid for m in msgs3))
    # 全部收敛后再跑一轮：无新邮件
    assert fetch_new_messages(client, acc(), "INBOX", state) == []


def test_fetch_byte_budget_caps_window(tmp_path, monkeypatch):
    """超大附件窗口按字节预算截断，而不是一窗塞满 BATCH_SIZE——防 OOM。"""
    from one_mail_agg import imap_base
    monkeypatch.setattr(imap_base, "BATCH_BYTES", 1000)   # 预算 1KB
    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    # uid 1..4：size 300,400,500,200
    sizes = {1: 300, 2: 400, 3: 500, 4: 200}
    client = FakeClient([1, 2, 3, 4], sizes=sizes)
    msgs = fetch_new_messages(client, acc(), "INBOX", state)
    # 300+400=700 → 加 500 会超 1000，故只取 1,2
    assert [m.uid for m in msgs] == [1, 2]


def test_fetch_missing_size_fail_closed_skips_all(tmp_path):
    """修复 #4：RFC822.SIZE 服务器不支持（imap_custom 常见）→ 每封 size 缺失。
    旧行为每封 size=0，永不触发 MAX_SINGLE_BYTES → 超大邮件整封进内存。
    新行为「未知 = 超限」fail-closed 跳过全部（计入 oversize/dropped 可观测），
    但**不推进水印**（H1）——全部未知时 last_uid 保持 0，整批绝不永久丢失。"""
    class NoSizeClient(FakeClient):
        def fetch(self, uids, data):
            if b"RFC822.SIZE" in data:
                return {}            # 服务器对 SIZE 无响应（不支持）
            return super().fetch(uids, data)

    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    client = NoSizeClient([1, 2, 3])
    oversize = []
    msgs = fetch_new_messages(client, acc(), "INBOX", state, oversize=oversize)
    assert msgs == []                     # 未拉任何正文
    assert oversize == [1, 2, 3]          # 全部按未知尺寸跳过（计入 dropped）
    assert state.get_last_uid("qq", "INBOX") == 0   # 水印未动：整批留待下轮重试，绝不丢信


def test_fetch_missing_size_retries_next_success_no_loss(tmp_path):
    """H1 回归：SIZE 全缺失时整批跳过且**不推进 last_uid**；下一轮服务器恢复
    返回 SIZE → 从 `last_uid+1`（起点）重新 fetch 能拉到全部——绝不丢信。"""
    class NoSizeThenOkClient(FakeClient):
        def __init__(self):
            super().__init__([1, 2, 3])
            self.ok = False                       # 可变：第二轮翻转为 True
        def fetch(self, uids, data):
            if b"RFC822.SIZE" in data and not self.ok:
                return {}                         # SIZE 不支持期：空响应
            return super().fetch(uids, data)

    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    client = NoSizeThenOkClient()

    # 第一轮：全未知（fail-closed 跳过，dropped 可观测），水印不前
    oversize = []
    assert fetch_new_messages(client, acc(), "INBOX", state, oversize=oversize) == []
    assert oversize == [1, 2, 3]
    assert state.get_last_uid("qq", "INBOX") == 0

    # 第二轮：服务器恢复返回 SIZE → 起点 (0+1):* 重新拉到全部，一封不丢
    client.ok = True
    oversize.clear()
    msgs = fetch_new_messages(client, acc(), "INBOX", state, oversize=oversize)
    assert [m.uid for m in msgs] == [1, 2, 3]
    assert oversize == []


def test_fetch_partial_missing_size_skips_only_unknown(tmp_path):
    """修复 #4 部分缺失：服务器对多数封有 SIZE、对个别封无响应 → 只跳过未知那个，
    已知大小的照常拉取；且未知封不推进水印（H1）。"""
    class PartialSizeClient(FakeClient):
        def fetch(self, uids, data):
            if b"RFC822.SIZE" in data:
                out = {}
                for u in uids:
                    if u == 2:
                        out[u] = {}            # uid=2 无 SIZE
                    else:
                        out[u] = {b"RFC822.SIZE": self._sizes.get(u, 100)}
                return out
            return super().fetch(uids, data)

    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    client = PartialSizeClient([1, 2, 3])
    oversize = []
    msgs = fetch_new_messages(client, acc(), "INBOX", state, oversize=oversize)
    assert [m.uid for m in msgs] == [1, 3]    # uid=2 被跳过
    assert oversize == [2]
    # 未知封（uid=2）写在 oversize/dropped、但 fetch 层未推水印——sync 层在
    # upload 后把水印推进到窗口 max（3）；此处 fetch 本身不擅自推进到 2。
    assert state.get_last_uid("qq", "INBOX") == 0


def test_fetch_mixed_known_advances_unknown_stays(tmp_path):
    """H1 边界：SIZE 全缺失的服务器偶发对个别封返回 SIZE（如网络抖动/服务器
    部分恢复）——已知封照常挑出，未知封跳过且不推水印；sync 层在 upload 后把
    水印推进到**已挑出**的最大 uid，未知封留在下轮起点内再试（而真超限封仍
    立即推过水印，语义分离）。"""
    class PartlyKnownClient(FakeClient):
        def fetch(self, uids, data):
            if b"RFC822.SIZE" in data:
                out = {}
                for u in uids:
                    if u in (2, 5):
                        out[u] = {}            # 这两个未知（服务器无响应）
                    else:
                        out[u] = {b"RFC822.SIZE": self._sizes.get(u, 100)}
                return out
            return super().fetch(uids, data)

    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    client = PartlyKnownClient([1, 2, 3, 4, 5])
    oversize = []
    msgs = fetch_new_messages(client, acc(), "INBOX", state, oversize=oversize)
    assert [m.uid for m in msgs] == [1, 3, 4]    # 2、5 未知跳过
    assert oversize == [2, 5]
    # 未知封 2、5 不推水位——fetch 层保持 0，sync 层 upload 后推进到 picked max=4
    assert state.get_last_uid("qq", "INBOX") == 0
    state.set_last_uid_max("qq", "INBOX", 4)     # 模拟 sync 层 upload 后推进
    # 下一轮从 5 起步：uid=5（上次未知）现在能拿到 SIZE → 拉到，不丢
    client2 = FakeClient([5, 6], sizes={5: 10, 6: 20})
    msgs2 = fetch_new_messages(client2, acc(), "INBOX", state)
    assert [m.uid for m in msgs2] == [5, 6]


def test_fetch_huge_single_message_skipped(tmp_path, monkeypatch):
    """超 #预算（IMAP QQ 附件）拉取会撑爆容器内存（pxed K8s cgroup）：
    必须跳过该封并已推过水印，避免反复卡在同一封。"""
    from one_mail_agg import imap_base
    monkeypatch.setattr(imap_base, "BATCH_BYTES", 1000 ** 2)   # 1MB 预算
    monkeypatch.setattr(imap_base, "MAX_SINGLE_BYTES", 20 * 1024)  # 20KB 单封上限
    state = SyncState(str(tmp_path / "st.json"))
    state.set_last_uid("qq", "INBOX", 0)
    # uid=1 超限大封，uid=2,3 正常
    client = FakeClient([1, 2, 3], sizes={1: 99_999, 2: 200, 3: 300})
    msgs = fetch_new_messages(client, acc(), "INBOX", state)
    # 大封(uid 1)被跳过，但同窗口 uid2/3 仍会返回
    assert [m.uid for m in msgs] == [2, 3]
    # 水印至少推进到 1（跳过内容不丢水位，不会再卡在 uid1）
    assert state.get_last_uid("qq", "INBOX") >= 1