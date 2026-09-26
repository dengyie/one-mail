import time
from one_mail_agg.config import AccountConfig, Config
from one_mail_agg.state import SyncState
from one_mail_agg.proxy_client import create_imap_client, _maybe_send_id
from one_mail_agg.main import is_rate_limit_error, get_account_poll_interval, _poll_pass, _ACCOUNT_LAST_POLL


def test_id_command_sent_when_capability_present():
    sent = []

    class MockIMAPClient:
        def __init__(self, host, port=993, ssl=True, timeout=30):
            self.host = host

        def has_capability(self, cap):
            return cap == "ID"

        def id_(self, params):
            sent.append(params)
            return {"name": "Coremail"}

    acc = AccountConfig(id="test163", source="imap_163", host="imap.163.com", port=993,
                        username="user@163.com", password="pwd")
    client = create_imap_client(acc, direct_client_cls=MockIMAPClient, proxied_client_cls=MockIMAPClient)
    assert len(sent) == 1
    assert sent[0].get("name") == "one-mail-agg"


def test_id_command_skipped_when_capability_absent():
    sent = []

    class MockIMAPClient:
        def __init__(self, host, port=993, ssl=True, timeout=30):
            pass

        def has_capability(self, cap):
            return False

        def id_(self, params):
            sent.append(params)

    acc = AccountConfig(id="testqq", source="imap_qq", host="imap.qq.com", port=993,
                        username="user@qq.com", password="pwd")
    create_imap_client(acc, direct_client_cls=MockIMAPClient, proxied_client_cls=MockIMAPClient)
    assert len(sent) == 0


def test_account_poll_interval_defaults_and_custom(tmp_path):
    st = SyncState(str(tmp_path / "st.json"))

    # POP3 默认 600s
    pop_acc = AccountConfig(id="pop1", source="imap_custom", host="pop.example.com", port=995,
                            username="u", password="p", protocol="pop3")
    assert get_account_poll_interval(pop_acc, st) == 600

    # 163 IMAP 默认 300s
    imap163_acc = AccountConfig(id="i163", source="imap_163", host="imap.163.com", port=993,
                                username="u@163.com", password="p", protocol="imap")
    assert get_account_poll_interval(imap163_acc, st) == 300

    # 126 IMAP 默认 300s（防网易频控）
    imap126_acc = AccountConfig(id="i126", source="imap_custom", host="imap.126.com", port=993,
                                username="u@126.com", password="p", protocol="imap")
    assert get_account_poll_interval(imap126_acc, st) == 300

    # Gmail / QQ / Outlook / 海外邮箱若残留 pin，不施加 600s 惩罚
    for acc in [
        AccountConfig(id="g", source="imap_gmail", host="imap.gmail.com", port=993, username="u", password="p"),
        AccountConfig(id="q", source="imap_qq", host="imap.qq.com", port=993, username="u", password="p"),
        AccountConfig(id="o", source="imap_outlook", host="outlook.office365.com", port=993, username="u", password="p"),
        AccountConfig(id="y", source="imap_custom", host="imap.mail.yahoo.com", port=993, username="u", password="p"),
    ]:
        st.set_fallback_pinned(acc.id, True)
        assert get_account_poll_interval(acc, st) == 60

    # 自定义配置优先
    custom_acc = AccountConfig(id="c1", source="imap_custom", host="imap.example.com", port=993,
                               username="u", password="p", poll_interval=120)
    assert get_account_poll_interval(custom_acc, st) == 120

    # 普通账号走默认 60s
    std_acc = AccountConfig(id="s1", source="imap_custom", host="imap.other.com", port=993,
                            username="u", password="p")
    assert get_account_poll_interval(std_acc, st, default_poll_interval=60) == 60


def test_is_rate_limit_error():
    # 网易 163 真实返回的 GBK 错误 bytes
    err_163_bytes = Exception(b"-ERR \xb5\xc7\xc2\xbc\xcc\xab\xc6\xb5\xb7\xb1!\xc7\xeb\xbc\xec\xb2\xe9\xc4\xfa\xb5\xc4outlook...")
    assert is_rate_limit_error(err_163_bytes) is True

    # 包含流量超限
    err_pop_quota = Exception("客户端POP流量使用已超过上限")
    assert is_rate_limit_error(err_pop_quota) is True

    # 英文频控
    err_en = Exception("Too frequent requests, please wait")
    assert is_rate_limit_error(err_en) is True

    # 普通网络超时或凭据错误
    err_normal = Exception("Connection timed out")
    assert is_rate_limit_error(err_normal) is False


def test_record_rate_limit_backoff(tmp_path):
    st = SyncState(str(tmp_path / "st.json"))
    now = 10000.0
    skip_until = st.record_rate_limit_backoff("acc1", backoff_sec=1800, now=now)
    assert skip_until == 11800.0
    assert st.should_skip_account("acc1", now=10000.0) is True
    assert st.should_skip_account("acc1", now=11799.0) is True
    assert st.should_skip_account("acc1", now=11801.0) is False


def test_poll_pass_respects_account_interval(tmp_path, monkeypatch):
    _ACCOUNT_LAST_POLL.clear()
    st = SyncState(str(tmp_path / "st.json"))
    pop_acc = AccountConfig(id="pop-acc", source="imap_custom", host="pop.163.com", port=995,
                            username="u@163.com", password="p", protocol="pop3")
    cfg = Config(worker_base_url="https://w", admin_token="t", accounts=[pop_acc],
                 state_path=str(tmp_path / "st.json"))

    sync_calls = []
    monkeypatch.setattr("one_mail_agg.main.sync_account", lambda factory, config, account, state: sync_calls.append(account.id) or {"synced": 0})
    monkeypatch.setattr("one_mail_agg.main.fetch_user_accounts", lambda *a: [])

    # 第 1 次 poll (t=0)：执行同步
    _poll_pass(cfg, st, now=0.0)
    assert len(sync_calls) == 1

    # 第 2 次 poll (t=60s)：由于 pop3 默认间隔为 600s，不应重复调用
    _poll_pass(cfg, st, now=60.0)
    assert len(sync_calls) == 1

    # 第 3 次 poll (t=300s)：依然未达 600s，跳过
    _poll_pass(cfg, st, now=300.0)
    assert len(sync_calls) == 1

    # 第 4 次 poll (t=601s)：超过 600s，触发第二次同步
    _poll_pass(cfg, st, now=601.0)
    assert len(sync_calls) == 2
