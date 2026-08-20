from one_mail_agg import pop3_source as pop3_mod
from one_mail_agg.config import AccountConfig
from one_mail_agg.state import SyncState
from one_mail_agg.pop3_source import (
    connect_pop3, uidl_to_key, fetch_new_pop3_messages,
    POP3_UID_PREFIX, _uidl_list, _list_sizes,
)


def _acc():
    return AccountConfig(
        id="163-main", source="imap_163", host="imap.163.com", port=993,
        username="x@163.com", password="p", protocol="auto",
        pop3_host="pop.163.com", pop3_port=995, pop3_ssl=True,
    )


class FakePOP3:
    """最小可用的 POP3 假客户端，模拟 poplib 返回元组形态。

    msgs: [(uidl, raw_bytes, size_bytes)] — 第 i 封 message number = i+1。
    避免依赖真实网络；fetch_new_pop3_messages 只认 uidl()/list()/retr()。
    """

    def __init__(self, msgs):
        self._msgs = msgs
        self.quit_called = False
        self.retr_calls = []

    def uidl(self):
        lines = [b"%d %s" % (i + 1, u.encode()) for i, (u, _r, _s) in enumerate(self._msgs)]
        return b"+OK", lines, 0

    def list(self):
        lines = [b"%d %d" % (i + 1, s) for i, (_u, _r, s) in enumerate(self._msgs)]
        return b"+OK", lines, 0

    def retr(self, num):
        self.retr_calls.append(num)
        uidl, raw, _sz = self._msgs[num - 1]
        return b"+OK", raw.split(b"\r\n"), len(raw)

    def quit(self):
        self.quit_called = True


def _raw(subject="hi", body="body"):
    return f"From: a@b\r\nTo: x@163.com\r\nSubject: {subject}\r\n\r\n{body}".encode()


def test_uidl_to_key_pop3_namespace():
    key = uidl_to_key(_acc(), "INBOX", "UIDL-ABC")
    assert key == "pop3:pop.163.com:INBOX:UIDL-ABC"
    assert key.startswith(POP3_UID_PREFIX)


def test_fetch_sees_no_new_when_all_already_seen(tmp_path):
    st = SyncState(str(tmp_path / "st.json"))
    st.add_pop3_seen("163-main", "INBOX", "UL-1")
    st.add_pop3_seen("163-main", "INBOX", "UL-2")
    conn = FakePOP3([("UL-1", _raw("a"), 100), ("UL-2", _raw("b"), 90)])
    got = fetch_new_pop3_messages(conn, _acc(), "INBOX", st)
    assert got == []
    assert conn.retr_calls == []        # 未 RETR 任何已见邮件


def test_fetch_new_picks_unseen(tmp_path):
    st = SyncState(str(tmp_path / "st.json"))
    st.add_pop3_seen("163-main", "INBOX", "UL-1")
    conn = FakePOP3([
        ("UL-1", _raw("seen"), 100),
        ("UL-2", _raw("new"), 120),
        ("UL-3", _raw("newer"), 80),
    ])
    got = fetch_new_pop3_messages(conn, _acc(), "INBOX", st)
    assert {m.uidl for m in got} == {"UL-2", "UL-3"}
    # retr 的 msg number 与 UIDL 一致（FakePOP3 顺序即 number）
    assert got[0].raw_bytes == _raw("new")
    assert got[1].internal_date_ms is None        # 无 Date 头 → None


def test_pop3_seen_does_not_resync_after_upload(tmp_path):
    """上传成功后 sync 标记 seen，下一轮不再出现。"""
    st = SyncState(str(tmp_path / "st.json"))
    conn = FakePOP3([("UL-1", _raw("a", b"v"), 100), ("UL-2", _raw("b", b"w"), 120)])
    got1 = fetch_new_pop3_messages(conn, _acc(), "INBOX", st)
    assert len(got1) == 2
    # 模拟 sync 层上传成功后标记 seen
    for m in got1:
        st.add_pop3_seen("163-main", "INBOX", m.uidl)
    got2 = fetch_new_pop3_messages(conn, _acc(), "INBOX", st)
    assert got2 == []


def test_pop3_message_number_reordering_does_not_lose_mail(tmp_path):
    """POP3 的 message number 会在删除后重排，但 UIDL 稳定：即使 number 变了，
    已见 UIDL 不重拉，未见的仍能拉到，不会丢。"""
    st = SyncState(str(tmp_path / "st.json"))
    # 首轮看到 UL-1, UL-2（num 1..2）
    conn1 = FakePOP3([("UL-1", _raw("a"), 10), ("UL-2", _raw("b"), 20)])
    got1 = fetch_new_pop3_messages(conn1, _acc(), "INBOX", st)
    assert {m.uidl for m in got1} == {"UL-1", "UL-2"}
    for m in got1:
        st.add_pop3_seen("163-main", "INBOX", m.uidl)
    # 服务器删除 UL-1，UL-2 重排成 num 1，新增 UL-3 是 num 2
    conn2 = FakePOP3([("UL-2", _raw("b"), 20), ("UL-3", _raw("c"), 30)])
    got2 = fetch_new_pop3_messages(conn2, _acc(), "INBOX", st)
    assert {m.uidl for m in got2} == {"UL-3"}     # UL-2 已见不重拉，UL-3 新拉
    assert conn2.retr_calls == [2]                 # 只 RETR 新的 num=2


