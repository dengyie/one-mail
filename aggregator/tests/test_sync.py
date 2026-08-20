import pytest
from imapclient.exceptions import IMAPClientError

import one_mail_agg.sync as sync_mod
from one_mail_agg.config import AccountConfig, Config
from one_mail_agg.imap_base import RawMessage
from one_mail_agg.state import SyncState


def _cfg(accounts):
    return Config(worker_base_url="https://one-mail.x.workers.dev", admin_token="secret",
                  accounts=accounts, state_path="st.json")


def _acc(protocol="auto", oauth=None, source="imap_163"):
    return AccountConfig(id="163-main", source=source, host="imap.163.com", port=993,
                         username="x@163.com", password="pw", folders=["INBOX"],
                         oauth=oauth, protocol=protocol,
                         pop3_host="pop.163.com", pop3_port=995, pop3_ssl=True)


class _ImapEmpty:
    """正常可用的 IMAP 连接：空收件箱（任何 folder 都无新邮件）。"""
    def __init__(self, raised=None):
        self._raised = raised
    def select_folder(self, folder, readonly=True):
        if self._raised:
            raise self._raised
        return {b"UIDVALIDITY": 1}
    def search(self, *a, **k):
        return [u for u in ()]
    def fetch(self, *a, **k):
        return {}
    def logout(self):
        pass


def _imap_factory(raised=None):
    return lambda acc: _ImapEmpty(raised)


class _PopConn:
    """poplib 兼容假连接，供 sync_pop3 的 fetch_new_pop3_messages 使用。"""
    def __init__(self, msgs):
        self._msgs = msgs      # [(uidl, raw_bytes)]
        self.quit_called = False
    def user(self, u): pass
    def pass_(self, p): pass
    def uidl(self):
        return b"+OK", [b"%d %s" % (i + 1, u.encode()) for i, (u, _r) in enumerate(self._msgs)], 0
    def list(self):
        return b"+OK", [b"%d %d" % (i + 1, len(r)) for i, (_u, r) in enumerate(self._msgs)], 0
    def retr(self, num):
        _u, raw = self._msgs[num - 1]
        return b"+OK", raw.split(b"\r\n"), len(raw)
    def quit(self):
        self.quit_called = True


class _PopFactory:
    def __init__(self, msgs):
        self._msgs = msgs
        self.made = 0
    def __call__(self, account):
        self.made += 1
        return _PopConn(self._msgs)


def _stub_upload(monkeypatch):
    calls = []
    monkeypatch.setattr(sync_mod, "upload_emails", lambda cfg, emails: calls.append(emails) or {"inserted": len(emails)})
    return calls


# ---------- 用例 ----------

def test_sync_imap_success_returns_protocol_imap(tmp_path, monkeypatch):
    calls = _stub_upload(monkeypatch)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="auto")
    res = sync_mod.sync_account(_imap_factory(), _cfg([acc]), acc, state)
    assert res["protocol"] == "imap"
    assert res["synced"] == 0
    assert calls == []            # 空收件箱不触发上传


class _ImapMsgs:
    """带真实 fetch 语义的 IMAP 桩：窗口选择交给 fetch_new_messages，
    返回固定 uid 列表的 RawMessage（大小统一小字节）。"""
    def __init__(self, uids, sizes=None, uidvalidity=7):
        self._uids = uids
        self._sizes = sizes or {}
        self._uidvalidity = uidvalidity
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
                out[u] = {b"RFC822": b"From: a@b\r\nSubject: x\r\n\r\nbody\r\n",
                          b"INTERNALDATE": None}
            else:
                out[u] = {}
        return out
    def logout(self):
        pass


def _imap_msgs_factory(uids):
    return lambda acc: _ImapMsgs(uids)


