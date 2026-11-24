"""agent.qq.com (Agently / QQ Agent Mail) REST sync source.

agent.qq.com is an Agent-native mailbox: pure REST + OAuth device flow
refresh_token, no IMAP/POP3/SMTP endpoints. The wire contract (base URL,
endpoints, {ok,data,error} envelope) was reverse-engineered from
agently-cli v1.0.18 (2026-11-24) and mirrors graph_source.py's sync
invariants: seen-anchor pagination, commit-seen-after-upload boundary,
and redemption_lock-protected token redemption.

Wire contract summary:
- base https://api.agent.qq.com, Bearer access_token (1h TTL)
- GET  /v1/aliases/{alias_id}/messages            list (dir/cursor/limit)
- GET  /v1/aliases/{alias_id}/messages/{id}      full body (body/body_format)
- POST /v1/aliases/{alias_id}/messages/send      send (to/cc/bcc/body/body_format)
- token: POST https://auth.agent.qq.com/oauth/token  {grant_type: refresh_token, ...}
- envelope: {"ok": bool, "data": ..., "error": {type, code, message, request_id}}
"""
import base64
import logging
import time
from datetime import datetime
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from typing import NamedTuple

import requests

from .config import AccountConfig, Config
from .state import SyncState
from .token_store import make_rotated_callback, redemption_lock, refresh_rt_from_config
from .normalize import normalize_message
from .uploader import upload_emails
from .imap_base import BATCH_SIZE, MAX_SINGLE_BYTES

log = logging.getLogger("one-mail-agg")

AGENTLY_UID_PREFIX = "agently:"
AGENTLY_API_BASE = "https://api.agent.qq.com"
AGENTLY_TOKEN_URL = "https://auth.agent.qq.com/oauth/token"
_AGENTLY_PAGE_LIMIT = 50          # API hard cap per +list page
_MAX_AGENTLY_MESSAGE_SCAN = 5000  # same stranding guard as graph_source
_DEFAULT_ALIAS = "__primary__"    # placeholder resolved once per sync via /v1/me
# 国内 API：daemon 进程环境带的 HTTPS_PROXY（7897）会把 agent.qq.com 响应改写成
# 非 JSON/envelope 异常体（"no data object" 事故根因），requests 默认 trust_env
# 会吃掉它。IMAP 侧的 should_use_proxy/SOCKS5 决策管不到 requests 的 env 代理，
# 必须在每次 HTTP 调用显式置空。
_AGENTLY_DIRECT_PROXIES = {"http": None, "https": None}

_BODY_FORMAT_PLAIN = "PLAIN"
_BODY_FORMAT_HTML = "HTML"
_BODY_FORMAT_MARKDOWN = "MARKDOWN"


class AgentlyError(RuntimeError):
    """Retryable transport/API failure (mapped to sync failure/backoff upstream)."""


class AgentlyAuthError(RuntimeError):
    """Authorization is permanently invalid (401 after refresh); needs re-auth."""


class AgentlyMessageMeta(NamedTuple):
    id: str
    received_at_ms: int | None
    subject: str | None
    rfc_message_id: str | None
    dir_name: str


def agently_access_token(oauth: dict, on_rotated=None) -> str:
    """Exchange the device-flow refresh_token for an access token.

    Mirrors graph_access_token: rotated RTs are written back through on_rotated
    immediately (token_store persistence failure aborts the redemption).
    Transport-layer jitter on the token POST is retried once via
    call_with_transport_retry — a lost response must NOT be classified as a
    dead refresh_token (that would demand manual re-auth for nothing).
    """
    from .transport_retry import call_with_transport_retry

    payload = {
        "grant_type": "refresh_token",
        "refresh_token": oauth["refresh_token"],
    }
    if oauth.get("client_id"):
        payload["client_id"] = oauth["client_id"]

    def _post() -> requests.Response:
        return requests.post(AGENTLY_TOKEN_URL, data=payload, timeout=30,
                             proxies=_AGENTLY_DIRECT_PROXIES)

    r = call_with_transport_retry(_post)
    if r.status_code in (400, 401, 403):
        raise AgentlyAuthError(
            "agently refresh_token rejected (HTTP "
            f"{r.status_code}); RT 已过期或被其他客户端轮换作废——重新执行 "
            "`agently-cli auth login` 并将新 refresh_token 更新到该账号配置后即可恢复（无需其他操作）")
    r.raise_for_status()
    data = r.json()
    new_rt = data.get("refresh_token")
    if new_rt and new_rt != oauth.get("refresh_token"):
        oauth["refresh_token"] = new_rt
        if on_rotated:
            on_rotated(new_rt)
    access = data.get("access_token")
    if not access:
        raise AgentlyError("agently token response has no access_token")
    return access


