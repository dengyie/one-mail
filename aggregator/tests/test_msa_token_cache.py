"""MSA access_token 复用：未到期不重复兑换，RT 变化或临近过期才重新兑换。"""
import pytest
import responses

import one_mail_agg.oauth as oauth_mod

MSA_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"


@pytest.fixture(autouse=True)
def _clear_msa_cache():
    oauth_mod._msa_access_cache.clear()
    yield
    oauth_mod._msa_access_cache.clear()


def _oauth(client_id="cid-a", refresh_token="RT-1"):
    return {"client_id": client_id, "refresh_token": refresh_token}


def _stub_token(*, access="AT-1", refresh_token="RT-2", expires_in=3600, status=200):
    body = {"access_token": access, "expires_in": expires_in}
    if refresh_token is not None:
        body["refresh_token"] = refresh_token
    responses.add(responses.POST, MSA_TOKEN_URL, json=body, status=status)


@responses.activate
def test_msa_reuses_access_token_until_refresh_window():
    _stub_token()
    oauth = _oauth()
    rotated = []

    first = oauth_mod.cached_msa_access_token(oauth, rotated.append, now=1_000.0)
    second = oauth_mod.cached_msa_access_token(oauth, rotated.append, now=1_000.0 + 3_000.0)

    assert first == second == "AT-1"
    assert len(responses.calls) == 1
    assert rotated == ["RT-2"]
    assert oauth["refresh_token"] == "RT-2"


@responses.activate
def test_msa_cache_misses_when_refresh_token_changes():
    _stub_token(access="AT-1", refresh_token="RT-2")
    _stub_token(access="AT-9", refresh_token="RT-3")
    oauth = _oauth()
    oauth_mod.cached_msa_access_token(oauth, now=0.0)

    oauth["refresh_token"] = "RT-OTHER"
    tok = oauth_mod.cached_msa_access_token(oauth, now=10.0)

    assert tok == "AT-9"
    assert len(responses.calls) == 2
    assert oauth["refresh_token"] == "RT-3"


@responses.activate
def test_msa_cache_does_not_cross_client_ids():
    _stub_token(access="AT-a", refresh_token="RT-a2")
    _stub_token(access="AT-b", refresh_token="RT-b2")
    first = _oauth(client_id="app-a", refresh_token="RT-shared")
    second = _oauth(client_id="app-b", refresh_token="RT-shared")

    assert oauth_mod.cached_msa_access_token(first, now=0.0) == "AT-a"
    assert oauth_mod.cached_msa_access_token(second, now=0.0) == "AT-b"
    assert len(responses.calls) == 2


@responses.activate
def test_msa_refreshes_five_minutes_before_expiry():
    _stub_token(access="AT-1", refresh_token="RT-2", expires_in=3600)
    _stub_token(access="AT-2", refresh_token="RT-3", expires_in=3600)
    oauth = _oauth()

    assert oauth_mod.cached_msa_access_token(oauth, now=0.0) == "AT-1"
    # expires_in 3600，提前 300 秒刷新：第 3300 秒整点已经不算命中。
    assert oauth_mod.cached_msa_access_token(oauth, now=3_299.0) == "AT-1"
    assert oauth_mod.cached_msa_access_token(oauth, now=3_300.0) == "AT-2"
    assert len(responses.calls) == 2


@responses.activate
def test_msa_missing_expires_in_uses_one_hour_default():
    responses.add(responses.POST, MSA_TOKEN_URL,
                  json={"access_token": "AT-1", "refresh_token": "RT-2"}, status=200)
    responses.add(responses.POST, MSA_TOKEN_URL,
                  json={"access_token": "AT-2", "refresh_token": "RT-3"}, status=200)
    oauth = _oauth()

    assert oauth_mod.cached_msa_access_token(oauth, now=0.0) == "AT-1"
    assert oauth_mod.cached_msa_access_token(oauth, now=3_299.0) == "AT-1"
    assert oauth_mod.cached_msa_access_token(oauth, now=3_300.0) == "AT-2"


@responses.activate
def test_msa_cache_hit_does_not_call_on_rotated():
    _stub_token()
    oauth = _oauth()
    rotated = []
    oauth_mod.cached_msa_access_token(oauth, rotated.append, now=0.0)
    rotated.clear()

    oauth_mod.cached_msa_access_token(oauth, rotated.append, now=10.0)

    assert rotated == []
    assert len(responses.calls) == 1


@responses.activate
def test_msa_http_error_is_not_cached():
    responses.add(responses.POST, MSA_TOKEN_URL, json={"error": "invalid_grant"}, status=400)
    _stub_token(access="AT-ok", refresh_token="RT-ok")
    oauth = _oauth(client_id="cid-err", refresh_token="RT-err")

    with pytest.raises(Exception, match="400"):
        oauth_mod.cached_msa_access_token(oauth, now=0.0)
    assert oauth_mod.cached_msa_access_token(oauth, now=1.0) == "AT-ok"
    assert len(responses.calls) == 2
