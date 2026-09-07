"""msa_authorize.py 引导脚本的 Device Code Flow 逻辑测试。

不改真实网络：mock PublicClientApplication / device flow 序列，
验证「发起 device flow → 轮询 → 产出 config.json JSON 块」的完整链路。
"""
import json
import importlib.util
import os
import sys
from unittest.mock import MagicMock, patch

import pytest


_AGG_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "msa_authorize",
        os.path.join(_AGG_ROOT, "scripts", "msa_authorize.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def mod():
    return _load_module()


def test_build_app_consumers(mod):
    app = MagicMock()
    with patch.object(mod, "msal") as msal_mod:
        msal_mod.PublicClientApplication.return_value = app
        out = mod.build_app("cid", "consumers")
    assert out is app
    # authority 指向 consumers 租户
    _, kw = msal_mod.PublicClientApplication.call_args
    assert kw["authority"] == "https://login.microsoftonline.com/consumers"


def test_device_flow_returns_refresh_token_config(mod, capsys):
    """mock 授权成功：脚本打印含 refresh_token 的 JSON 配置块。"""
    fake_flow = {
        "user_code": "ABCDEFG",
        "verification_uri": "https://microsoft.com/devicelogin",
        "expires_in": 900,
        "interval": 5,
    }
    # 第一次 acquire 返回 pending，第二次返回 access+refresh token
    app = MagicMock()
    app.initiate_device_flow.return_value = dict(fake_flow)
    app.acquire_token_by_device_flow.side_effect = [
        {"error": "authorization_pending"},
        {"access_token": "acc-tok", "refresh_token": "REFRESH-123"},
    ]

    with patch.object(mod, "webbrowser"):
        result = mod.run_device_flow(app, scopes=["IMAP"])

    assert result["refresh_token"] == "REFRESH-123"
    assert result["access_token"] == "acc-tok"
    assert app.acquire_token_by_device_flow.call_count == 2


def test_device_flow_failure_on_declined(mod):
    fake_flow = {
        "user_code": "X",
        "verification_uri": "https://x",
        "expires_in": 900,
        "interval": 5,
    }
    app = MagicMock()
    app.initiate_device_flow.return_value = dict(fake_flow)
    app.acquire_token_by_device_flow.return_value = {
        "error": "authorization_declined", "error_description": "user refused",
    }
    with pytest.raises(RuntimeError):
        mod.run_device_flow(app, scopes=["IMAP"])