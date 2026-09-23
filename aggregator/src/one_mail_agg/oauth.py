import requests
from imapclient import IMAPClient

from .config import AccountConfig
from .proxy_client import create_imap_client
from .token_store import make_rotated_callback, redemption_lock, refresh_rt_from_config


def _handle_rotated(oauth: dict, data: dict, on_rotated) -> None:
    """接住 token 响应里轮换出的新 refresh_token。

    MSA/consumers 兑换必然轮换 RT：丢掉 = 下轮兑换 400、账号永久失联
    （2026-09-11 烧卡事故根因）。内存立即替换 + on_rotated 回调落盘。
    持久化失败由回调抛出，让当前 OAuth 建连失败而不是假装成功。
    """
    new_rt = data.get("refresh_token")
    if new_rt and new_rt != oauth.get("refresh_token"):
        oauth["refresh_token"] = new_rt
        if on_rotated:
            on_rotated(new_rt)


def gmail_access_token(oauth: dict, on_rotated=None) -> str:
    r = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": oauth["client_id"], "client_secret": oauth["client_secret"],
        "refresh_token": oauth["refresh_token"], "grant_type": "refresh_token",
    }, timeout=30)
    r.raise_for_status()
    data = r.json()
    _handle_rotated(oauth, data, on_rotated)
    return data["access_token"]


def outlook_access_token(oauth: dict, on_rotated=None) -> str:
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
    data = r.json()
    _handle_rotated(oauth, data, on_rotated)
    return data["access_token"]


def msa_access_token(oauth: dict, on_rotated=None) -> str:
    """Personal Microsoft accounts (Hotmail / Outlook.com / Live).

    Consumer MSA uses the /consumers tenant with a public client. A
    client_secret is NOT required (and usually not present). If one happens to
    be configured it is forwarded as-is — harmless and compatible.

    ⚠️ 响应必然携带轮换后的新 refresh_token：on_rotated 落盘是账号存活的前提。
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
    data = r.json()
    _handle_rotated(oauth, data, on_rotated)
    return data["access_token"]


_TOKEN_FN = {
    "gmail": gmail_access_token,
    "outlook": outlook_access_token,
    "msa": msa_access_token,
    # 注意：这里只注册 canonical provider。别名 hotmail / outlook_personal
    # 由 normalize_provider（在 oauth_client_factory 里先调用）归一化为 msa，
    # 不在此重复注册，避免两份映射漂移（单一事实来源）。
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


def oauth_client_factory(account: AccountConfig, config=None):
    """构造 OAuth IMAP client factory。

    config 传入后，token 轮换自动持久化（静态写 config.json，用户账号回写 Worker）。
    transport 与基础认证 IMAP 共用 create_imap_client，确保 direct / SOCKS 策略一致。

    整个「回读最新 RT → 兑换 → XOAUTH2 建连」在进程级 redemption_lock 内完成：
    IDLE / 轮询 / mutation 三条路径同进程，并发兑换同一 RT 会让其中一份立刻失效。
    """
    provider = normalize_provider((account.oauth or {}).get("provider"))
    token_fn = _TOKEN_FN[provider]
    on_rotated = make_rotated_callback(config, account)

    def factory(acc: AccountConfig) -> IMAPClient:
        with redemption_lock():
            refresh_rt_from_config(config, acc)
            access = token_fn(acc.oauth or {}, on_rotated)
            c = create_imap_client(acc, timeout=30)
            c.oauth2_login(acc.username, access)
            return c
    return factory
