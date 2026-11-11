"""token_store 测试：RT 轮换持久化的双通道（静态 config 原子写回 / 用户账号回写 Worker）。"""
import json
import os

import pytest
import requests

from one_mail_agg import token_store
from one_mail_agg.token_store import (
    TokenPersistenceError,
    make_rotated_callback,
    persist_rotated_refresh_token,
    rewrite_config_refresh_token,
)


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


@pytest.mark.skipif(os.name != "posix", reason="Requires POSIX file permission bits")
def test_rewrite_config_refresh_token_keeps_credentials_private(tmp_path):
    p = _cfg_file(tmp_path)
    os.chmod(p, 0o644)
    assert rewrite_config_refresh_token(str(p), "g1", "NEW") is True
    assert (os.stat(p).st_mode & 0o777) == 0o600


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


def test_persist_user_account_failure_raises(monkeypatch):
    monkeypatch.setattr(token_store, "report_refresh_token_to_worker", lambda *a, **k: False)
    acc = type("A", (), {"id": "uuid-9", "user_managed": True})()
    config = type("C", (), {"worker_base_url": "https://w", "admin_token": "t",
                             "config_path": None})()
    with pytest.raises(TokenPersistenceError, match="uuid-9"):
        persist_rotated_refresh_token(config, acc, "NEW")


def test_persist_static_without_config_path_raises():
    acc = type("A", (), {"id": "static-1", "user_managed": False})()
    config = type("C", (), {"worker_base_url": "https://w", "admin_token": "t",
                             "config_path": None})()
    with pytest.raises(TokenPersistenceError, match="static-1"):
        persist_rotated_refresh_token(config, acc, "NEW")


def test_report_refresh_token_to_worker_statuses(monkeypatch):
    acc_id = "uuid-1"
    for status, expected in ((200, True), (404, False), (500, False)):
        monkeypatch.setattr(token_store.requests, "post",
                            lambda url, json=None, headers=None, timeout=0, s=status:
                            _Resp(s))
        got = token_store.report_refresh_token_to_worker("https://w", "t", acc_id, "NEW")
        assert got is expected, f"status={status}"


def test_report_refresh_token_500_persists_across_three_attempts(monkeypatch):
    """2026-11-12 03:10 生产反馈：Worker/D1 瞬时 500 窗口（~12s）让单次尝试的
    RT 回写失败，hotmail 账号被误判 connection lost 重建。回写是幂等操作，
    瞬时故障必须重试吸收。"""
    monkeypatch.setattr(token_store.time, "sleep", lambda _: None)
    calls = []

    def flaky_post(url, json=None, headers=None, timeout=0):
        calls.append(1)
        return _Resp(500)

    monkeypatch.setattr(token_store.requests, "post", flaky_post)
    got = token_store.report_refresh_token_to_worker("https://w", "t", "uuid-1", "NEW")
    assert got is False
    assert len(calls) == 3, calls


def test_report_refresh_token_recovers_after_transient_500(monkeypatch):
    monkeypatch.setattr(token_store.time, "sleep", lambda _: None)
    statuses = [500, 500, 200]
    calls = []

    def flaky_post(url, json=None, headers=None, timeout=0):
        calls.append(1)
        return _Resp(statuses.pop(0))

    monkeypatch.setattr(token_store.requests, "post", flaky_post)
    got = token_store.report_refresh_token_to_worker("https://w", "t", "uuid-1", "NEW")
    assert got is True
    assert len(calls) == 3, calls


def test_report_refresh_token_4xx_is_terminal(monkeypatch):
    monkeypatch.setattr(token_store.time, "sleep", lambda _: None)
    calls = []

    def post(url, json=None, headers=None, timeout=0):
        calls.append(1)
        return _Resp(401)

    monkeypatch.setattr(token_store.requests, "post", post)
    got = token_store.report_refresh_token_to_worker("https://w", "t", "uuid-1", "NEW")
    assert got is False
    assert len(calls) == 1, calls


def test_report_refresh_token_retries_connection_error_then_recovers(monkeypatch):
    monkeypatch.setattr(token_store.time, "sleep", lambda _: None)
    calls = []

    def flaky_post(url, json=None, headers=None, timeout=0):
        calls.append(1)
        if len(calls) < 3:
            raise requests.exceptions.ConnectionError("boom")
        return _Resp(200)

    monkeypatch.setattr(token_store.requests, "post", flaky_post)
    got = token_store.report_refresh_token_to_worker("https://w", "t", "uuid-1", "NEW")
    assert got is True
    assert len(calls) == 3, calls


def test_make_rotated_callback_none_config():
    assert make_rotated_callback(None, object()) is None