def test_sync_imap_skips_bad_single_message_others_uploaded(tmp_path, monkeypatch):
    """C3 hardening：窗口里单封 normalize 抛错（坏附件/坏头）绝不整批崩掉。
    正常的两封上传，坏的那封跳过，watermark 仍推进到这封之后（否则下轮重拉）。"""
    calls = _stub_upload(monkeypatch)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="auto")

    real = sync_mod.normalize_message

    def flaky_norm(raw, account, folder, uidvalidity, uid, internal_date_ms, **kw):
        if uid == 102:                     # uid=102 是坏邮件
            raise ValueError("simulated normalize crash")
        return real(raw, account, folder, uidvalidity, uid, internal_date_ms, **kw)

    monkeypatch.setattr(sync_mod, "normalize_message", flaky_norm)
    res = sync_mod.sync_account(_imap_msgs_factory([101, 102, 103]), _cfg([acc]), acc, state)

    assert res["protocol"] == "imap"
    assert res["synced"] == 2                       # 幸存的 101,103 才计数
    assert res["dropped"] == 1                     # uid=102 归一化失败被跳过（可观测）
    assert len(calls) == 1 and len(calls[0]) == 2   # 只上传正常的两封
    assert [e["imap_uid"] for e in calls[0]] == [
        "imap.163.com:INBOX:7:101",
        "imap.163.com:INBOX:7:103",
    ]
    # watermark 推进到窗口最大 uid（103），哪怕中间那封 skip 也不再重拉
    assert state.get_last_uid("163-main", "INBOX") == 103


def test_sync_imap_all_bad_still_advances_watermark(tmp_path, monkeypatch):
    """C3 hardening 边界：整个窗口每封 normalize 都失败也不得卡死——
    watermark 照常推进，否则每轮都重拉同一个坏窗口（与 MAX_SINGLE_BYTES 口径一致）。"""
    calls = _stub_upload(monkeypatch)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="auto")

    def all_bad(*a, **k):
        raise ValueError("everything broke")

    monkeypatch.setattr(sync_mod, "normalize_message", all_bad)
    res = sync_mod.sync_account(_imap_msgs_factory([101, 102]), _cfg([acc]), acc, state)

    assert res["protocol"] == "imap"
    assert res["synced"] == 0
    assert res["dropped"] == 2                     # 两封都归一化失败 → dropped 聚合
    assert calls == []                              # 无任何上传
    assert state.get_last_uid("163-main", "INBOX") == 102   # 水印照进


def test_sync_imap_oversize_skips_count_in_dropped(tmp_path, monkeypatch):
    """fetch 层 MAX_SINGLE_BYTES 跳过的大封要计入 dropped（review Important-2）：
    oversize 跳过不能再只靠隐式 per-message warning，必须聚合进 sync_account 结果。"""
    from one_mail_agg import imap_base
    monkeypatch.setattr(imap_base, "BATCH_BYTES", 10 ** 9)      # 放大预算，不截窗口
    monkeypatch.setattr(imap_base, "MAX_SINGLE_BYTES", 20 * 1024)  # 单封 20KB 上限
    calls = _stub_upload(monkeypatch)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="auto")

    # uid=1 的大封被跳过（99KB），uid=2,3 正常
    client = _ImapMsgs([1, 2, 3], sizes={1: 99_999, 2: 200, 3: 300})
    res = sync_mod.sync_account(lambda acc: client, _cfg([acc]), acc, state)

    assert res["synced"] == 2                 # 只有正常的两封上传
    assert res["dropped"] == 1                # 大封被跳过 → 计入 dropped
    assert [e["imap_uid"] for e in calls[0]] == [
        "imap.163.com:INBOX:7:2",
        "imap.163.com:INBOX:7:3",
    ]
    # 水印推进过 uid=1（跳过内容不丢水位），不再卡在同一大封上
    assert state.get_last_uid("163-main", "INBOX") == 3


