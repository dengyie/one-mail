import responses
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
