import responses
import one_mail_agg.oauth as oauth_mod
from one_mail_agg.config import AccountConfig
from one_mail_agg.oauth import gmail_access_token, outlook_access_token


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
