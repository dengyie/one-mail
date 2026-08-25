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
    """半截/损坏 JSON 不抛错、退回默认状态——旧版非原子写会被 kill 的残留
    能存活。原子写保证当前状态不会生成截断文件；此用例钉死加载侧对历史坏文件的
    容错（旧代码 json.load 抛错，所有账号同步状态清零重建）。
    """
    p = tmp_path / "st.json"
    p.write_text('{"last_uid": {"acc|INBOX": ')

    s = SyncState(str(p))
    assert s.get_last_uid("acc", "INBOX") == 0
    assert s.get_pop3_seen("acc", "INBOX") == set()
    assert s.get_uidvalidity("acc", "INBOX") is None
    assert not s.is_fallback_pinned("acc")


# ---------------- 修复 #2：连续失败退避（per-account） ----------------

def test_fail_state_missing_for_new_account(tmp_path):
    s = SyncState(str(tmp_path / "st.json"))
    assert s.get_fail_state("acc") == (0, 0)
    assert not s.should_skip_account("acc")


def test_fail_three_times_enters_backoff(tmp_path):
    """连续 3 败 → skip_until 推进到 now+退避；第 4 轮 should_skip 为 True。"""
    s = SyncState(str(tmp_path / "st.json"))
    t0 = 10_000.0
    s.record_failure("acc", now=t0)            # 1
    assert not s.should_skip_account("acc", now=t0)
    s.record_failure("acc", now=t0 + 1)        # 2
    assert not s.should_skip_account("acc", now=t0 + 1)
    until = s.record_failure("acc", now=t0 + 2)  # 3 → 退避
    assert until == t0 + 2 + 900
    assert s.should_skip_account("acc", now=t0 + 2)
    assert s.should_skip_account("acc", now=t0 + 2 + 899)
    assert not s.should_skip_account("acc", now=t0 + 2 + 901)   # 退避窗口已过


def test_fail_after_backoff_rewind_climbs_again(tmp_path):
    """退避窗口过后再次失败：fail_count 不清零，重新累计直至再次退避。"""
    s = SyncState(str(tmp_path / "st.json"))
    for i in range(3):
        s.record_failure("acc", now=float(i))
    assert s.should_skip_account("acc", now=900)   # 相对 3 号失败 +900 前仍在窗口内
    # 等到窗口外，再失败 3 次 → 重新进入退避（fail_count 从 3 继续 4,5,6）
    s.record_failure("acc", now=1000.0)
    s.record_failure("acc", now=1001.0)
    s.record_failure("acc", now=1002.0)
    assert s.should_skip_account("acc", now=1002.0)


def test_success_clears_fail_and_backoff(tmp_path):
    s = SyncState(str(tmp_path / "st.json"))
    s.record_failure("acc", now=1000.0)
    s.record_failure("acc", now=1001.0)
    s.record_failure("acc", now=1002.0)        # 进入退避
    assert s.should_skip_account("acc", now=1002.0)
    s.record_success("acc")
    assert s.get_fail_state("acc") == (0, 0)
    assert not s.should_skip_account("acc", now=1002.0)


def test_success_noop_does_not_rewrite(tmp_path):
    """从未失败的账号 record_success 是不写作（返回 None，无副作用）。"""
    s = SyncState(str(tmp_path / "st.json"))
    s.record_success("acc")                 # 无 per_account 条目
    assert "per_account" not in s._data or s._data["per_account"] == {}


def test_fail_state_roundtrip_persists(tmp_path):
    """per_account 状态往返：record_failure 后重载 state 文件仍读到 skip_until。"""
    from one_mail_agg.state import FAILBACK_BACKOFF_SEC
    p = tmp_path / "st.json"
    s = SyncState(str(p))
    s.record_failure("acc", now=2000.0)
    s.record_failure("acc", now=2001.0)
    s.record_failure("acc", now=2002.0)
    s2 = SyncState(str(p))
    fail, skip_until = s2.get_fail_state("acc")
    assert fail == 3
    assert skip_until == 2002.0 + FAILBACK_BACKOFF_SEC


def test_old_state_file_without_per_account_loads(tmp_path):
    """老 state 文件无 per_account 键：加载不报错，字段视为 (0,0)。"""
    import json
    p = tmp_path / "st.json"
    p.write_text(json.dumps({"last_uid": {}, "uidvalidity": {}, "pop3_seen": {},
                             "fallback": {}}))
    s = SyncState(str(p))
    assert s.get_fail_state("any") == (0, 0)
    assert not s.should_skip_account("any")


# ---------------- 修复 #5：pop3_seen FIFO 上限 ----------------

def test_pop3_seen_fifo_cap_trims_oldest(tmp_path):
    from one_mail_agg.state import POP3_SEEN_MAX
    s = SyncState(str(tmp_path / "st.json"))
    for i in range(POP3_SEEN_MAX + 500):        # 2500 条
        s.add_pop3_seen("acc", "INBOX", f"UIDL-{i:05d}")
    seen = s.get_pop3_seen("acc", "INBOX")
    assert len(seen) <= POP3_SEEN_MAX
    # 保留最近的 2000 条：最旧的 UIDL-00000 被裁掉，最新的 UIDL-02499 还在
    assert "UIDL-00000" not in seen
    assert "UIDL-02499" in seen


def test_pop3_seen_many_fifo_cap(tmp_path):
    from one_mail_agg.state import POP3_SEEN_MAX
    s = SyncState(str(tmp_path / "st.json"))
    s.add_pop3_seen_many("acc", "INBOX", [f"U-{i:05d}" for i in range(POP3_SEEN_MAX + 500)])
    seen = s.get_pop3_seen("acc", "INBOX")
    assert len(seen) <= POP3_SEEN_MAX
    assert "U-00000" not in seen
    assert f"U-{POP3_SEEN_MAX + 499:05d}" in seen