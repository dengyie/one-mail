"""修复 #1 回归：imap_uid / POP3 uidl_to_key 去重键缺账号维度。

背景：旧键 `host:folder:uidvalidity:uid` 只拼主机维度。同主机多账号 +
UIDVALIDITY 恒 1 + 每邮箱 uid 从 1 起 → Worker `imap_uid` 唯一索引
`INSERT OR IGNORE` 会把后续用户整封邮件静默吞掉（高危隐性丢信）。

修复：键里加账号维度（`account.id` 打头）。本组测试钉死：
- 同 host 不同 account 构造同 folder/uidvalidity/uid → 键不同；
- 同账号同年份同键 → 相同（幂等，去重仍有效）。
"""
from one_mail_agg.config import AccountConfig
from one_mail_agg.imap_base import make_imap_uid
from one_mail_agg.pop3_source import uidl_to_key


def _acc(aid: str, host: str = "imap.example.com"):
    return AccountConfig(id=aid, source="imap_custom", host=host, port=993,
                         username=f"{aid}@example.com", password="p",
                         folders=["INBOX"])


def _pop_acc(aid: str, host: str = "imap.example.com") -> AccountConfig:
    return AccountConfig(id=aid, source="imap_custom", host=host, port=993,
                         username=f"{aid}@example.com", password="p",
                         folders=["INBOX"], protocol="pop3",
                         pop3_host="pop.example.com", pop3_port=995,
                         pop3_ssl=True)


def test_imap_key_differs_by_account_same_host_uid():
    """同 host、同 folder、同 UIDVALIDITY、同 uid，不同账号 → 键必须不同。"""
    a = make_imap_uid("user-A", "imap.example.com", "INBOX", 1, 1)
    b = make_imap_uid("user-B", "imap.example.com", "INBOX", 1, 1)
    assert a != b
    assert a.startswith("user-A:")
    assert b.startswith("user-B:")


def test_imap_key_same_account_same_uid_is_idempotent():
    a1 = make_imap_uid("user-A", "imap.example.com", "INBOX", 1, 5)
    a2 = make_imap_uid("user-A", "imap.example.com", "INBOX", 1, 5)
    assert a1 == a2


def test_imap_key_same_account_diff_uid_differs():
    a1 = make_imap_uid("user-A", "imap.example.com", "INBOX", 1, 5)
    a2 = make_imap_uid("user-A", "imap.example.com", "INBOX", 1, 6)
    assert a1 != a2


def test_imap_key_diff_host_same_account_uid_differs():
    a1 = make_imap_uid("user-A", "imap.example.com", "INBOX", 1, 5)
    a2 = make_imap_uid("user-A", "imap.other.net", "INBOX", 1, 5)
    assert a1 != a2


def test_pop3_key_different_by_account_id():
    """POP3：同 host 不同 account 的同 UIDL → 键必须不同（UIDL 集合不跨账号串）。"""
    a = uidl_to_key(_pop_acc("user-A"), "INBOX", "UIDL-9")
    b = uidl_to_key(_pop_acc("user-B"), "INBOX", "UIDL-9")
    assert a != b
    assert a == "pop3:user-A:pop.example.com:INBOX:UIDL-9"
    assert b == "pop3:user-B:pop.example.com:INBOX:UIDL-9"


def test_pop3_key_same_account_same_uidl_idempotent():
    a1 = uidl_to_key(_pop_acc("user-A"), "INBOX", "UIDL-9")
    a2 = uidl_to_key(_pop_acc("user-A"), "INBOX", "UIDL-9")
    assert a1 == a2


def test_pop3_key_scoped_to_pop3_host_not_imap_host():
    """POP3 键用账号的 pop3 host（不是 imap host）：沿用既有的 resolve_pop3_host 语义。"""
    acc = _pop_acc("user-A")
    key = uidl_to_key(acc, "INBOX", "UIDL-9")
    assert "pop.example.com" in key
    assert "imap.example.com" not in key