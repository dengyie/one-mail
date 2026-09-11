"""token_store 测试：RT 轮换持久化的双通道（静态 config 原子写回 / 用户账号回写 Worker）。"""
import json

from one_mail_agg import token_store
from one_mail_agg.token_store import (make_rotated_callback,
                                      persist_rotated_refresh_token,
                                      rewrite_config_refresh_token)


class _Resp:
    def __init__(self, status):
        self.status_code = status
        self.text = "x"


def _cfg_file(tmp_path):
    p = tmp_path / "config.json"
    p.write_text(json.dumps({
        "worker_base_url": "https://w", "admin_token": "t",
        "accounts": [{"id": "g1", "oauth": {"provider": "graph", "refresh_token": "OLD"}}],
    }), encoding="utf-8")
    return p


def test_rewrite_config_refresh_token(tmp_path):
    p = _cfg_file(tmp_path)
    assert rewrite_config_refresh_token(str(p), "g1", "NEW") is True
    saved = json.loads(p.read_text(encoding="utf-8"))
    assert saved["accounts"][0]["oauth"]["refresh_token"] == "NEW"


def test_rewrite_config_missing_account(tmp_path):
    p = _cfg_file(tmp_path)
    assert rewrite_config_refresh_token(str(p), "nope", "NEW") is False


def test_persist_routes_user_account_to_worker(tmp_path, monkeypatch):
    called = {}
    monkeypatch.setattr(token_store, "report_refresh_token_to_worker",
                        lambda base, tok, aid, rt: called.update({"aid": aid, "rt": rt}) or True)
    acc = type("A", (), {"id": "uuid-9", "user_managed": True})()
    persist_rotated_refresh_token(
        type("C", (), {"worker_base_url": "https://w", "admin_token": "t",
                       "config_path": None})(), acc, "NEW")
    assert called == {"aid": "uuid-9", "rt": "NEW"}


def test_report_refresh_token_to_worker_statuses(monkeypatch):
    acc_id = "uuid-1"
    for status, expected in ((200, True), (404, False), (500, False)):
        monkeypatch.setattr(token_store.requests, "post",
                            lambda url, json=None, headers=None, timeout=0, s=status:
                            _Resp(s))
        got = token_store.report_refresh_token_to_worker("https://w", "t", acc_id, "NEW")
        assert got is expected, f"status={status}"


def test_make_rotated_callback_none_config():
    assert make_rotated_callback(None, object()) is None