def test_sync_imap_all_oversize_window_still_counts_dropped(tmp_path, monkeypatch):
    """整个窗口都是超大单封（msgs 为空）时，oversize 跳过不能漏计：
    `continue` 前必须先累加 dropped。watermark 由 fetch 层推进到最大 uid。"""
    from one_mail_agg import imap_base
    monkeypatch.setattr(imap_base, "BATCH_BYTES", 10 ** 9)
    monkeypatch.setattr(imap_base, "MAX_SINGLE_BYTES", 1000)
    calls = _stub_upload(monkeypatch)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="auto")

    client = _ImapMsgs([10, 11], sizes={10: 99_999, 11: 88_888})   # 全大封
    res = sync_mod.sync_account(lambda acc: client, _cfg([acc]), acc, state)

    assert res["protocol"] == "imap"
    assert res["synced"] == 0
    assert res["dropped"] == 2                # 两封都超限 → 都计入 dropped
    assert calls == []                        # 无任何上传
    assert state.get_last_uid("163-main", "INBOX") == 11   # 水印推过全部大封


def test_sync_imap_oversize_above_picked_does_not_regress_watermark(tmp_path, monkeypatch):
    """整窗包含「最大 uid 是超限单封」时（[1,2,3,1000_超限]），最终水印必须取
    fetch 层已推过的超限值（1000），不能用已挑出的较小 max（3）使它回落——
    否则下轮重拉 4..1000 含 1000 的死循环。"""
    from one_mail_agg import imap_base
    monkeypatch.setattr(imap_base, "BATCH_BYTES", 10 ** 9)
    monkeypatch.setattr(imap_base, "MAX_SINGLE_BYTES", 1000)
    calls = _stub_upload(monkeypatch)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="auto")

    client = _ImapMsgs([1, 2, 1000], sizes={1: 100, 2: 200, 1000: 99_999})  # 1000 超限
    res = sync_mod.sync_account(lambda acc: client, _cfg([acc]), acc, state)

    assert res["synced"] == 2                 # 只上传 1,2
    assert res["dropped"] == 1                # 1000 超限被跳过 → dropped
    # 不得回落到 3（1,2 的最大），必须保持 1000（fetch 层已推过超限封）
    assert state.get_last_uid("163-main", "INBOX") == 1000


def test_sync_pop3_skips_bad_uidl_retries_next_round(tmp_path, monkeypatch):
    """C3 hardening：POP3 路径坏 UIDL 归一整崩掉时跳过上传且**不标记 seen**，
    下一轮 fetch 会重新拉它；只有成功归一化的 UIDL 被 seen。"""
    calls = _stub_upload(monkeypatch)
    real = sync_mod.normalize_message

    gate = {"bad": True}   # 第一轮 UL-BAD 抛错；第二轮恢复

    def flaky_norm(raw, account, folder, uidvalidity=0, uid=0,
                   internal_date_ms=None, imap_uid_override=None):
        if gate["bad"] and imap_uid_override and imap_uid_override.endswith("UL-BAD"):
            raise ValueError("simulated pop3 normalize crash")
        return real(raw, account, folder, uidvalidity, uid,
                    internal_date_ms, imap_uid_override=imap_uid_override)

    monkeypatch.setattr(sync_mod, "normalize_message", flaky_norm)

    # 第一轮：UL-1 正常、UL-BAD 坏
    pop_f = _PopFactory([("UL-1", b"From: a@b\r\nSubject: ok\r\n\r\n1\r\n"),
                         ("UL-BAD", b"broken-raw-does-not-matter")])
    monkeypatch.setattr(sync_mod, "connect_pop3", pop_f)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="pop3")
    res = sync_mod.sync_account(None, _cfg([acc]), acc, state)
    assert res["protocol"] == "pop3"
    assert res["synced"] == 1                    # 只有成功的那封
    assert res["dropped"] == 1                   # UL-BAD 归一化失败 → dropped 可观测
    assert len(calls) == 1 and len(calls[0]) == 1
    # UL-BAD 未标记 seen：下一轮会重试
    assert state.get_pop3_seen("163-main", "INBOX") == {"UL-1"}

    # 第二轮：UL-BAD 修好了 → 命中，被 seen
    gate["bad"] = False
    pop_f2 = _PopFactory([("UL-1", b"From: a@b\r\nSubject: ok\r\n\r\n1\r\n"),
                          ("UL-BAD", b"From: c@d\r\nSubject: fixed\r\n\r\n2\r\n")])
    monkeypatch.setattr(sync_mod, "connect_pop3", pop_f2)
    res2 = sync_mod.sync_account(None, _cfg([acc]), acc, state)
    assert res2["synced"] == 1
    assert res2["dropped"] == 0                  # 全部成功，无 dropped
    assert state.get_pop3_seen("163-main", "INBOX") == {"UL-1", "UL-BAD"}


