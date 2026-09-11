"""Graph API 同步源测试：refresh_token 轮换落盘是关键契约（不落盘 = MSA 旧 token 失效、账号永久失联）。"""
import json
from types import SimpleNamespace

import pytest

from one_mail_agg.graph_source import graph_access_token, graph_uid_key, sync_graph
from one_mail_agg.config import Config
from one_mail_agg import token_store


class _FakeResp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        assert self.status_code == 200

    def json(self):
        return self._payload


def test_graph_uid_key_has_account_and_folder_dimensions():
    acc = SimpleNamespace(id="acc1")
    key = graph_uid_key(acc, "INBOX", "msg-1")
    assert key == "graph:acc1:INBOX:msg-1"


def test_rotated_token_via_on_rotated_callback():
    captured = {}

    import one_mail_agg.graph_source as gs
    original = gs.requests.post
    gs.requests.post = lambda url, data=None, timeout=None: _FakeResp(
        {"access_token": "AT", "refresh_token": "NEW"})
    try:
        oauth = {"client_id": "cid", "refresh_token": "OLD"}
        token = graph_access_token(oauth, lambda rt: captured.setdefault("rt", rt))
    finally:
        gs.requests.post = original

    assert token == "AT"
    assert oauth["refresh_token"] == "NEW"
    assert captured["rt"] == "NEW"


def test_sync_graph_static_account_persists_to_config(tmp_path, monkeypatch):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({
        "worker_base_url": "https://w", "admin_token": "t",
        "accounts": [{"id": "g1", "source": "graph_outlook", "host": "graph.microsoft.com",
                      "port": 443, "username": "u@hotmail.com", "password": "",
                      "folders": ["INBOX"], "use_ssl": True,
                      "oauth": {"provider": "graph", "client_id": "cid", "refresh_token": "OLD"}}],
    }), encoding="utf-8")
    config = Config(worker_base_url="https://w", admin_token="t", accounts=[],
                    config_path=str(cfg_file))

    import one_mail_agg.graph_source as gs
    monkeypatch.setattr(gs.requests, "post", lambda url, data=None, timeout=None: _FakeResp({
        "access_token": "AT", "refresh_token": "NEW"}))
    # 列表/单封请求也 mock 掉：sync 只关心 token 兑换路径的落盘
    monkeypatch.setattr(gs, "fetch_graph_messages",
                        lambda token, account, folder, state: ([], []))

    acc = SimpleNamespace(id="g1", oauth={"provider": "graph", "client_id": "cid",
                                          "refresh_token": "OLD"},
                          folders=["INBOX"], initial_sync_limit=50, user_managed=False)
    state = SimpleNamespace()
    sync_graph(acc, config, state)

    saved = json.loads(cfg_file.read_text(encoding="utf-8"))
    assert saved["accounts"][0]["oauth"]["refresh_token"] == "NEW"


def test_sync_graph_user_account_reports_to_worker(tmp_path, monkeypatch):
    reported = {}
    monkeypatch.setattr(token_store, "report_refresh_token_to_worker",
                        lambda base, tok, aid, rt: reported.update(
                            {"base": base, "aid": aid, "rt": rt}) or True)

    config = Config(worker_base_url="https://w", admin_token="t", accounts=[],
                    config_path=None)
    import one_mail_agg.graph_source as gs
    monkeypatch.setattr(gs.requests, "post", lambda url, data=None, timeout=None: _FakeResp({
        "access_token": "AT", "refresh_token": "NEW"}))
    monkeypatch.setattr(gs, "fetch_graph_messages",
                        lambda token, account, folder, state: ([], []))

    acc = SimpleNamespace(id="uuid-1", oauth={"provider": "graph", "client_id": "cid",
                                              "refresh_token": "OLD"},
                          folders=["INBOX"], initial_sync_limit=50, user_managed=True)
    sync_graph(acc, config, SimpleNamespace())

    assert reported == {"base": "https://w", "aid": "uuid-1", "rt": "NEW"}


def test_same_refresh_token_no_callback():
    import one_mail_agg.graph_source as gs
    original = gs.requests.post
    gs.requests.post = lambda url, data=None, timeout=None: _FakeResp({"access_token": "AT"})
    try:
        oauth = {"client_id": "cid", "refresh_token": "SAME"}
        called = []
        graph_access_token(oauth, lambda rt: called.append(rt))
        assert called == []
    finally:
        gs.requests.post = original
