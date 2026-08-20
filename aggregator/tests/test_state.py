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