def test_sync_auto_falls_back_to_pop3_on_select_failure(tmp_path, monkeypatch):
    """IMAP 的 EXAMINE/SELECT 返回 Unsafe Login（163）→ auto 降级 POP3。"""
    calls = _stub_upload(monkeypatch)
    pop_f = _PopFactory([("UL-1", b"From: a@b\r\nSubject: hi\r\n\r\nbody\r\n")])
    monkeypatch.setattr(sync_mod, "connect_pop3", pop_f)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="auto")
    res = sync_mod.sync_account(_imap_factory(raised=IMAPClientError("Unsafe Login")),
                                _cfg([acc]), acc, state)
    assert res["protocol"] == "pop3"
    assert res["synced"] == 1
    assert res["dropped"] == 0
    assert pop_f.made == 1
    assert len(calls) == 1
    assert calls[0][0]["imap_uid"].startswith("pop3:")
    # 上传成功后 UIDL 标记 seen
    assert state.get_pop3_seen("163-main", "INBOX") == {"UL-1"}


def test_sync_pop3_oversize_skips_count_in_dropped(tmp_path, monkeypatch):
    """POP3 路径 MAX_SINGLE_BYTES 跳过（fetch 层标记 seen）要计入 dropped：超限
    懒上传语义下该封永久放弃，聚合计数让运维能看到「多少封因超限被扔」。"""
    from one_mail_agg import pop3_source
    monkeypatch.setattr(pop3_source, "BATCH_BYTES", 10 ** 9)
    monkeypatch.setattr(pop3_source, "MAX_SINGLE_BYTES", 1000)   # 单封 1KB 上限
    calls = _stub_upload(monkeypatch)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="pop3")
    huge = b"From: b@c\r\nSubject: huge\r\n\r\n" + b"X" * 2000   # > 1KB 大封
    pop_f = _PopFactory([("UL-1", b"From: a@b\r\nSubject: ok\r\n\r\n1\r\n"),
                         ("UL-A", huge),
                         ("UL-2", b"From: d@e\r\nSubject: two\r\n\r\n2\r\n")])
    monkeypatch.setattr(sync_mod, "connect_pop3", pop_f)
    res = sync_mod.sync_account(None, _cfg([acc]), acc, state)
    assert res["protocol"] == "pop3"
    assert res["synced"] == 2                      # UL-1, UL-2 上传
    assert res["dropped"] == 1                     # UL-A 超限 → dropped
    # 超限的 UL-A 被标记 seen（下轮不重拉），其余成功上传的也 seen
    assert state.get_pop3_seen("163-main", "INBOX") == {"UL-1", "UL-2", "UL-A"}


def test_sync_pop3_all_oversize_window_counts_dropped_not_error(tmp_path, monkeypatch):
    """审查 Important：#2 —— POP3 整窗全超限（fetch 全部返回空、全部标记 seen）
    必须返回 `synced=0, dropped=N` 且**不抛错**。这一语义随时会被改坏：若未来
    把「全超限」当成 all-bad（抛 RuntimeError），`_fallback_to_pop3` 就会在
    `dropped` 全被永久丢弃时把账号**钉住**并报错。测试钉死行为。"""
    from one_mail_agg import pop3_source
    monkeypatch.setattr(pop3_source, "BATCH_BYTES", 10 ** 9)
    monkeypatch.setattr(pop3_source, "MAX_SINGLE_BYTES", 1000)   # 单封 1KB 上限
    calls = _stub_upload(monkeypatch)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="pop3")
    huge = b"From: b@c\r\nSubject: huge\r\n\r\n" + b"X" * 2000   # > 1KB 大封
    pop_f = _PopFactory([("UL-A", huge), ("UL-B", huge)])        # 整窗全超限
    monkeypatch.setattr(sync_mod, "connect_pop3", pop_f)
    res = sync_mod.sync_account(None, _cfg([acc]), acc, state)
    assert res["protocol"] == "pop3"
    assert res["synced"] == 0
    assert res["dropped"] == 2                # 两封都超限 → 都计入 dropped
    assert calls == []                        # 无任何上传
    # 超限 UIDL 都被标记 seen（懒弃置），但不是 all-bad → 不抛 RuntimeError
    assert state.get_pop3_seen("163-main", "INBOX") == {"UL-A", "UL-B"}


