from unittest.mock import patch, MagicMock

import pytest
import requests

from one_mail_agg.config import AccountConfig
from one_mail_agg.remote_accounts import fetch_user_accounts, report_sync_status


def _resp(status, body):
    r = MagicMock()
    r.status_code = status
    r.json.return_value = body
    return r


def test_maps_worker_response_to_account_configs():
    body = {"accounts": [
        {"id": "uma-1", "source": "imap_gmail", "host": "imap.gmail.com", "port": 993,
         "username": "u@gmail.com", "password": "app-pw-1", "protocol": "auto",
         "folders": ["INBOX"], "oauth": None},
        {"id": "uma-2", "source": "imap_qq", "host": "imap.qq.com", "port": 993,
         "username": "u@qq.com", "password": "app-pw-2", "protocol": "imap"},
    ]}
    with patch("one_mail_agg.remote_accounts.requests.get", return_value=_resp(200, body)):
        accts = fetch_user_accounts("https://w.example", "tok")
    assert len(accts) == 2
    assert isinstance(accts[0], AccountConfig)
    assert accts[0].id == "uma-1"
    assert accts[0].password == "app-pw-1"   # 解密后明文，供 IMAP 登录
    assert accts[1].protocol == "imap"


def test_maps_imap_and_pop3_settings_and_folders():
    body = {"accounts": [
        {"id": "imap", "source": "imap_custom", "host": "imap.example",
         "port": 993, "username": "imap-u", "password": "pw", "protocol": "imap",
         "use_ssl": False, "folders": ["INBOX", "Archive"],
         "pop3_host": "pop.example", "pop3_port": 1110, "pop3_ssl": False,
         "pop3_use_stls": True},
        {"id": "pop", "source": "imap_custom", "host": "imap.example",
         "port": 993, "username": "pop-u", "password": "pw", "protocol": "pop3",
         "folders": ["INBOX"], "pop3_host": "pop.example", "pop3_port": "995",
         "pop3_ssl": True},
    ]}
    with patch("one_mail_agg.remote_accounts.requests.get", return_value=_resp(200, body)):
        imap, pop = fetch_user_accounts("https://w.example", "tok")
    assert (imap.use_ssl, imap.folders) == (False, ["INBOX", "Archive"])
    assert (imap.pop3_host, imap.pop3_port, imap.pop3_ssl, imap.pop3_use_stls) == (
        "pop.example", 1110, False, True)
    assert (pop.protocol, pop.pop3_host, pop.pop3_port, pop.pop3_ssl) == (
        "pop3", "pop.example", 995, True)


def test_remote_account_defaults_and_malformed_folders():
    body = {"accounts": [
        {"id": "defaults", "host": "imap.example", "port": 993,
         "username": "u", "password": "pw"},
        {"id": "bad-folders", "host": "imap.example", "port": 993,
         "username": "v", "password": "pw", "folders": "INBOX"},
        {"id": "empty-folders", "host": "imap.example", "port": 993,
         "username": "w", "password": "pw", "folders": ["", 1, " Archive "]},
    ]}
    with patch("one_mail_agg.remote_accounts.requests.get", return_value=_resp(200, body)):
        defaults, malformed, filtered = fetch_user_accounts("https://w.example", "tok")
    assert defaults.folders == ["INBOX"]
    assert defaults.use_ssl is True
    assert defaults.pop3_host == "" and defaults.pop3_port == 0
    assert defaults.pop3_ssl is None and defaults.pop3_use_stls is False
    assert malformed.folders == ["INBOX"]
    assert filtered.folders == ["Archive"]


def test_non_dict_or_non_list_worker_payload_is_fail_safe(caplog):
    for body in (None, [], {"accounts": {}}, {"accounts": "bad"}):
        with patch("one_mail_agg.remote_accounts.requests.get", return_value=_resp(200, body)):
            assert fetch_user_accounts("https://w.example", "tok") == []


def test_invalid_port_and_bool_are_rejected_per_account():
    body = {"accounts": [
        {"id": "bad-port", "host": "h", "port": True, "username": "u", "password": "p"},
        {"id": "bad-pop-port", "host": "h", "port": 993, "username": "u", "password": "p",
         "pop3_port": 0},
        {"id": "bad-bool", "host": "h", "port": 993, "username": "u", "password": "p",
         "use_ssl": 1},
        {"id": "good", "host": "h", "port": 993, "username": "u", "password": "p"},
    ]}
    with patch("one_mail_agg.remote_accounts.requests.get", return_value=_resp(200, body)):
        accounts = fetch_user_accounts("https://w.example", "tok")
    assert [account.id for account in accounts] == ["good"]


def test_non_200_returns_empty():
    with patch("one_mail_agg.remote_accounts.requests.get", return_value=_resp(500, {})):
        assert fetch_user_accounts("https://w.example", "tok") == []


def test_network_error_returns_empty():
    with patch("one_mail_agg.remote_accounts.requests.get", side_effect=Exception("boom")):
        assert fetch_user_accounts("https://w.example", "tok") == []


@pytest.mark.parametrize("status,body", [(503, {}), (200, None), (200, []),
                                         (200, {"accounts": {}})])
def test_strict_account_fetch_surfaces_unavailable_or_invalid_metadata(status, body):
    with patch("one_mail_agg.remote_accounts.requests.get", return_value=_resp(status, body)):
        with pytest.raises(RuntimeError):
            fetch_user_accounts("https://w.example", "tok", raise_on_error=True)


