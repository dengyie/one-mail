import responses
import one_mail_agg.oauth as oauth_mod
from one_mail_agg.config import AccountConfig
from one_mail_agg.oauth import (
    gmail_access_token,
    outlook_access_token,
    msa_access_token,
    normalize_provider,
    _TOKEN_FN,
)


# ---------------------------------------------------------------------------
# 既有 gmail / outlook（组织）用例——不得回归
# ---------------------------------------------------------------------------

@responses.activate
def test_gmail_access_token():
    responses.add(responses.POST, "https://oauth2.googleapis.com/token",
                  json={"access_token": "g-tok", "expires_in": 3600}, status=200)
    tok = gmail_access_token({"client_id": "cid", "client_secret": "cs", "refresh_token": "rt"})
    assert tok == "g-tok"


@responses.activate
def test_outlook_access_token():
    responses.add(responses.POST,
                  "https://login.microsoftonline.com/common/oauth2/v2.0/token",
                  json={"access_token": "o-tok"}, status=200)
    tok = outlook_access_token({"client_id": "cid", "client_secret": "cs", "refresh_token": "rt"})
    assert tok == "o-tok"


@responses.activate
def test_oauth_factory_uses_30s_timeout(monkeypatch):
    """I3：OAuth IMAP 客户端工厂同样带 30s socket 超时。"""
    calls = []
    class _FakeClient:
        def __init__(self, *a, **kw):
            calls.append((a, kw))
        def oauth2_login(self, u, token):
            pass

    responses.add(responses.POST, "https://oauth2.googleapis.com/token",
                  json={"access_token": "g-tok", "expires_in": 3600}, status=200)
    monkeypatch.setattr(oauth_mod, "IMAPClient", _FakeClient)

    acc = AccountConfig(id="g", source="imap_gmail", host="imap.gmail.com", port=993,
                        username="u@gmail.com", password="rt",
                        oauth={"provider": "gmail", "client_id": "cid",
                               "client_secret": "cs", "refresh_token": "rt"})
    factory = oauth_mod.oauth_client_factory(acc)
    client = factory(acc)
    assert isinstance(client, _FakeClient)
    assert calls == [(("imap.gmail.com",), {"port": 993, "ssl": True, "timeout": 30})]


# ---------------------------------------------------------------------------
# MSA（Hotmail / Outlook.com 个人号）——新增
# ---------------------------------------------------------------------------

MSA_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"


@responses.activate
def test_msa_access_token_public_client_no_secret():
    """MSA 个人号走 /consumers，公开客户端无需 client_secret。"""
    responses.add(responses.POST, MSA_TOKEN_URL,
                  json={"access_token": "msa-tok", "expires_in": 3600}, status=200)
    tok = msa_access_token({
        "client_id": "pub-cid",
        "refresh_token": "M.C...refresh",
    })
    assert tok == "msa-tok"

    # 断言请求体不含 client_secret、且 scope 正确
    req = responses.calls[-1].request
    body = req.body if isinstance(req.body, str) else req.body.decode("utf-8")
    assert "refresh_token=M.C...refresh" in body
    assert "client_id=pub-cid" in body
    assert "client_secret" not in body
    assert "IMAP.AccessAsUser.All" in body
    assert "offline_access" in body
    assert "/consumers/" in req.url


@responses.activate
def test_msa_access_token_with_optional_secret():
    """若 MSA 配置里偶然带了 client_secret，也应透传而非报错。"""
    responses.add(responses.POST, MSA_TOKEN_URL,
                  json={"access_token": "tok2"}, status=200)
    tok = msa_access_token({
        "client_id": "pub-cid",
        "client_secret": "secret-value",
        "refresh_token": "rt",
    })
    assert tok == "tok2"
    body = responses.calls[-1].request.body
    body = body if isinstance(body, str) else body.decode("utf-8")
    assert "client_secret=secret-value" in body


@responses.activate
def test_msa_access_token_rejects_http_error():
    responses.add(responses.POST, MSA_TOKEN_URL,
                  json={"error": "invalid_grant"}, status=400)
    try:
        msa_access_token({"client_id": "c", "refresh_token": "rt"})
        assert False, "应当抛异常"
    except Exception as e:
        assert "400" in str(e)


# ---------------------------------------------------------------------------
# provider 归一化（aliases）与工厂注册
# ---------------------------------------------------------------------------

def test_normalize_provider():
    assert normalize_provider("msa") == "msa"
    assert normalize_provider("hotmail") == "msa"
    assert normalize_provider("outlook_personal") == "msa"
    assert normalize_provider("HOTMAIL") == "msa"
    assert normalize_provider(" outlook_personal ") == "msa"
    assert normalize_provider("outlook") == "outlook"
    assert normalize_provider("gmail") == "gmail"
    assert normalize_provider("totally_unknown") == "totally_unknown"
    assert normalize_provider(None) is None


def test_token_fn_registration():
    """所有 canonical provider + aliases 都注册了 token 函数。"""
    assert _TOKEN_FN["msa"] is msa_access_token
    assert _TOKEN_FN["hotmail"] is msa_access_token
    assert _TOKEN_FN["outlook_personal"] is msa_access_token
    assert _TOKEN_FN["outlook"] is outlook_access_token
    assert _TOKEN_FN["gmail"] is gmail_access_token


@responses.activate
def test_msa_factory_routes_through_consumers_and_xoauth2(monkeypatch):
    """msa provider 的 factory 应走 /consumers 取 token 后做 OAuth2 login。"""
    calls = []
    class _FakeClient:
        def __init__(self, *a, **kw):
            calls.append((a, kw))
        def oauth2_login(self, u, token):
            calls.append(("oauth2_login", u, token))

    responses.add(responses.POST, MSA_TOKEN_URL,
                  json={"access_token": "msa-acc"}, status=200)
    monkeypatch.setattr(oauth_mod, "IMAPClient", _FakeClient)

    acc = AccountConfig(id="h", source="imap_outlook", host="outlook.office365.com",
                        port=993, username="someone@hotmail.com", password="placeholder",
                        oauth={"provider": "msa", "client_id": "pub",
                               "refresh_token": "rt"})
    factory = oauth_mod.oauth_client_factory(acc)
    client = factory(acc)
    assert isinstance(client, _FakeClient)
    # 第一次构造 + 一次 oauth2_login
    assert calls[0] == (("outlook.office365.com",), {"port": 993, "ssl": True, "timeout": 30})
    assert calls[1] == ("oauth2_login", "someone@hotmail.com", "msa-acc")
    assert responses.calls[0].request.url.startswith("https://login.microsoftonline.com/consumers/")


@responses.activate
def test_alias_hotmail_uses_msa(monkeypatch):
    """配置写 provider=hotmail（别名）应归一化为 msa 并正常认证。"""
    called = {}
    def _fake_msa(oauth):
        called["provider"] = oauth.get("provider")
        return "alias-tok"
    monkeypatch.setitem(oauth_mod._TOKEN_FN, "msa", _fake_msa)
    monkeypatch.setitem(oauth_mod._TOKEN_FN, "hotmail", _fake_msa)

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass
        def oauth2_login(self, u, token):
            called["tok"] = token

    monkeypatch.setattr(oauth_mod, "IMAPClient", _FakeClient)

    acc = AccountConfig(id="h", source="imap_outlook", host="outlook.office365.com",
                        port=993, username="x@hotmail.com", password="p",
                        oauth={"provider": "hotmail", "client_id": "c",
                               "refresh_token": "rt"})
    client = oauth_mod.oauth_client_factory(acc)(acc)
    assert isinstance(client, _FakeClient)
    assert called.get("tok") == "alias-tok"