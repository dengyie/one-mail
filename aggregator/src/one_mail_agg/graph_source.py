"""Microsoft Graph API 邮件同步源：为授予 Mail.Read / Mail.ReadWrite 权限的个人/企业 Microsoft 账号同步邮件。

使用 stdlib/requests 经 Microsoft Graph REST API 增量同步邮件并获取原始 RFC822 MIME 内容。
水印通过 Graph 消息 ID 集合（`state.pop3_seen` 相同语义的 seen 集合）推进。
"""
import logging
import os
from datetime import datetime
import json
import requests
from typing import NamedTuple

from .config import AccountConfig, Config
from .state import SyncState
from .normalize import normalize_message
from .uploader import upload_emails
from .imap_base import BATCH_SIZE, MAX_SINGLE_BYTES

log = logging.getLogger("one-mail-agg")

GRAPH_UID_PREFIX = "graph:"


class GraphMessageMeta(NamedTuple):
    id: str
    received_at_ms: int | None
    subject: str | None


def _persist_refresh_token(config_path: str, account_id: str, new_refresh_token: str) -> None:
    """把轮换后的 refresh_token 原子写回 config.json。

    微软个人号（MSA/consumers）的 refresh_token 每次兑换都会轮换：响应里返回新的
    refresh_token，旧 token 随即失效。不落盘 = 下轮兑换 400 invalid_grant，账号
    永久失联（2026-09-11 烧卡事故教训）。写回失败只告警不抛错：
    本轮同步照常进行，但账号已处于倒计时，需要人工介入。
    """
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        for acc in raw.get("accounts", []):
            if acc.get("id") == account_id and isinstance(acc.get("oauth"), dict):
                acc["oauth"]["refresh_token"] = new_refresh_token
                break
        else:
            log.warning("graph persist refresh_token: account %s not found in %s", account_id, config_path)
            return
        tmp_path = f"{config_path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(raw, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_path, config_path)
        log.info("graph rotated refresh_token persisted for account %s", account_id)
    except Exception as e:
        log.error("graph persist refresh_token failed for account %s: %r", account_id, e)


def graph_access_token(oauth: dict, config_path: str | None = None,
                       account_id: str | None = None) -> str:
    """获取 Graph API access_token。优先复用 refresh_token 换取 Bearer token。

    MSA/consumers 响应必然携带轮换后的新 refresh_token：传入 config_path +
    account_id 时自动写回 config.json，避免旧 token 失效后账号失联。
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
        if config_path and account_id:
            _persist_refresh_token(config_path, account_id, new_rt)
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
    """Graph API 邮件同步执行入口。config_path 用于轮换 refresh_token 的落盘。"""
    if not account.oauth:
        raise ValueError(f"graph account {account.id} requires oauth configuration")

    access_token = graph_access_token(account.oauth, config_path, account.id)
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