def test_sync_explicit_imap_does_not_fallback(tmp_path, monkeypatch):
    """显式 protocol=imap 时 IMAP 失败必须抛错，不得降级 POP3。"""
    calls = _stub_upload(monkeypatch)
    pop_f = _PopFactory([])
    monkeypatch.setattr(sync_mod, "connect_pop3", pop_f)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="imap")
    with pytest.raises(IMAPClientError):
        sync_mod.sync_account(_imap_factory(raised=IMAPClientError("Unsafe Login")),
                              _cfg([acc]), acc, state)
    assert pop_f.made == 0          # 未创建 POP3 连接


def test_sync_explicit_pop3_goes_directly(tmp_path, monkeypatch):
    """显式 protocol=pop3 直接走 POP3，不尝试 IMAP。"""
    calls = _stub_upload(monkeypatch)
    pop_f = _PopFactory([("UL-9", b"From: z@y\r\nSubject: pop\r\n\r\nx\r\n")])
    monkeypatch.setattr(sync_mod, "connect_pop3", pop_f)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="pop3")

    def never_imap(acc):
        raise AssertionError("IMAP factory must not be called for protocol=pop3")

    res = sync_mod.sync_account(never_imap, _cfg([acc]), acc, state)
    assert res["protocol"] == "pop3"
    assert res["synced"] == 1
    assert pop_f.made == 1


def test_sync_oauth_failure_does_not_fallback(tmp_path, monkeypatch):
    """OAuth 账号没有可复用的 POP3 密码：IMAP 失败不能降级。"""
    calls = _stub_upload(monkeypatch)
    pop_f = _PopFactory([])
    monkeypatch.setattr(sync_mod, "connect_pop3", pop_f)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(oauth={"provider": "gmail"})
    with pytest.raises(IMAPClientError):
        sync_mod.sync_account(_imap_factory(raised=IMAPClientError("boom")),
                              _cfg([acc]), acc, state)
    assert pop_f.made == 0

def test_sync_auto_pins_fallback_after_first_pop3(tmp_path, monkeypatch):
    """auto 账号一旦降级到 POP3 就被钉住：后续轮不再重试 IMAP，直接 POP3。

    保证不会在同一账号内产生 imap:/pop3: 两套 imap_uid 键的重复行。
    """
    calls = _stub_upload(monkeypatch)
    pop_f = _PopFactory([("UL-P1", b"From: p@q\r\nSubject: first\r\n\r\n1\r\n")])
    monkeypatch.setattr(sync_mod, "connect_pop3", pop_f)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="auto")

    # 第一轮：IMAP 失败 → 降级，钉住
    res = sync_mod.sync_account(_imap_factory(raised=IMAPClientError("Unsafe Login")),
                                _cfg([acc]), acc, state)
    assert res["protocol"] == "pop3" and res["synced"] == 1
    assert state.is_fallback_pinned("163-main")

    # 第二轮：就算 IMAP 已恢复（空收件箱正常），也被钉在 POP3
    pop_f2 = _PopFactory([("UL-P2", b"From: r@s\r\nSubject: more\r\n\r\n2\r\n")])
    monkeypatch.setattr(sync_mod, "connect_pop3", pop_f2)
    res2 = sync_mod.sync_account(_imap_factory(), _cfg([acc]), acc, state)   # IMAP 正常
    assert res2["protocol"] == "pop3"
    # 只同步 POP3 的新 UIDL（UL-P1 已 seen；POP3 新到 UL-P2）
    assert res2["synced"] == 1
    # 上传只走 POP3 键，且只有 1 封
    assert len(calls) == 2


