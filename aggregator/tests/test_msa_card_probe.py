"""卡导入探测脚本测试：核心契约 = 有且仅有一次兑换 + 轮换 RT 落盘 + 幂等拒重。"""
import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "msa_card_probe",
    Path(__file__).resolve().parent.parent / "scripts" / "msa_card_probe.py")
msp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(msp)


def test_parse_card_rejects_wrong_segment_count():
    with pytest.raises(msp.CardError):
        msp.parse_card("a----b----c")
    card = msp.parse_card("u@hotmail.com----pw----cid----rt")
    assert card == {"email": "u@hotmail.com", "password": "pw",
                    "client_id": "cid", "refresh_token": "rt"}


def test_classify_scopes():
    assert msp.classify("https://outlook.office.com/IMAP.AccessAsUser.All offline_access") == "imap_outlook"
    assert msp.classify("https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read") == "graph_outlook"
    assert msp.classify("openid profile") == "unsupported"


def test_build_account_graph_and_imap():
    card = {"email": "user1@hotmail.com", "password": "pw",
            "client_id": "cid", "refresh_token": "rt"}
    graph = msp.build_account(card, "graph_outlook")
    assert graph["source"] == "graph_outlook"
    assert graph["host"] == "graph.microsoft.com"
    assert graph["oauth"]["provider"] == "graph"
    imap = msp.build_account(card, "imap_outlook")
    assert imap["source"] == "imap_outlook"
    assert imap["host"] == "outlook.office365.com"
    assert imap["oauth"]["provider"] == "msa"


def test_refuses_second_redemption(tmp_path, monkeypatch):
    monkeypatch.setattr(msp, "STATE_DIR", tmp_path)
    email = "u@hotmail.com"
    msp.save_state(email, {"path": "graph_outlook", "scope": "Mail.Read",
                           "refresh_token": "NEW", "client_id": "cid", "password": "pw"})

    def boom(*a, **k):  # 任何再次兑换的尝试都让测试爆炸
        raise AssertionError("must not re-redeem a probed card")

    monkeypatch.setattr(msp, "probe_once", boom)
    rc = msp.main(["probe", f"{email}----pw----cid----OLD"])
    assert rc == 1


def test_main_probe_success_persists_rotated_token(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(msp, "STATE_DIR", tmp_path)
    monkeypatch.setattr(msp, "probe_once", lambda cid, rt: {
        "_http_status": 200, "access_token": "AT",
        "scope": "https://graph.microsoft.com/Mail.Read",
        "refresh_token": "ROTATED", "client_info": "x"})
    rc = msp.main(["probe", "u@hotmail.com----pw----cid----ORIGINAL"])
    out = capsys.readouterr().out
    assert rc == 0 and "PATH=graph_outlook" in out
    # 输出块必须携带轮换后的新 RT，而不是卡面原始 RT
    assert '"refresh_token": "ROTATED"' in out
    cached = json.loads((tmp_path / "u@hotmail.com.json").read_text(encoding="utf-8"))
    assert cached["refresh_token"] == "ROTATED"


def test_main_probe_failure_no_retry_guidance(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(msp, "STATE_DIR", tmp_path)
    monkeypatch.setattr(msp, "probe_once", lambda cid, rt: {
        "_http_status": 400, "error": "invalid_grant", "error_description": "AADSTS70000 ..."})
    rc = msp.main(["probe", "u@hotmail.com----pw----cid----rt"])
    out = capsys.readouterr().out
    assert rc == 1 and "Do NOT retry" in out
