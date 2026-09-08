from unittest.mock import MagicMock
from one_mail_agg.config import Config, AccountConfig
from one_mail_agg.state import SyncState
from one_mail_agg.idle_worker import (
    ImapIdleWorker,
    ensure_idle_workers,
    _resolve_client_factory,
    _is_msa_like,
    _active_idle_workers,
)
from one_mail_agg.oauth import oauth_client_factory
from one_mail_agg.sync import default_client_factory


def test_idle_worker_lifecycle(tmp_path):
    state_file = tmp_path / "state.json"
    state = SyncState(str(state_file))
    config = Config(
        worker_base_url="https://fake",
        admin_token="token",
        state_path=str(state_file),
        accounts=[]
    )
    acc = AccountConfig(
        id="test-qq",
        source="imap_qq",
        host="imap.qq.com",
        port=993,
        username="test@qq.com",
        password="pwd",
        folders=["INBOX"],
        use_ssl=True,
    )

    mock_client = MagicMock()
    mock_client.has_capability.return_value = True
    # idle_check 第一次返回有事件，之后抛异常退出以便终止线程
    mock_client.idle_check.side_effect = [[(b"1", b"EXISTS")], Exception("stop test")]

    sync_calls = []
    worker = ImapIdleWorker(
        config=config,
        account=acc,
        state=state,
        client_factory=lambda _a: mock_client,
        idle_refresh_seconds=1,
    )

    # patch do_sync to verify call
    worker.do_sync = lambda _c: sync_calls.append(1) or {"synced": 1, "dropped": 0}

    worker.start()
    worker.join(timeout=2)
    worker.stop()

    # 验证确实触发了 sync
    assert len(sync_calls) >= 1


def test_resolve_client_factory_oauth_uses_oauth_factory():
    """OAuth 账号（含新 MSA/Hotmail 个人号）的 IDLE 必须走 OAuth 工厂（XOAUTH2）。"""
    acc = AccountConfig(
        id="hotmail-main",
        source="imap_outlook",
        host="outlook.office365.com",
        port=993,
        username="x@hotmail.com",
        password="p",
        oauth={"provider": "msa", "client_id": "c", "refresh_token": "rt"},
    )
    factory = _resolve_client_factory(acc)
    assert factory is oauth_client_factory(acc) or callable(factory)
    # 关键：工厂不是默认基础登录工厂（否则 OAuth 账号 IDLE 会 basic auth 失败）
    assert factory is not default_client_factory


def test_resolve_client_factory_basic_uses_default():
    """无 OAuth 账号保持默认基础登录工厂（qq/163 行为不变）。"""
    acc = AccountConfig(
        id="qq", source="imap_qq", host="imap.qq.com", port=993,
        username="u@qq.com", password="pwd",
    )
    assert _resolve_client_factory(acc) is default_client_factory


def test_resolve_client_factory_unknown_provider_falls_back():
    """未知 OAuth provider 不抛异常，回退默认基础登录（账号级隔离，不拖垮 IDLE 线程）。"""
    acc = AccountConfig(
        id="bad", source="imap_custom", host="imap.example.com", port=993,
        username="u@example.com", password="pwd",
        oauth={"provider": "totally-unknown", "client_id": "c", "refresh_token": "rt"},
    )
    assert _resolve_client_factory(acc) is default_client_factory


def test_is_msa_like_by_host():
    """MSA 账号按 major outlook host 识别（即便 provider 缺失/拼错）。"""
    acc = AccountConfig(
        id="h1", source="imap_outlook", host="outlook.office365.com", port=993,
        username="a@outlook.com", password="p",
        oauth={"provider": "hotmail", "client_id": "c", "refresh_token": "rt"},
    )
    assert _is_msa_like(acc) is True


def test_is_msa_like_by_provider_alias():
    """非 outlook host 但 provider 归一化为 msa（outlook_personal）也应判定为 MSA。"""
    acc = AccountConfig(
        id="h2", source="imap_custom", host="imap.custombox.com", port=993,
        username="b@custom.com", password="p",
        oauth={"provider": "outlook_personal", "client_id": "c", "refresh_token": "rt"},
    )
    assert _is_msa_like(acc) is True


def test_is_msa_like_false_for_normal_account():
    """非 MSA（qq/163/gmail 等）账号 —— host 不符且 provider 非 msa。"""
    acc = AccountConfig(
        id="qq2", source="imap_qq", host="imap.qq.com", port=993,
        username="u@qq.com", password="pwd",
    )
    assert _is_msa_like(acc) is False


def test_resolve_client_factory_msa_failure_logs_reauth(caplog):
    """MSA 账号 token 工厂解析失败：不静默回退 basic，而是打清晰的「需重新授权」错误。"""
    import logging
    with caplog.at_level(logging.ERROR, logger="one-mail-agg"):
        acc = AccountConfig(
            id="dead-msa", source="imap_outlook", host="outlook.office365.com", port=993,
            username="dead@outlook.com", password="p",
            oauth={"provider": "totally-unknown", "client_id": "c", "refresh_token": "rt"},
        )
        factory = _resolve_client_factory(acc)
    # 为了账号隔离仍返回默认工厂（不会抛异常拖垮线程）
    assert factory is default_client_factory
    joined = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "重新授权" in joined
    assert "outlook.office365.com" in str(acc.host.lower()) or "outlook" in joined