def test_strict_account_fetch_surfaces_network_error_but_allows_empty_accounts():
    with patch("one_mail_agg.remote_accounts.requests.get", side_effect=requests.Timeout("down")):
        with pytest.raises(requests.Timeout):
            fetch_user_accounts("https://w.example", "tok", raise_on_error=True)
    with patch("one_mail_agg.remote_accounts.requests.get", return_value=_resp(200, {"accounts": []})):
        assert fetch_user_accounts("https://w.example", "tok", raise_on_error=True) == []


def test_malformed_account_skipped_others_continue():
    body = {"accounts": [
        {"id": "good", "source": "imap_qq", "host": "h", "port": 993,
         "username": "u@qq.com", "password": "pw"},
        {"id": "bad", "host": "h"},  # 缺 username/password
    ]}
    with patch("one_mail_agg.remote_accounts.requests.get", return_value=_resp(200, body)):
        accts = fetch_user_accounts("https://w.example", "tok")
    assert len(accts) == 1
    assert accts[0].id == "good"


def test_report_sync_status_success_post_error():
    """成功 sync（error=None）→ POST 空 body；URL/方法/头正确。"""
    with patch("one_mail_agg.remote_accounts.requests.post") as post:
        post.return_value = _resp(200, {})
        report_sync_status("https://w.example", "tok", "uma-1", None)
    post.assert_called_once()
    args, kwargs = post.call_args
    assert args[0] == "https://w.example/admin/unified/mail_accounts/uma-1/status"
    assert kwargs["headers"] == {"x-admin-auth": "tok"}
    assert kwargs["json"] == {}  # 无 error → 空 body（worker 清空 last_error）


def test_report_sync_status_failure_post_error_string():
    """失败 sync → POST 带 error 字符串。"""
    with patch("one_mail_agg.remote_accounts.requests.post") as post:
        post.return_value = _resp(200, {})
        report_sync_status("https://w.example", "tok", "uma-1", "IMAP login failed: -ERR")
    post.assert_called_once()
    args, kwargs = post.call_args
    assert kwargs["json"] == {"error": "IMAP login failed: -ERR"}


def test_report_sync_status_404_silent():
    """admin config 账号无对应行 → 404，静默不报错（不阻塞 sync 主流程）。"""
    with patch("one_mail_agg.remote_accounts.requests.post") as post:
        post.return_value = _resp(404, {})
        report_sync_status("https://w.example", "tok", "admin-acct", None)
    post.assert_called_once()  # 仍发了请求，但 404 不触发 warning


def test_report_sync_status_network_error_does_not_raise():
    """回写网络异常绝不向上抛——状态回写挂了不能影响邮件归集主流程。"""
    with patch("one_mail_agg.remote_accounts.requests.post", side_effect=Exception("boom")):
        report_sync_status("https://w.example", "tok", "uma-1", "err")  # 不抛


# ------------------------------------------- transient transport retry

def _patch_sleep():
    """Keep the retry's pacing out of the test's runtime."""
    return patch("one_mail_agg.transport_retry.time.sleep")


def test_report_sync_status_retries_once_after_a_read_timeout(caplog):
    """生产上一个 10s 停顿会让这次状态回写整条丢掉（last_sync_at 落后一轮）。
    响应可安全重发，因此一次停顿必须被一次重试吸收，而不是记为失败。"""
    with _patch_sleep(), patch("one_mail_agg.remote_accounts.requests.post") as post:
        post.side_effect = [requests.ReadTimeout("stalled"), _resp(200, {})]
        with caplog.at_level("WARNING"):
            report_sync_status("https://w.example", "tok", "uma-1", None)
    assert post.call_count == 2
    assert "report sync status for uma-1 error" not in caplog.text


def test_report_sync_status_keeps_failing_softly_when_both_attempts_stall(caplog):
    with _patch_sleep(), patch("one_mail_agg.remote_accounts.requests.post") as post:
        post.side_effect = requests.ReadTimeout("stalled")
        with caplog.at_level("WARNING"):
            report_sync_status("https://w.example", "tok", "uma-1", "err")
    assert post.call_count == 2
    assert "report sync status for uma-1 error" in caplog.text


def test_report_sync_status_does_not_retry_a_non_transport_failure():
    """只有传输层失败才重试；其余异常保持单次尝试，避免掩盖真实错误。"""
    with _patch_sleep(), patch("one_mail_agg.remote_accounts.requests.post") as post:
        post.side_effect = ValueError("bad payload")
        report_sync_status("https://w.example", "tok", "uma-1", None)
    assert post.call_count == 1


def test_fetch_user_accounts_retries_once_after_a_read_timeout():
    body = {"accounts": [
        {"id": "uma-1", "host": "imap.example", "port": 993,
         "username": "u@example", "password": "pw"},
    ]}
    with _patch_sleep(), patch("one_mail_agg.remote_accounts.requests.get") as get:
        get.side_effect = [requests.ReadTimeout("stalled"), _resp(200, body)]
        accts = fetch_user_accounts("https://w.example", "tok")
    assert get.call_count == 2
    assert [a.id for a in accts] == ["uma-1"]


def test_fetch_user_accounts_retry_is_bounded_and_keeps_strict_mode_strict():
    with _patch_sleep(), patch("one_mail_agg.remote_accounts.requests.get") as get:
        get.side_effect = requests.ReadTimeout("stalled")
        assert fetch_user_accounts("https://w.example", "tok") == []
        assert get.call_count == 2
    with _patch_sleep(), patch("one_mail_agg.remote_accounts.requests.get") as get:
        get.side_effect = requests.ReadTimeout("stalled")
        with pytest.raises(requests.ReadTimeout):
            fetch_user_accounts("https://w.example", "tok", raise_on_error=True)
        assert get.call_count == 2
