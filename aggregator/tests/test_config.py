import json

import pytest

from one_mail_agg.config import AccountConfig, Config, ShardConfig, load_config


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


def test_load_config_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_config(str(tmp_path / "missing.json"))


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


def _shard(**overrides):
    return {"id": "s1", "base_url": "https://s1.example/", "token": "x" * 32,
            "accounts": ["external", "remote-user"], **overrides}


def test_load_static_shards_and_route_unknown_and_cf_routing_to_primary(tmp_path):
    path = tmp_path / "shards.json"
    path.write_text(json.dumps({"worker_base_url": "https://primary.example",
                                "admin_token": "admin", "accounts": [],
                                "shards": [_shard()]}))
    config = load_config(str(path))
    assert isinstance(config.shards[0], ShardConfig)
    assert config.shards[0].base_url == "https://s1.example"
    assert config.destination_for({"account_id": "remote-user"}).id == "s1"
    assert config.destination_for({"account_id": "external"}) is config.destinations[1]
    assert config.destination_for({"account_id": "unknown"}).id == "primary"
    assert config.destination_for({}).id == "primary"
    assert config.destination_for({"source": "cf_routing", "account_id": "external"}).id == "primary"
    assert "x" * 32 not in repr(config.shards[0])
    assert "x" * 32 not in repr(config.destinations[1])


def test_shards_default_empty_and_allow_empty_account_list():
    config = Config("https://primary.example", "admin", [])
    assert config.shards == []
    assert len(config.destinations) == 1
    config = Config("https://primary.example", "admin", [], shards=[_shard(accounts=[])])
    assert len(config.destinations) == 2  # Still drain old jobs on an unassigned shard.


@pytest.mark.parametrize("shards", [
    None, {}, "s1", [None], [[]],
    [_shard(id="")], [_shard(id="primary")], [_shard(id=1)],
    [_shard(token="")], [_shard(token="short")], [_shard(token=None)],
    [_shard(token="x" * 32 + "\n")],
    [_shard(base_url=None)], [_shard(base_url="http://s1.example")],
    [_shard(base_url="https://")], [_shard(base_url="https://user:pass@s1.example")],
    [_shard(base_url="https://@s1.example")],
    [_shard(base_url="https://s1.example/path")],
    [_shard(base_url="https://s1.example?token=secret")],
    [_shard(base_url="https://s1.example#fragment")],
    [_shard(base_url="https://s1.example:invalid")],
    [_shard(base_url="https://s1.example:0")],
    [_shard(base_url="https://s1.exa mple")],
    [_shard(accounts="external")], [_shard(accounts=None)],
    [_shard(accounts=[1])], [_shard(accounts=[""])],
    [_shard(accounts=["external", " external "])],
    [_shard(), _shard(base_url="https://s2.example", accounts=[])],
    [_shard(), _shard(id="s2", accounts=[])],
    [_shard(), _shard(id="s2", base_url="https://s2.example")],
    [_shard(base_url="https://PRIMARY.example/")],
    [{"id": "s1"}], [_shard(typo=True)],
])
def test_invalid_static_shards_are_rejected(shards):
    with pytest.raises(ValueError):
        Config("https://primary.example", "admin", [], shards=shards)


def test_load_config_rejects_bad_shards(tmp_path):
    path = tmp_path / "bad-shards.json"
    path.write_text(json.dumps({"worker_base_url": "https://primary.example",
                                "admin_token": "admin", "accounts": [],
                                "shards": [_shard(accounts="external")]}))
    with pytest.raises(ValueError, match="accounts"):
        load_config(str(path))


def test_shard_validation_and_routing_do_not_scan_account_lists():
    class TrackedAccountId(str):
        comparisons = 0
        __hash__ = str.__hash__

        def strip(self):
            return self

        def __eq__(self, other):
            type(self).comparisons += 1
            return str.__eq__(self, other)

    account_ids = [TrackedAccountId(f"account-{i}") for i in range(1000)]
    config = Config("https://primary.example", "admin", [],
                    shards=[_shard(accounts=account_ids)])
    for account_id in account_ids:
        assert config.destination_for({"account_id": account_id}) is config.destinations[1]
    # Hash-based validation and lookup stay linear; list membership would make
    # roughly n*(n-1)/2 comparisons even before routing starts.
    assert TrackedAccountId.comparisons <= 2 * len(account_ids)
    assert config.shards[0].accounts == tuple(account_ids)


def test_shard_account_normalization_preserves_order():
    config = Config("https://primary.example", "admin", [],
                    shards=[_shard(accounts=[" second ", "first"])])
    assert config.shards[0].accounts == ("second", "first")
    assert config.destination_for({"account_id": "second"}) is config.destinations[1]
