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
    """Microsoft 365 / organizational accounts (work & school).

    Uses the /common tenant with a confidential client (client_secret required).
    Kept for backward compatibility with existing deployments that registered a
    Microsoft Entra app with a secret.
    """
    r = requests.post("https://login.microsoftonline.com/common/oauth2/v2.0/token", data={
        "client_id": oauth["client_id"], "client_secret": oauth["client_secret"],
        "refresh_token": oauth["refresh_token"], "grant_type": "refresh_token",
        "scope": "https://outlook.office.com/IMAP.AccessAsUser.All offline_access",
    }, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def msa_access_token(oauth: dict) -> str:
    """Personal Microsoft accounts (Hotmail / Outlook.com / Live).

    Consumer MSA uses the /consumers tenant with a public client. A
    client_secret is NOT required (and usually not present). If one happens to
    be configured it is forwarded as-is — harmless and compatible.
    """
    payload = {
        "client_id": oauth["client_id"],
        "refresh_token": oauth["refresh_token"],
        "grant_type": "refresh_token",
        "scope": "https://outlook.office.com/IMAP.AccessAsUser.All offline_access",
    }
    if oauth.get("client_secret"):
        payload["client_secret"] = oauth["client_secret"]
    r = requests.post(
        "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        data=payload, timeout=30,
    )
    r.raise_for_status()
    return r.json()["access_token"]


_TOKEN_FN = {
    "gmail": gmail_access_token,
    "outlook": outlook_access_token,
    "msa": msa_access_token,
    # 兼容别名：配置里写 hotmail / outlook_personal 归一化为 msa
    "hotmail": msa_access_token,
    "outlook_personal": msa_access_token,
}


def normalize_provider(provider: str | None) -> str | None:
    """把 alias 归一化为 canonical provider 名；未知 provider 原样返回。

    canonical: gmail / outlook / msa
    aliases:   hotmail -> msa, outlook_personal -> msa
    """
    if provider is None:
        return None
    p = provider.strip().lower()
    if p in {"hotmail", "outlook_personal"}:
        return "msa"
    return p


def oauth_client_factory(account: AccountConfig):
    provider = normalize_provider((account.oauth or {}).get("provider"))
    token_fn = _TOKEN_FN[provider]

    def factory(acc: AccountConfig) -> IMAPClient:
        access = token_fn(acc.oauth or {})
        # 30s socket 超时与 POP3 / 默认 client 工厂一致（I3）：单账号挂死不拖垮整轮。
        c = IMAPClient(acc.host, port=acc.port, ssl=acc.use_ssl, timeout=30)
        c.oauth2_login(acc.username, access)
        return c
    return factory
