"""健康快照上报（2026-11 QQ 断信事故沉淀）。

覆盖：classify_error 分类表、build_account_health_snapshot 字段、
report_account_health 节流（状态不变 15 分钟内不重复 POST；变化时立即上报；
失败只 warning 不抛出）——这些是状态页与 daemon 心跳正确性的基础。
"""
import logging
import time
from unittest.mock import patch

import pytest

from one_mail_agg.config import AccountConfig, Config
from one_mail_agg.health_report import (
    HEARTBEAT_INTERVAL_SECONDS,
    build_account_health_snapshot,
    classify_error,
    report_account_health,
)
from one_mail_agg.state import SyncState


def _config() -> Config:
    return Config(worker_base_url="https://w.example", admin_token="tok",
                  accounts=[], state_path=":memory:")


def _account(aid="qq-main", *, user_managed=False) -> AccountConfig:
    return AccountConfig(id=aid, source="qq", host="imap.qq.com", port=993,
                         username="u@example.com", password="p",
                         user_managed=user_managed)


def _state(tmp_path) -> SyncState:
    return SyncState(str(tmp_path / "state.json"))


def _reset_throttle():
    from one_mail_agg import health_report
    health_report._throttle["fingerprint"] = None
    health_report._throttle["last_reported_at"] = 0.0


# --------------------------------------------------------- classify_error

@pytest.mark.parametrize("error,expected", [
    ("AUTHENTICATIONFAILED failed", "auth"),
    ("NO LOGIN failed", "auth"),
    ("Network policy rejected", "policy"),
    ("rejected by network policy", "policy"),
    ("SOCKS5 proxy connection refused", "proxy"),
    ("tunnel connection refused", "proxy"),
    ("timeout error", "conn"),
    ("Connection reset by peer", "conn"),
    ("broken pipe", "conn"),
    ("weird error", "unknown"),
    (None, ""),
])
def test_classify_error_string_table(error, expected):
    assert classify_error(error) == expected


def test_classify_error_exception_table():
    assert classify_error(ConnectionRefusedError("refused")) == "proxy"
    assert classify_error(PermissionError("denied")) == "policy"
    assert classify_error(TimeoutError("timed out")) == "conn"
    assert classify_error(RuntimeError("refresh_token write failed")) == "persist"


# --------------------------------------------------- build snapshot

def test_snapshot_covers_all_accounts_and_daemon(tmp_path, monkeypatch):
    monkeypatch.setenv("ONE_MAIL_SOCKS5_PROXY", "127.0.0.1:7897")
    state = _state(tmp_path)
    # 熔断在第 3 次连续失败才开启退避窗口（FAILBACK_MAX_FAILS=3）
    for _ in range(3):
        state.record_failure("qq-main", now=time.time())

    accounts = [_account(), _account("uma-1", user_managed=True)]
    payload = build_account_health_snapshot(_config(), state, accounts, {"uma-1"})

    assert payload["daemon"]["socks5_egress"] == "127.0.0.1:7897"
    assert payload["daemon"]["accounts_count"] == 2
    assert payload["daemon"]["aggregator_version"]
    assert [a["account_id"] for a in payload["accounts"]] == ["qq-main", "uma-1"]

    static, user = payload["accounts"]
    assert static["user_managed"] is False
    assert static["label"] is None
    assert static["source"] == "qq"
    assert static["username"] == "u@example.com"
    assert static["fail_count"] == 3
    assert static["skip_until"] > 0  # epoch ms
    assert static["idle_alive"] is False
    assert static["poll_interval_seconds"] > 0
    assert static["last_error"] is None

    assert user["user_managed"] is True
    assert user["label"] == "uma-1"
    assert user["fail_count"] == 0
    assert user["skip_until"] == 0


# ------------------------------------------------------------- report

def test_report_posts_payload_and_throttles_unchanged_state():
    _reset_throttle()
    payload = {"daemon": {"accounts_count": 1, "socks5_egress": "127.0.0.1:1080",
                          "aggregator_version": "0.1.0"},
               "accounts": [{"account_id": "qq-main", "last_error": None,
                             "error_kind": "", "fail_count": 0, "skip_until": 0,
                             "idle_alive": True}]}
    with patch("one_mail_agg.health_report.requests.post") as post:
        post.return_value.status_code = 200
        post.return_value.text = ""
        assert report_account_health(_config(), payload) is True
        assert report_account_health(_config(), payload) is False
        assert post.call_count == 1

        args, kwargs = post.call_args
        assert args[0] == "https://w.example/admin/account_health"
        assert kwargs["headers"] == {"x-admin-auth": "tok"}
        assert kwargs["json"] == payload


def test_report_immediately_on_state_change():
    _reset_throttle()
    base = {"daemon": {"accounts_count": 1, "socks5_egress": "127.0.0.1:1080",
                       "aggregator_version": "0.1.0"},
            "accounts": [{"account_id": "qq-main", "last_error": None,
                          "error_kind": "", "fail_count": 0, "skip_until": 0,
                          "idle_alive": True}]}
    with patch("one_mail_agg.health_report.requests.post") as post:
        post.return_value.status_code = 200
        report_account_health(_config(), base)
        changed = {**base, "accounts": [{**base["accounts"][0], "fail_count": 1}]}
        assert report_account_health(_config(), changed) is True
        assert post.call_count == 2


def test_report_heartbeat_after_interval():
    _reset_throttle()
    payload = {"daemon": {"accounts_count": 0, "socks5_egress": "127.0.0.1:1080",
                          "aggregator_version": "0.1.0"},
               "accounts": []}
    with patch("one_mail_agg.health_report.requests.post") as post, \
         patch("one_mail_agg.health_report.time.monotonic",
               side_effect=[0.0, 0.0, HEARTBEAT_INTERVAL_SECONDS + 1]):
        post.return_value.status_code = 200
        assert report_account_health(_config(), payload) is True
        assert report_account_health(_config(), payload) is False
        assert report_account_health(_config(), payload) is True
        assert post.call_count == 2


def test_report_failed_post_only_warns(caplog):
    _reset_throttle()
    payload = {"daemon": {"accounts_count": 0, "socks5_egress": "127.0.0.1:1080",
                          "aggregator_version": "0.1.0"},
               "accounts": []}
    with patch("one_mail_agg.health_report.requests.post",
               side_effect=RuntimeError("network down")):
        with caplog.at_level(logging.WARNING, logger="one-mail-agg"):
            assert report_account_health(_config(), payload) is False
    assert "report account health error" in caplog.text