def test_sync_oauth_never_pins(tmp_path, monkeypatch):
    """OAuth 账号 IMAP 失败：不降级、不钉住（无 POP3 密码）。"""
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(oauth={"provider": "gmail"})
    with pytest.raises(IMAPClientError):
        sync_mod.sync_account(_imap_factory(raised=IMAPClientError("boom")),
                              _cfg([acc]), acc, state)
    assert not state.is_fallback_pinned("163-main")


def test_sync_pop3_failure_does_not_pin(tmp_path, monkeypatch):
    """IMAP 失败且 POP3 也失败：不得钉住，保留下轮 IMAP 仍可用的机会。

    回归：钉住逻辑只应在 POP3 同步成功后才写入，避免「IMAP 短暂抖动 + POP3 也挂」
    把账号永久锁死在 POP3。
    """
    calls = _stub_upload(monkeypatch)
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="auto")

    def failing_pop3(account):
        raise OSError("pop3 connection refused")

    monkeypatch.setattr(sync_mod, "connect_pop3", failing_pop3)
    with pytest.raises(OSError):
        sync_mod.sync_account(_imap_factory(raised=IMAPClientError("Unsafe Login")),
                              _cfg([acc]), acc, state)
    assert not state.is_fallback_pinned("163-main")   # 未钉住
    assert calls == []                                 # 未上传任何邮件


def test_sync_imap_upload_failure_does_not_advance_watermark(tmp_path, monkeypatch):
    """upload 失败（worker 挂 / 网络断）→ 异常上抛，水印**不**推进。

    回归：set_last_uid 必须留在 upload 之后。若先推进水印再 upload，整批丢了却
    无处可查，下轮直接跳过这一窗口（C3 类似死锁的镜像问题）；正确行为是 upload
    抛错 → 水印留在原窗口 → 下轮从同一窗口重试续传。
    """
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="auto")

    def failing_upload(cfg, emails):
        raise RuntimeError("worker ingest 500")

    monkeypatch.setattr(sync_mod, "upload_emails", failing_upload)
    with pytest.raises(RuntimeError, match="worker ingest 500"):
        sync_mod.sync_account(_imap_msgs_factory([101, 102]), _cfg([acc]), acc, state)
    # 水印未推进：下轮 fetch_new_messages 仍从 0 拉同样 [101,102]
    assert state.get_last_uid("163-main", "INBOX") == 0


def test_sync_pop3_upload_failure_marks_nothing_seen(tmp_path, monkeypatch):
    """POP3 upload 失败 → 异常上抛，**不**标记任何 UIDL seen。

    上传失败时 add_pop3_seen_many 不能执行，否则已上传/未上传混同；下轮重新拉
    同批 UIDL 重试续传。上传成功后正常标记，见 test_sync_pop3_skips_..., 唯一
    区别是这里 upload 中途失败。
    """
    state = SyncState(str(tmp_path / "st.json"))
    acc = _acc(protocol="pop3")
    pop_f = _PopFactory([("UL-1", b"From: a@b\r\nSubject: ok\r\n\r\n1\r\n")])
    monkeypatch.setattr(sync_mod, "connect_pop3", pop_f)

    def failing_upload(cfg, emails):
        raise RuntimeError("worker ingest 500")

    monkeypatch.setattr(sync_mod, "upload_emails", failing_upload)
    with pytest.raises(RuntimeError, match="worker ingest 500"):
        sync_mod.sync_account(None, _cfg([acc]), acc, state)
    # 什么都没标记 seen：下轮重新拉 UL-1 再试
    assert state.get_pop3_seen("163-main", "INBOX") == set()