def test_pop3_skip_oversize_marks_seen(tmp_path):
    """超过 MAX_SINGLE_BYTES 的单封跳过并标记 seen，避免每轮重拉同一封。"""
    old = pop3_mod.MAX_SINGLE_BYTES
    pop3_mod.MAX_SINGLE_BYTES = 1000   # 单封上限
    try:
        st = SyncState(str(tmp_path / "st.json"))
        conn = FakePOP3([
            ("UL-A", _raw("huge"), 5000),   # 超限
            ("UL-B", _raw("ok"), 300),       # 正常
        ])
        got = fetch_new_pop3_messages(conn, _acc(), "INBOX", st)
        assert [m.uidl for m in got] == ["UL-B"]
        # 超限单封被标记 seen，下一轮不会再 RETR
        assert "UL-A" in st.get_pop3_seen("163-main", "INBOX")
        # UL-B 上传成功后 sync 层标记 seen → 下一轮什么都不拉
        st.add_pop3_seen("163-main", "INBOX", "UL-B")
        got2 = fetch_new_pop3_messages(conn, _acc(), "INBOX", st)
        assert got2 == []
    finally:
        pop3_mod.MAX_SINGLE_BYTES = old


def test_pop3_list_size_budget(tmp_path):
    """LIST 累加字节预算：超出 BATCH_BYTES 即截断窗口。"""
    old = pop3_mod.BATCH_BYTES
    pop3_mod.BATCH_BYTES = 1000
    try:
        st = SyncState(str(tmp_path / "st.json"))
        conn = FakePOP3([
            ("UL-1", _raw("a"), 800),
            ("UL-2", _raw("b"), 400),   # 800+400>1000 截断
            ("UL-3", _raw("c"), 30),
        ])
        got = fetch_new_pop3_messages(conn, _acc(), "INBOX", st)
        assert [m.uidl for m in got] == ["UL-1"]
    finally:
        pop3_mod.BATCH_BYTES = old


def test_uidl_list_and_list_sizes_parse():
    conn = FakePOP3([("UL-1", b"a", 100), ("UL-2", b"b", 200)])
    assert _uidl_list(conn) == [(1, "UL-1"), (2, "UL-2")]
    assert _list_sizes(conn) == {"1": 100, "2": 200}


def test_connect_pop3_picks_ssl_port_and_stls(monkeypatch):
    calls = []

    class FakeConn:
        def __init__(self, *a, **k):
            calls.append(("ctor", a, k))
        def user(self, u): calls.append(("user", u))
        def pass_(self, p): calls.append(("pass", p))
        def stls(self): calls.append(("stls",))
        def quit(self): calls.append(("quit",))

    monkeypatch.setattr(pop3_mod, "POP3_SSL", FakeConn)
    monkeypatch.setattr(pop3_mod, "POP3", FakeConn)
    conn = connect_pop3(_acc())   # use_ssl=True → POP3_SSL
    assert conn is not None
    assert calls[0][0] == "ctor"
    end = calls[-1][0]
    assert end in ("user", "pass")
    # 不触发 stls（SSL 分支不需要）
    assert all(c[0] != "stls" for c in calls)

def test_pop3_missing_list_size_treated_as_oversize(tmp_path):
    """LIST 缺失/解析不了该封的 size 时，必须保守按超大处理，防止未知尺寸旁路
    字节预算（重要发现 #4 回归）。"""
    class NoSizeConn(FakePOP3):
        def list(self):
            # 只返回 num=1 的 size；num=2 缺失
            return b"+OK", [b"1 500"], 0

    st = SyncState(str(tmp_path / "st.json"))
    conn = NoSizeConn([
        ("UL-1", b"From: a@b\r\nSubject: one\r\n\r\n1\r\n", 500),
        ("UL-2", b"From: c@d\r\nSubject: two\r\n\r\n2\r\n", 600_000_000),  # 实际超大
    ])
    got = fetch_new_pop3_messages(conn, _acc(), "INBOX", st)
    # num2 的 size 缺失 → 按超上限保守跳过并标记 seen
    assert [m.uidl for m in got] == ["UL-1"]
    assert "UL-2" in st.get_pop3_seen("163-main", "INBOX")