def agently_access_token_locked(account: AccountConfig, config: Config | None) -> str:
    """锁内兑换 Agently access token（redemption_lock 见 token_store 模块注释）。

    access_token 有效期 1h，refresh_token 是否轮换由服务端决定；无论轮换与否，
    都必须与 IMAP/mutation 并发通路共享同一把进程级兑换锁。
    """
    with redemption_lock():
        refresh_rt_from_config(config, account)
        return agently_access_token(
            account.oauth,
            make_rotated_callback(
                config if (config is not None and (config.config_path or account.user_managed)) else None,
                account,
            ),
        )


def _envelope(response: requests.Response) -> dict:
    """Parse the {ok,data,error} envelope; raise classified errors."""
    if response.status_code == 401:
        raise AgentlyAuthError(
            "agently API returned 401; RT 已过期或被其他客户端轮换作废——重新执行 "
            "`agently-cli auth login` 并将新 refresh_token 更新到该账号配置后即可恢复（无需其他操作）")
    if response.status_code == 429:
        retry_after = response.headers.get("Retry-After")
        raise AgentlyError(
            f"agently API rate limited (Retry-After={retry_after or '?'})")
    try:
        payload = response.json()
    except ValueError as e:
        raise AgentlyError(
            f"agently API returned non-JSON HTTP {response.status_code}") from e
    if not isinstance(payload, dict):
        raise AgentlyError("agently API envelope is not an object")
    if response.status_code >= 400 or payload.get("ok") is False:
        err = payload.get("error") or {}
        code = err.get("code") or response.status_code
        message = err.get("message") or response.text[:200]
        raise AgentlyError(f"agently API error code={code}: {message}")
    data = payload.get("data")
    if isinstance(data, dict):
        return data
    # Defensive: a {"data": [...]} list payload has not been observed live
    # (messages listing returns data as a dict with data+pagination), but a
    # bare array would still fit the sync caller's data.get("data") contract.
    if isinstance(data, list):
        return {"data": data}
    # Send (and possibly other mutation) responses are bare objects like
    # {"queued": true, "_hints": {...}} — no {ok,data} envelope. Verified live
    # 2026-11-24: POST .../messages/send returns 200 with this shape.
    if "data" not in payload and "ok" not in payload:
        return payload
    raise AgentlyError("agently API envelope has no data object")


def _api_get(access_token: str, path: str, params: dict | None = None) -> dict:
    r = requests.get(
        f"{AGENTLY_API_BASE}{path}",
        headers={"Authorization": f"Bearer {access_token}"},
        params=params,
        timeout=30,
        proxies=_AGENTLY_DIRECT_PROXIES,
    )
    return _envelope(r)


def _resolve_alias_id(access_token: str, account: AccountConfig) -> str:
    """Resolve the primary alias once per sync.

    +me data.aliases[].alias_id; prefer the is_primary row, fall back to the
    first alias. The account username should match one of the aliases; it is
    display/authorization metadata, not the wire identifier.
    """
    data = _api_get(access_token, "/v1/me")
    aliases = data.get("aliases")
    if not isinstance(aliases, list) or not aliases:
        raise AgentlyError(f"agently account {account.id} has no aliases")
    primary = next((row for row in aliases if row.get("is_primary")), None)
    chosen = primary or aliases[0]
    alias_id = str(chosen.get("alias_id") or "").strip()
    if not alias_id:
        raise AgentlyError(f"agently account {account.id} alias has no alias_id")
    return alias_id


