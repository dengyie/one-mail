"""Graph API 同步源测试：refresh_token 轮换落盘是关键契约（不落盘 = MSA 旧 token 失效、账号永久失联）。"""
import json

import pytest

from one_mail_agg.graph_source import graph_access_token, graph_uid_key


class _FakeResp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        assert self.status_code == 200

    def json(self):
        return self._payload


def test_graph_uid_key_has_account_and_folder_dimensions():
    from types import SimpleNamespace
    acc = SimpleNamespace(id="acc1")
    key = graph_uid_key(acc, "INBOX", "msg-1")
    assert key == "graph:acc1:INBOX:msg-1"


def test_rotated_refresh_token_persisted_to_config(tmp_path, monkeypatch):
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({
        "worker_base_url": "https://w", "admin_token": "t",
        "accounts": [{"id": "g1", "source": "graph_outlook", "host": "graph.microsoft.com",
                      "port": 443, "username": "u@hotmail.com", "password": "",
                      "folders": ["INBOX"], "use_ssl": True,
                      "oauth": {"provider": "graph", "client_id": "cid", "refresh_token": "OLD"}}],
    }), encoding="utf-8")

    calls = {}

    def fake_post(url, data=None, timeout=None):
        calls["payload"] = data
        return _FakeResp({"access_token": "AT", "refresh_token": "NEW"})

    monkeypatch.setattr("one_mail_agg.graph_source.requests.post", fake_post)

    oauth = {"provider": "graph", "client_id": "cid", "refresh_token": "OLD"}
    token = graph_access_token(oauth, str(cfg_path), "g1")

    assert token == "AT"
    assert oauth["refresh_token"] == "NEW"
    saved = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert saved["accounts"][0]["oauth"]["refresh_token"] == "NEW"


def test_refresh_token_not_persisted_without_config_path(tmp_path, monkeypatch):
    def fake_post(url, data=None, timeout=None):
        return _FakeResp({"access_token": "AT", "refresh_token": "NEW"})

    monkeypatch.setattr("one_mail_agg.graph_source.requests.post", fake_post)
    oauth = {"provider": "graph", "client_id": "cid", "refresh_token": "OLD"}
    graph_access_token(oauth)
    # 内存里的 oauth 已更新（本轮可继续用），但没有落盘路径可写
    assert oauth["refresh_token"] == "NEW"


def test_same_refresh_token_no_rewrite(tmp_path, monkeypatch):
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({
        "worker_base_url": "https://w", "admin_token": "t", "accounts": [],
    }), encoding="utf-8")

    def fake_post(url, data=None, timeout=None):
        return _FakeResp({"access_token": "AT"})

    monkeypatch.setattr("one_mail_agg.graph_source.requests.post", fake_post)
    oauth = {"provider": "graph", "client_id": "cid", "refresh_token": "SAME"}
    graph_access_token(oauth, str(cfg_path), "g1")
    # 响应无 refresh_token：不得写盘
    assert json.loads(cfg_path.read_text(encoding="utf-8"))["accounts"] == []
