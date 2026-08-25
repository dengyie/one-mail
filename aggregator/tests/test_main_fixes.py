"""修复 #2 退避守卫 + 修复 #3 畸形 OAuth 的 run_once 层面回归。

对照既有 test_sync.py 的 `test_run_once_unknown_oauth_provider_only_affects_that_account`
（未知 provider → 单账号错误、循环继续）；本组锁定此前会让整个循环炸掉的畸形值：
- oauth={}（dict 缺 provider）
- oauth="gmail"（字符串，非 dict）
- oauth=None（无 OAuth，回落 default_client_factory 正常走）

修复前 `oauth_client_factory` 里 `(account.oauth or {}).get("provider")` 对
oauth 字符串抛 AttributeError 逃逸 per-account try，整轮冻结（修复 #3）。
"""
import pytest

import one_mail_agg.main as main_mod
from one_mail_agg.config import AccountConfig, Config


def _make(oauth, protocol="auto"):
    return AccountConfig(id="user-bad", source="imap_custom",
                         host="imap.corp.example", port=993,
                         username="u@corp.example", password="pw",
                         folders=["INBOX"], protocol=protocol, oauth=oauth)


@pytest.mark.parametrize("oauth_value", [
    {},                  # oauth={} dict 缺 provider
    "gmail",             # oauth 是字符串（畸形）
    {"provider": None},  # provider 键存在但为 None
    {"provider": "some_unknown_provider"},   # 未知 provider（沿用既有语义）
])
def test_run_once_malformed_oauth_only_affects_that_account(tmp_path, monkeypatch, oauth_value):
    """畸形 oauth（含字符串）→ 单账号 `provider unsupported` 错误，不 abort 整轮。"""
    badge = _make(oauth_value)
    good = {"id": "user-good", "source": "imap_qq", "host": "imap.qq.com", "port": 993,
            "username": "u@qq.com", "password": "pw", "folders": ["INBOX"],
            "protocol": "auto", "oauth": None}

    def fake_load_config(path):
        return Config(worker_base_url="https://one-mail.x.workers.dev", admin_token="secret",
                      accounts=[AccountConfig(**good)],
                      state_path=str(tmp_path / "st.json"))
    monkeypatch.setattr(main_mod, "load_config", fake_load_config)
    monkeypatch.setattr(main_mod, "fetch_user_accounts",
                        lambda *a: [AccountConfig(id=badge.id, source=badge.source,
                                                  host=badge.host, port=badge.port,
                                                  username=badge.username,
                                                  password=badge.password,
                                                  folders=list(badge.folders),
                                                  protocol=badge.protocol,
                                                  oauth=badge.oauth)])
    synced = []
    monkeypatch.setattr(main_mod, "sync_account",
                        lambda factory, config, account, state: synced.append(account.id)
                        or {"synced": 0, "dropped": 0, "protocol": "imap"})
    status = []
    monkeypatch.setattr(main_mod, "report_sync_status",
                        lambda base, token, aid, err: status.append((aid, err)))

    res = main_mod.run_once("whatever.json")

    # 畸形 provider 账号：单账号错误，不抛、不冻结循环
    assert res["user-bad"]["error"].startswith("provider unsupported:")
    # oauth 字符串 → 明确标注 not-dict；dict 形态取 provider
    if isinstance(oauth_value, str):
        assert "malformed:not-dict" in res["user-bad"]["error"]
    else:
        p = oauth_value.get("provider") or "<missing>"
        assert res["user-bad"]["error"].endswith(p)
    # 后续账号照常同步
    assert synced == ["user-good"]
    # 只回写坏账号的 last_error
    assert len(status) == 1 and status[0][0] == "user-bad"
    assert status[0][1] == res["user-bad"]["error"]


def test_run_once_oauth_none_uses_default_factory(tmp_path, monkeypatch):
    """oauth=None 是非 OAuth 账号：走 default_client_factory，不应报 provider 错误。"""
    good = {"id": "user-plain", "source": "imap_qq", "host": "imap.qq.com", "port": 993,
            "username": "u@qq.com", "password": "pw", "folders": ["INBOX"],
            "protocol": "auto", "oauth": None}

    def fake_load_config(path):
        return Config(worker_base_url="https://one-mail.x.workers.dev", admin_token="secret",
                      accounts=[AccountConfig(**good)], state_path=str(tmp_path / "st.json"))
    monkeypatch.setattr(main_mod, "load_config", fake_load_config)
    monkeypatch.setattr(main_mod, "fetch_user_accounts", lambda *a: [])
    fac = []
    monkeypatch.setattr(main_mod, "sync_account",
                        lambda factory, config, account, state: fac.append(factory)
                        or {"synced": 0, "dropped": 0, "protocol": "imap"})
    monkeypatch.setattr(main_mod, "report_sync_status", lambda *a, **k: None)

    res = main_mod.run_once("whatever.json")
    assert res["user-plain"] == {"synced": 0, "dropped": 0, "protocol": "imap"}
    # default_client_factory 被使用（非 oauth_client_factory 产物）
    assert fac == [main_mod.default_client_factory]


def test_run_once_backoff_skips_account_in_retry_after_3_failures(tmp_path, monkeypatch):
    """修复 #2：账号连续失败 3 轮后进入退避；下轮直接跳过，不再尝试 sync、不误报成功。

    模拟 sync_account 持续抛错的坏账号 + 一个正常账号：
    第一轮坏账号失败 3 次（fail_count 到 3）并计入退避。
    """
    state_path = str(tmp_path / "st.json")
    bad = {"id": "bad-acc", "source": "imap_qq", "host": "imap.qq.com", "port": 993,
           "username": "u@qq.com", "password": "pw", "folders": ["INBOX"],
           "protocol": "auto", "oauth": None}
    good = {"id": "good-acc", "source": "imap_qq", "host": "imap.qq.com", "port": 993,
            "username": "g@qq.com", "password": "pw", "folders": ["INBOX"],
            "protocol": "auto", "oauth": None}

    def fake_load_config(path):
        return Config(worker_base_url="https://one-mail.x.workers.dev", admin_token="secret",
                      accounts=[AccountConfig(**bad), AccountConfig(**good)],
                      state_path=state_path)
    monkeypatch.setattr(main_mod, "load_config", fake_load_config)
    monkeypatch.setattr(main_mod, "fetch_user_accounts", lambda *a: [])

    def flaky_sync(factory, config, account, state):
        if account.id == "bad-acc":
            raise RuntimeError("imap login failed")
        return {"synced": 0, "dropped": 0, "protocol": "imap"}

    monkeypatch.setattr(main_mod, "sync_account", flaky_sync)
    monkeypatch.setattr(main_mod, "report_sync_status", lambda *a, **k: None)

    # 前 3 轮：坏账号每次都失败并累计
    all_res = []
    for _ in range(5):
        all_res.append(main_mod.run_once("whatever.json"))
    # 第 4 轮起：fail_count>=3 → 退避窗口内直接跳过，sync_account 不再为它抛出（count=3 豁免）
    res4 = all_res[3]
    assert res4["bad-acc"]["error"].startswith("skipped (consecutive_failures=3")
    res5 = all_res[4]
    assert res5["bad-acc"]["error"].startswith("skipped (consecutive_failures=")
    assert "good-acc" in res4 and "good-acc" in res5   # 健康账号照常