def agently_uid_key(account: AccountConfig, folder: str, msg_id: str) -> str:
    return f"{AGENTLY_UID_PREFIX}{account.id}:{folder}:{msg_id}"


def agently_source_key(account: AccountConfig, msg_id: str) -> str:
    # message_id is provider-stable and folder-independent (dir moves keep the
    # id), so like graph the dedup key must NOT embed the folder.
    return f"{AGENTLY_UID_PREFIX}{account.id}:{msg_id}"


_DIR_FOLDER_MAP = {"inbox": "INBOX", "sent": "Sent", "trash": "Trash", "spam": "Spam"}
_FOLDER_DIR_MAP = {v: k for k, v in _DIR_FOLDER_MAP.items()}


def _folder_to_dir(folder: str) -> str:
    return _FOLDER_DIR_MAP.get(folder.strip().title(), "inbox")


def _dir_to_folder(dir_name: str) -> str:
    return _DIR_FOLDER_MAP.get(str(dir_name or "").strip().lower(), "INBOX")


def _parse_iso_ms(value) -> int | None:
    if not value:
        return None
    try:
        return int(datetime.fromisoformat(
            str(value).replace("Z", "+00:00")).timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def _collect_pending_message_ids(
    access_token: str,
    account: AccountConfig,
    folder: str,
    state: SyncState,
    alias_id: str,
) -> list[dict]:
    """Collect the contiguous unseen prefix, newest -> oldest (graph invariant).

    Pagination stops at the first seen message_id (the historical anchor).
    first_sync trims to initial_sync_limit and pre-seeds older ids as seen.
    """
    seen = state.get_pop3_seen(account.id, folder)
    first_sync = not seen
    pending: list[dict] = []
    cursor: str | None = None
    scanned = 0
    hit_seen_anchor = False
    visited_cursors: set[str] = set()

    while True:
        if cursor is not None:
            if cursor in visited_cursors:
                raise AgentlyError("agently pagination loop detected (repeated cursor)")
            visited_cursors.add(cursor)
        params: dict = {"dir": _folder_to_dir(folder), "limit": _AGENTLY_PAGE_LIMIT}
        if cursor:
            params["cursor"] = cursor
        data = _api_get(access_token, f"/v1/aliases/{alias_id}/messages", params=params)
        rows = data.get("data")
        if not isinstance(rows, list):
            raise AgentlyError("agently message listing returned invalid data.data payload")

        for row in rows:
            if not isinstance(row, dict):
                continue
            mid = str(row.get("message_id") or "").strip()
            if not mid:
                continue
            scanned += 1
            if agently_uid_key(account, folder, mid) in seen:
                hit_seen_anchor = True
                break
            row["_mid"] = mid
            pending.append(row)

        if hit_seen_anchor or first_sync:
            break

        pagination = data.get("pagination") or {}
        next_cursor = pagination.get("next_cursor")
        if not next_cursor or not pagination.get("has_more"):
            break
        if scanned >= _MAX_AGENTLY_MESSAGE_SCAN:
            raise RuntimeError(
                f"agently backlog exceeded scan cap {_MAX_AGENTLY_MESSAGE_SCAN} before seen anchor")
        cursor = str(next_cursor)

    if first_sync:
        initial_limit = getattr(account, "initial_sync_limit", 50)
        if initial_limit > 0 and len(pending) > initial_limit:
            older = pending[initial_limit:]
            state.add_pop3_seen_many(
                account.id, folder,
                [agently_uid_key(account, folder, row["_mid"]) for row in older],
            )
            pending = pending[:initial_limit]
            log.info(
                "agently account=%s initial sync limit applied: syncing latest %d msgs, marking %d older seen",
                account.id, len(pending), len(older),
            )
    elif len(pending) > BATCH_SIZE:
        pending = pending[-BATCH_SIZE:]

    pending.reverse()  # oldest -> newest for ingest
    return pending


def _build_mime_from_api(account: AccountConfig, folder: str, detail: dict, msg_id: str) -> bytes:
    """Assemble a synthetic RFC 5322 message from the structured API payload.

    normalize_message/uploader consume MIME; building a conformant message
    reuses the entire downstream pipeline (bodies, attachments, headers_json)
    instead of forking the normalize schema for one provider.
    """
    msg = EmailMessage()
    sender = detail.get("from") or {}
    msg["From"] = formataddr((str(sender.get("name") or ""), str(sender.get("email") or "")))
    to_rows = detail.get("to") or []
    if to_rows:
        msg["To"] = ", ".join(
            formataddr((str(row.get("name") or ""), str(row.get("email") or "")))
            for row in to_rows if isinstance(row, dict) and row.get("email")
        ) or account.username
    else:
        msg["To"] = account.username
    subject = detail.get("subject")
    if subject:
        msg["Subject"] = str(subject)
    rfc_id = detail.get("rfc_message_id")
    if rfc_id:
        msg["Message-ID"] = str(rfc_id)
    received_ms = _parse_iso_ms(detail.get("created_at"))
    if received_ms:
        msg["Date"] = formatdate(received_ms / 1000, localtime=False)
    else:
        msg["Date"] = formatdate(localtime=False)
    if msg.get("Message-ID") is None:
        # Message-ID must exist even when the provider omits rfc_message_id;
        # downstream threading/dedup consumers expect a RFC 5322 identity.
        msg["Message-ID"] = make_msgid(domain="agent.qq.com")

    body_format = str(detail.get("body_format") or "").upper()
    body = str(detail.get("body") or "")
    if body_format == _BODY_FORMAT_HTML:
        msg.set_content(body, subtype="html")
    elif body_format == _BODY_FORMAT_MARKDOWN:
        # Store the raw markdown as plain text; validation-code extraction and
        # search operate on text, and no consumer renders markdown today.
        msg.set_content(body, subtype="plain")
    else:
        msg.set_content(body, subtype="plain")

    attachments = detail.get("attachments")
    if isinstance(attachments, list):
        for index, row in enumerate(attachments):
            if not isinstance(row, dict):
                continue
            content = row.get("content")
            if not isinstance(content, str) or not content:
                continue  # download_url-only oversized rows are skipped (out of sync scope)
            try:
                payload = base64.b64decode(content, validate=False)
            except (ValueError, TypeError):
                log.warning("agently attachment decode failed account=%s msg=%s att=%s",
                            account.id, msg_id, row.get("attachment_id") or index)
                continue
            maintype, _, subtype = str(row.get("content_type") or "application/octet-stream").partition("/")
            try:
                msg.add_attachment(
                    payload, maintype=maintype or "application", subtype=subtype or "octet-stream",
                    filename=str(row.get("filename") or f"attachment-{index}"))
            except Exception as e:
                log.warning("agently attachment add failed account=%s msg=%s: %r",
                            account.id, msg_id, e)

    return msg.as_bytes()


def fetch_agently_messages(
    access_token: str,
    account: AccountConfig,
    folder: str,
    state: SyncState,
    alias_id: str,
) -> tuple[list[tuple[AgentlyMessageMeta, bytes]], list[str]]:
    """Fetch one safe batch: stop at the first detail-fetch hole (retryable)."""
    pending_rows = _collect_pending_message_ids(access_token, account, folder, state, alias_id)
    if not pending_rows:
        return [], []

    fetched: list[tuple[AgentlyMessageMeta, bytes]] = []
    oversize_ids: list[str] = []
    for row in pending_rows:
        mid = row["_mid"]
        try:
            detail = _api_get(access_token, f"/v1/aliases/{alias_id}/messages/{mid}")
        except AgentlyError as e:
            # Same retryable-hole rule as graph MIME GET: stop so seen can never
            # advance past a failed message.
            log.warning("agently fetch detail failed account=%s msg_id=%s: %s; stopping batch",
                        account.id, mid, e)
            break

        raw_bytes = _build_mime_from_api(account, folder, detail, mid)
        if len(raw_bytes) > MAX_SINGLE_BYTES:
            log.warning(
                "agently skip oversize message account=%s msg_id=%s bytes=%d > limit=%d",
                account.id, mid, len(raw_bytes), MAX_SINGLE_BYTES)
            oversize_ids.append(agently_uid_key(account, folder, mid))
            continue

        dir_name = str((detail.get("dir") or {}).get("dir_name") or _folder_to_dir(folder))
        fetched.append((AgentlyMessageMeta(
            id=mid,
            received_at_ms=_parse_iso_ms(detail.get("created_at")),
            subject=detail.get("subject"),
            rfc_message_id=detail.get("rfc_message_id"),
            dir_name=dir_name,
        ), raw_bytes))

    return fetched, oversize_ids


def sync_agently(account: AccountConfig, config: Config, state: SyncState,
                 config_path: str | None = None) -> dict:
    if not account.oauth or not account.oauth.get("refresh_token"):
        raise ValueError(f"agently account {account.id} requires oauth.refresh_token (device flow)")

    access_token = agently_access_token_locked(account, config)
    alias_id = _resolve_alias_id(access_token, account)
    folders = account.folders or ["INBOX"]

    total_synced = 0
    total_dropped = 0
    for folder in folders:
        fetched, oversize = fetch_agently_messages(access_token, account, folder, state, alias_id)

        # fetched + oversize form one contiguous processed prefix (detail-fetch
        # stops at the first hole). Commit seen only after the upload boundary
        # succeeded, exactly like sync_graph.
        total_dropped += len(oversize)
        processed_ids = list(oversize)
        if not fetched:
            if processed_ids:
                state.add_pop3_seen_many(account.id, folder, processed_ids)
            continue

        batch = []
        for meta, raw_bytes in fetched:
            legacy_key = agently_uid_key(account, folder, meta.id)
            try:
                norm = normalize_message(
                    raw_bytes, account, folder,
                    uidvalidity=0, uid=0,
                    internal_date_ms=meta.received_at_ms,
                    imap_uid_override=legacy_key,
                    provider="agently",
                    provider_message_id=meta.id,
                    source_folder_id=meta.dir_name,
                    source_key_override=agently_source_key(account, meta.id),
                )
                batch.append(norm)
                processed_ids.append(legacy_key)
            except Exception as e:
                # Deterministic parse failure = permanent drop; keep the seen
                # boundary contiguous so nothing strands behind it.
                total_dropped += 1
                processed_ids.append(legacy_key)
                log.warning("skip agently message id=%s account=%s: %r", meta.id, account.id, e)

        if batch:
            result = upload_emails(config, batch)
            total_synced += result.get("inserted", len(batch))
        if processed_ids:
            state.add_pop3_seen_many(account.id, folder, processed_ids)

    return {"synced": total_synced, "dropped": total_dropped, "protocol": "agently"}


# --- Outbound (REST send) ---------------------------------------------------


def _send_headers(access_token: str) -> dict:
    return {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }


def send_agently(account: AccountConfig, payload: dict, config) -> str | None:
    """Send via POST /v1/aliases/{alias_id}/messages/send.

    Error classification mirrors send_graph: 401/403 → OutboundUnsupported,
    408/429/5xx & lost requests → OutboundOutcomeUnknown, other 4xx →
    OutboundSendError. Returns the provider message id when the API echoes one.
    """
    from .smtp_sender import (
        OutboundIdentityError,
        OutboundOutcomeUnknown,
        OutboundSendError,
        OutboundUnsupported,
    )

    if not account.oauth or not account.oauth.get("refresh_token"):
        raise OutboundIdentityError(f"agently account {account.id} has no OAuth config")
    if not payload.get("to_addr"):
        raise OutboundIdentityError(f"agently account {account.id} send has no recipient")

    with redemption_lock():
        refresh_rt_from_config(config, account)
        access_token = agently_access_token(
            account.oauth,
            make_rotated_callback(
                config if (config is not None and (config.config_path or account.user_managed)) else None,
                account,
            ),
        )

    is_html = bool(payload.get("is_html") or payload.get("body_html"))
    content = payload.get("body_html") if is_html else (payload.get("body_text") or "")
    body: dict = {
        "to": [{"email": str(payload.get("to_addr") or "")}],
        "subject": str(payload.get("subject") or ""),
        "body": content or "",
        "body_format": _BODY_FORMAT_HTML if is_html else _BODY_FORMAT_PLAIN,
        "skip_confirmation": True,
    }
    cc = payload.get("cc_addr") or payload.get("cc")
    if isinstance(cc, list) and cc:
        body["cc"] = [{"email": str(addr)} for addr in cc]

    try:
        alias_id = _resolve_alias_id(access_token, account)
        data = _envelope(requests.post(
            f"{AGENTLY_API_BASE}/v1/aliases/{alias_id}/messages/send",
            headers=_send_headers(access_token),
            json=body,
            timeout=30,
            proxies=_AGENTLY_DIRECT_PROXIES,
        ))
    except AgentlyAuthError as error:
        raise OutboundUnsupported(f"agently send unauthorized: {error}") from error
    except AgentlyError as error:
        raise OutboundSendError(f"agently send rejected for {account.id}: {error}") from error
    except requests.HTTPError as error:
        status = error.response.status_code if error.response is not None else 0
        if status in (401, 403):
            raise OutboundUnsupported(f"agently send forbidden (HTTP {status})") from error
        if status == 408 or status == 429 or status >= 500:
            raise OutboundOutcomeUnknown(
                f"agently send transient error HTTP {status}") from error
        raise OutboundSendError(f"agently send rejected HTTP {status}") from error
    except (requests.Timeout, requests.ConnectionError) as error:
        raise OutboundOutcomeUnknown(
            f"agently send request lost for {account.id}: {error}") from error
    except requests.RequestException as error:
        raise OutboundOutcomeUnknown(
            f"agently send outcome is unknown for {account.id}: {error}") from error

    return str(data.get("message_id")) if data.get("message_id") else None


def reconcile_agently_sent(
    account: AccountConfig,
    payload: dict,
    config,
    window_seconds: int = 300,
) -> str | None:
    """Reconcile an ambiguous send by querying the provider Sent dir.

    Matches the most recent sent messages on subject within the window, mirroring
    reconcile_graph_sent. Returns exactly-one match id, else None.
    """
    from .smtp_sender import ReconcileError

    subject = str(payload.get("subject") or "").strip().lower()
    with redemption_lock():
        refresh_rt_from_config(config, account)
        access_token = agently_access_token(
            account.oauth,
            make_rotated_callback(
                config if (config is not None and (config.config_path or account.user_managed)) else None,
                account,
            ),
        )
    try:
        alias_id = _resolve_alias_id(access_token, account)
        data = _api_get(access_token, f"/v1/aliases/{alias_id}/messages",
                        {"dir": "sent", "limit": 10})
        rows = data.get("data") or []
    except (AgentlyError, requests.RequestException) as error:
        raise ReconcileError(
            f"agently sent reconciliation failed for {account.id}: {error}") from error

    now = time.time()
    matches: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if subject and str(row.get("subject") or "").strip().lower() != subject:
            continue
        sent_ms = _parse_iso_ms(row.get("created_at"))
        if sent_ms is not None and abs(now - sent_ms / 1000) > window_seconds:
            continue
        mid = str(row.get("message_id") or "").strip()
        if mid:
            matches.append(mid)
        if len(matches) >= 2:
            break  # ambiguous — stop early
    if len(matches) == 1:
        return matches[0]
    return None


def send_agently_with_reconcile(account: AccountConfig, payload: dict, config) -> str | None:
    """Send an Agently outbound mail and reconcile an ambiguous outcome."""
    from .smtp_sender import OutboundOutcomeUnknown

    try:
        return send_agently(account, payload, config)
    except OutboundOutcomeUnknown as original:
        try:
            reconciled = reconcile_agently_sent(account, payload, config)
        except Exception:
            raise original from None
        if reconciled is not None:
            log.info("agently send reconciled: account=%s message=%s", account.id, reconciled)
            return reconciled
        raise original from None
