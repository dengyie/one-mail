from unittest.mock import MagicMock
from one_mail_agg.config import Config, AccountConfig
from one_mail_agg.state import SyncState
from one_mail_agg.idle_worker import ImapIdleWorker, ensure_idle_workers, _active_idle_workers


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
