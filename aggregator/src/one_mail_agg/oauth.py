import requests
from imapclient import IMAPClient

from .config import AccountConfig


def gmail_access_token(oauth: dict) -> str:
    r = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": oauth["client_id"], "client_secret": oauth["client_secret"],
        "refresh_token": oauth["refresh_token"], "grant_type": "refresh_token",
    }, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def outlook_access_token(oauth: dict) -> str:
    r = requests.post("https://login.microsoftonline.com/common/oauth2/v2.0/token", data={
        "client_id": oauth["client_id"], "client_secret": oauth["client_secret"],
        "refresh_token": oauth["refresh_token"], "grant_type": "refresh_token",
        "scope": "https://outlook.office.com/IMAP.AccessAsUser.All offline_access",
    }, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


_TOKEN_FN = {"gmail": gmail_access_token, "outlook": outlook_access_token}


def oauth_client_factory(account: AccountConfig):
    provider = (account.oauth or {}).get("provider")
    token_fn = _TOKEN_FN[provider]

    def factory(acc: AccountConfig) -> IMAPClient:
        access = token_fn(acc.oauth or {})
        c = IMAPClient(acc.host, port=acc.port, ssl=acc.use_ssl)
        c.oauth2_login(acc.username, access)
        return c
    return factory
