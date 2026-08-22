from one_mail_agg.state import SyncState


def key(account="163-main", folder="INBOX"):
    return f"{account}|{folder}"


def test_pop3_seen_empty(tmp_path):
    s = SyncState(str(tmp_path / "st.json"))
    assert s.get_pop3_seen("acc", "INBOX") == set()


def test_pop3_seen_set_and_roundtrip(tmp_path):
    s = SyncState(str(tmp_path / "st.json"))
    s.add_pop3_seen("acc", "INBOX", "UIDL-100")
    s.add_pop3_seen("acc", "INBOX", "UIDL-200")
    s.add_pop3_seen("acc", "OTHER", "UIDL-other")
    s2 = SyncState(str(tmp_path / "st.json"))
    assert s2.get_pop3_seen("acc", "INBOX") == {"UIDL-100", "UIDL-200"}
    assert s2.get_pop3_seen("acc", "OTHER") == {"UIDL-other"}
    assert s2.get_pop3_seen("acc", "NOPE") == set()


def test_pop3_seen_does_not_collide_with_imap_last_uid(tmp_path):
    """POP3 关心的是 UIDL 集合；IMAP 的 last_uid/uidvalidity 是同一文件，互不干扰。"""
    s = SyncState(str(tmp_path / "st.json"))
    s.set_last_uid("qq", "INBOX", 50)
    s.add_pop3_seen("qq", "INBOX", "UIDL-1")
    s2 = SyncState(str(tmp_path / "st.json"))
    assert s2.get_last_uid("qq", "INBOX") == 50
    assert s2.get_pop3_seen("qq", "INBOX") == {"UIDL-1"}


def test_pop3_seen_handles_old_state_file_missing_key(tmp_path):
    """旧 / 手工 state 文件没有 pop3_seen 键，也要能加载。"""
    import json
    p = tmp_path / "st.json"
    p.write_text(json.dumps({"last_uid": {"qq|INBOX": 42}, "uidvalidity": {}}))
    s = SyncState(str(p))
    assert s.get_last_uid("qq", "INBOX") == 42
    assert s.get_pop3_seen("qq", "INBOX") == set()


def test_save_leaves_no_tmp_file(tmp_path):
    """原子写：save() 后目录里不能再留 *.tmp 临时文件（I4）。"""
    p = tmp_path / "st.json"
    s = SyncState(str(p))
    s.set_last_uid("acc", "INBOX", 5)     # set_* 内部就走 save()
    s.save()
    assert list(tmp_path.glob("*.tmp")) == []


def test_mutation_save_cycles_roundtrip(tmp_path):
    """多轮 变更→save→重载 往返一致：各自独立的 SyncState 实例落在同一文件。"""
    p = tmp_path / "st.json"
    s = SyncState(str(p))
    s.set_last_uid("acc", "INBOX", 1)
    assert SyncState(str(p)).get_last_uid("acc", "INBOX") == 1
    s2 = SyncState(str(p))
    s2.set_last_uid("acc", "INBOX", 2)
    assert SyncState(str(p)).get_last_uid("acc", "INBOX") == 2
    s3 = SyncState(str(p))
    s3.add_pop3_seen("acc", "INBOX", "UIDL-9")
    assert SyncState(str(p)).get_pop3_seen("acc", "INBOX") == {"UIDL-9"}


def test_truncated_state_file_loads_with_defaults(tmp_path):
    """半截/损坏 JSON 不抛错、退回默认状态——旧版非原子写被 kill 的残留能存活。

    原子写保证了未来不会再产生截断文件；此用例钉死加载侧对历史坏文件的容错
    （旧代码在这里 json.load 直接抛错，整个同步状态清零重建）。
    """
    p = tmp_path / "st.json"
    p.write_text('{"last_uid": {"acc|INBOX": ')

    s = SyncState(str(p))
    assert s.get_last_uid("acc", "INBOX") == 0
    assert s.get_pop3_seen("acc", "INBOX") == set()
    assert s.get_uidvalidity("acc", "INBOX") is None
    assert not s.is_fallback_pinned("acc")