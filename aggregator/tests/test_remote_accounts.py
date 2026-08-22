from unittest.mock import patch, MagicMock

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


def test_non_200_returns_empty():
    with patch("one_mail_agg.remote_accounts.requests.get", return_value=_resp(500, {})):
        assert fetch_user_accounts("https://w.example", "tok") == []


def test_network_error_returns_empty():
    with patch("one_mail_agg.remote_accounts.requests.get", side_effect=Exception("boom")):
        assert fetch_user_accounts("https://w.example", "tok") == []


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
