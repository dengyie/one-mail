import pytest
from imapclient.exceptions import IMAPClientError

import one_mail_agg.sync as sync_mod
from one_mail_agg.config import AccountConfig, Config
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
    assert pop_f.made == 1
    assert len(calls) == 1
    assert calls[0][0]["imap_uid"].startswith("pop3:")
    # 上传成功后 UIDL 标记 seen
    assert state.get_pop3_seen("163-main", "INBOX") == {"UL-1"}


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
