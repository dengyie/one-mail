import json

import pytest

from one_mail_agg.config import AccountConfig, Config, load_config


def test_load_config_parses_accounts(tmp_path):
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps({
        "worker_base_url": "https://one-mail.x.workers.dev",
        "admin_token": "secret",
        "accounts": [
            {"id": "qq-main", "source": "imap_qq", "host": "imap.qq.com", "port": 993,
             "username": "a@qq.com", "password": "app-pw", "folders": ["INBOX"], "use_ssl": True}
        ],
    }))
    c = load_config(str(cfg))
    assert isinstance(c, Config)
    assert c.worker_base_url == "https://one-mail.x.workers.dev"
    assert c.accounts[0].source == "imap_qq"
    assert c.accounts[0].port == 993
    assert c.accounts[0].folders == ["INBOX"]


def test_load_config_missing_file_raises():
    with pytest.raises(FileNotFoundError):
        load_config("/nonexistent/x.json")


def test_load_config_defaults_and_slash_strip(tmp_path):
    cfg = tmp_path / "c2.json"
    cfg.write_text(json.dumps({
        "worker_base_url": "https://one-mail.x.workers.dev/",  # trailing slash
        "admin_token": "secret",
        "accounts": [
            {"id": "qq-main", "source": "imap_qq", "host": "imap.qq.com", "port": 993,
             "username": "qq@qq.com", "password": "app-pw"}  # folders/use_ssl omitted
        ],
    }))
    c = load_config(str(cfg))
    assert c.worker_base_url == "https://one-mail.x.workers.dev"
    assert c.state_path == "./sync_state.json"
    assert c.accounts[0].folders == ["INBOX"]
    assert c.accounts[0].use_ssl is True
    assert c.accounts[0].oauth is None


def test_load_config_protocol_defaults_auto(tmp_path):
    cfg = tmp_path / "c3.json"
    cfg.write_text(json.dumps({
        "worker_base_url": "u", "admin_token": "t",
        "accounts": [
            {"id": "qq", "source": "imap_qq", "host": "imap.qq.com", "port": 993,
             "username": "a@qq.com", "password": "p"}
        ],
    }))
    a = load_config(str(cfg)).accounts[0]
    # 默认协议为 auto（IMAP 优先、失败后 POP3）
    assert a.protocol == "auto"
    # 未显式指定 POP3 时，host/port/ssl/stls 为空/继承
    assert a.pop3_host == "" and a.pop3_port == 0
    assert a.pop3_ssl is None and a.pop3_use_stls is False
    # 由 imap.X 推导 pop.X 主机、默认 995 SSL
    assert a.resolve_pop3_host() == "pop.qq.com"
    assert a.resolve_pop3_port() == 995
    assert a.resolve_pop3_use_ssl() is True


def test_pop3_ssl_defaults_to_use_ssl_but_allows_explicit_override():
    inherited = AccountConfig(**{"id": "inherited", "source": "imap_qq",
                                          "host": "imap.qq.com", "port": 993,
                                          "username": "u", "password": "p",
                                          "use_ssl": False})
    assert inherited.pop3_ssl is None
    assert inherited.resolve_pop3_use_ssl() is False
    assert inherited.resolve_pop3_port() == 110

    explicit = AccountConfig(**{"id": "explicit", "source": "imap_qq",
                                         "host": "imap.qq.com", "port": 993,
                                         "username": "u", "password": "p",
                                         "use_ssl": False, "pop3_ssl": True})
    assert explicit.resolve_pop3_use_ssl() is True
    assert explicit.resolve_pop3_port() == 995


@pytest.mark.parametrize("protocol, expected", [
    (" IMAP ", "imap"), ("Pop3", "pop3"), ("AUTO", "auto"),
])
def test_protocol_is_normalized(protocol, expected):
    account = AccountConfig(id="a", source="imap_custom", host="h", port=993,
                            username="u", password="p", protocol=protocol)
    assert account.protocol == expected


@pytest.mark.parametrize("protocol", ["smtp", "", None, 1])
def test_protocol_is_strictly_rejected(protocol):
    with pytest.raises(ValueError, match="protocol"):
        AccountConfig(id="a", source="imap_custom", host="h", port=993,
                      username="u", password="p", protocol=protocol)


def test_stls_and_ssl_are_mutually_exclusive():
    with pytest.raises(ValueError, match="contradictory"):
        AccountConfig(id="a", source="imap_custom", host="h", port=993,
                      username="u", password="p", use_ssl=False,
                      pop3_ssl=True, pop3_use_stls=True)


def test_load_config_explicit_pop3_fields_and_host_derivation(tmp_path):
    cfg = tmp_path / "c4.json"
    cfg.write_text(json.dumps({
        "worker_base_url": "u", "admin_token": "t",
        "accounts": [
            {"id": "oa", "source": "imap_outlook", "host": "outlook.office365.com", "port": 993,
             "username": "u", "password": "p", "oauth": {"provider": "outlook"},
             "protocol": "imap"},
            {"id": "y163", "source": "imap_163", "host": "imap.163.com", "port": 993,
             "username": "x@163.com", "password": "p", "protocol": "pop3",
             "pop3_host": "pop.163.com", "pop3_port": 995, "pop3_ssl": True},
            {"id": "oa-nosub", "source": "imap_other", "host": "mail.example.com", "port": 993,
             "username": "u", "password": "p", "protocol": "imap"},
        ],
    }))
    a0, a1, a2 = load_config(str(cfg)).accounts
    assert a0.protocol == "imap"
    assert a1.protocol == "pop3"
    assert a1.pop3_host == "pop.163.com"
    assert a1.pop3_port == 995
    assert a1.pop3_ssl is True
    assert a1.resolve_pop3_host() == "pop.163.com"   # 显式 host 优先
    assert a2.resolve_pop3_host() == "mail.example.com"  # 非 imap. 前缀原样
