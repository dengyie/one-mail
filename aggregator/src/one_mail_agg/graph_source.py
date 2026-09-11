"""Microsoft Graph API 邮件同步源：为授予 Mail.Read / Mail.ReadWrite 权限的个人/企业 Microsoft 账号同步邮件。

使用 stdlib/requests 经 Microsoft Graph REST API 增量同步邮件并获取原始 RFC822 MIME 内容。
水印通过 Graph 消息 ID 集合（`state.pop3_seen` 相同语义的 seen 集合）推进。
"""
import logging
from datetime import datetime
import requests
from typing import NamedTuple

from .config import AccountConfig, Config
from .state import SyncState
from .token_store import make_rotated_callback
from .normalize import normalize_message
from .uploader import upload_emails
from .imap_base import BATCH_SIZE, MAX_SINGLE_BYTES

log = logging.getLogger("one-mail-agg")

GRAPH_UID_PREFIX = "graph:"


class GraphMessageMeta(NamedTuple):
    id: str
    received_at_ms: int | None
    subject: str | None


def graph_access_token(oauth: dict, on_rotated=None) -> str:
    """获取 Graph API access_token。优先复用 refresh_token 换取 Bearer token。

    MSA/consumers 响应必然携带轮换后的新 refresh_token：经 on_rotated 回调落盘
    （token_store 统一通道），不落盘 = 旧 token 失效后账号永久失联。
    """
    payload = {
        "client_id": oauth["client_id"],
        "grant_type": "refresh_token",
        "refresh_token": oauth["refresh_token"],
    }
    if oauth.get("client_secret"):
        payload["client_secret"] = oauth["client_secret"]
    if oauth.get("scope"):
        payload["scope"] = oauth["scope"]

    tenant = oauth.get("tenant", "consumers")
    r = requests.post(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        data=payload,
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    new_rt = data.get("refresh_token")
    if new_rt and new_rt != oauth.get("refresh_token"):
        oauth["refresh_token"] = new_rt
        if on_rotated:
            on_rotated(new_rt)
    return data["access_token"]


def graph_uid_key(account: AccountConfig, folder: str, msg_id: str) -> str:
    """Graph 邮件全局唯一稳定键。"""
    return f"{GRAPH_UID_PREFIX}{account.id}:{folder}:{msg_id}"


def fetch_graph_messages(
    access_token: str,
    account: AccountConfig,
    folder: str,
    state: SyncState,
) -> tuple[list[tuple[GraphMessageMeta, bytes]], list[str]]:
    """拉取尚未 seen 的 Graph API 邮件元数据及原始 MIME 内容。"""
    headers = {"Authorization": f"Bearer {access_token}"}
    seen = state.get_pop3_seen(account.id, folder)

    # 映射常用 folder 名称到 Graph 端点
    folder_path = "Inbox" if folder.upper() == "INBOX" else folder
    # 按接收时间倒序拉取最新的邮件列表
    url = f"https://graph.microsoft.com/v1.0/me/mailFolders/{folder_path}/messages?$top=50&$orderby=receivedDateTime+desc"
    r = requests.get(url, headers=headers, timeout=30)
    r.raise_for_status()
    items = r.json().get("value", [])

    pending_items: list[dict] = []
    for item in items:
        mid = item.get("id")
        if mid and graph_uid_key(account, folder, mid) not in seen:
            pending_items.append(item)

    if not pending_items:
        return [], []

    # 首次同步保护（initial_sync_limit）
    initial_limit = getattr(account, "initial_sync_limit", 50)
    if len(seen) == 0 and initial_limit > 0 and len(pending_items) > initial_limit:
        older = pending_items[initial_limit:]
        older_ids = [graph_uid_key(account, folder, m["id"]) for m in older]
        state.add_pop3_seen_many(account.id, folder, older_ids)
        pending_items = pending_items[:initial_limit]
        log.info(
            "graph account=%s initial sync limit applied: syncing latest %d msgs, marking %d older seen",
            account.id,
            len(pending_items),
            len(older),
        )

    # 按时间正序处理入库
    pending_items.reverse()

    fetched: list[tuple[GraphMessageMeta, bytes]] = []
    oversize_ids: list[str] = []

    for item in pending_items:
        mid = item["id"]
        # 获取 raw MIME 内容（$value）
        mime_url = f"https://graph.microsoft.com/v1.0/me/messages/{mid}/$value"
        res = requests.get(mime_url, headers=headers, timeout=30)
        if res.status_code != 200:
            log.warning("graph fetch mime failed account=%s msg_id=%s status=%s", account.id, mid, res.status_code)
            continue

        raw_bytes = res.content
        if len(raw_bytes) > MAX_SINGLE_BYTES:
            log.warning(
                "graph skip oversize message account=%s msg_id=%s bytes=%d > limit=%d",
                account.id,
                mid,
                len(raw_bytes),
                MAX_SINGLE_BYTES,
            )
            oversize_ids.append(graph_uid_key(account, folder, mid))
            continue

        received_at_ms = None
        received_at = item.get("receivedDateTime")
        if received_at:
            try:
                received_at_ms = int(datetime.fromisoformat(received_at.replace("Z", "+00:00")).timestamp() * 1000)
            except (TypeError, ValueError):
                log.warning("graph invalid receivedDateTime account=%s msg_id=%s value=%r", account.id, mid, received_at)

        meta = GraphMessageMeta(
            id=mid,
            received_at_ms=received_at_ms,
            subject=item.get("subject"),
        )
        fetched.append((meta, raw_bytes))

    return fetched, oversize_ids


def sync_graph(account: AccountConfig, config: Config, state: SyncState,
               config_path: str | None = None) -> dict:
    """Graph API 邮件同步执行入口。

    RT 轮换经 token_store 统一持久化：静态账号写 config.json（兼容旧 config_path
    参数），用户自助账号回写 Worker（config_path 不参与）。
    """
    if not account.oauth:
        raise ValueError(f"graph account {account.id} requires oauth configuration")

    access_token = graph_access_token(
        account.oauth,
        make_rotated_callback(config if config.config_path or account.user_managed else None, account),
    )
    folders = account.folders or ["INBOX"]
    total_synced = 0
    total_dropped = 0

    for folder in folders:
        fetched, oversize = fetch_graph_messages(access_token, account, folder, state)
        if oversize:
            state.add_pop3_seen_many(account.id, folder, oversize)
            total_dropped += len(oversize)

        if not fetched:
            continue

        batch = []
        uploaded_ids = []
        for meta, raw_bytes in fetched:
            try:
                norm = normalize_message(
                    raw_bytes,
                    account,
                    folder,
                    uidvalidity=0,
                    uid=0,
                    internal_date_ms=meta.received_at_ms,
                    imap_uid_override=graph_uid_key(account, folder, meta.id),
                )
                batch.append(norm)
                uploaded_ids.append(graph_uid_key(account, folder, meta.id))
            except Exception as e:
                total_dropped += 1
                log.warning("skip graph message id=%s account=%s: %r", meta.id, account.id, e)

        if batch:
            result = upload_emails(config, batch)
            inserted = result.get("inserted", len(batch))
            total_synced += inserted
            state.add_pop3_seen_many(account.id, folder, uploaded_ids)

    return {"synced": total_synced, "dropped": total_dropped, "protocol": "graph"}
