import json

import pytest

from one_mail_agg.config import Config, load_config


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
             "username": "a@qq.com", "password": "app-pw"}  # folders/use_ssl omitted
        ],
    }))
    c = load_config(str(cfg))
    assert c.worker_base_url == "https://one-mail.x.workers.dev"
    assert c.state_path == "./sync_state.json"
    assert c.accounts[0].folders == ["INBOX"]
    assert c.accounts[0].use_ssl is True
    assert c.accounts[0].oauth is None
