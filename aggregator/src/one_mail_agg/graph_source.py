"""Microsoft Graph mailbox sync with durable legacy seen keys and ImmutableId identity."""
import logging
from datetime import datetime
from urllib.parse import quote
from typing import NamedTuple

import requests

from .config import AccountConfig, Config
from .state import SyncState
from .token_store import make_rotated_callback
from .normalize import normalize_message
from .uploader import upload_emails
from .imap_base import BATCH_SIZE, MAX_SINGLE_BYTES
from .folder_catalog import (
    discover_graph_folders,
    maybe_sync_graph_folder_catalog,
)

log = logging.getLogger("one-mail-agg")

GRAPH_UID_PREFIX = "graph:"
GRAPH_IMMUTABLE_PREFER = 'IdType="ImmutableId"'
GRAPH_BATCH_LIMIT = 20
_MAX_GRAPH_MESSAGE_SCAN = 5000

_GRAPH_WELL_KNOWN = {
    "inbox": "inbox",
    "draft": "drafts",
    "drafts": "drafts",
    "sent": "sentitems",
    "sentitem": "sentitems",
    "sentitems": "sentitems",
    "deleted": "deleteditems",
    "deleteditem": "deleteditems",
    "deleteditems": "deleteditems",
    "trash": "deleteditems",
    "archive": "archive",
    "junk": "junkemail",
    "junkemail": "junkemail",
    "spam": "junkemail",
    "outbox": "outbox",
}


class GraphMessageMeta(NamedTuple):
    id: str
    legacy_id: str
    received_at_ms: int | None
    subject: str | None
    conversation_id: str | None
    parent_folder_id: str | None


def graph_access_token(oauth: dict, on_rotated=None) -> str:
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
    return f"{GRAPH_UID_PREFIX}{account.id}:{folder}:{msg_id}"


def graph_source_key(account: AccountConfig, immutable_id: str) -> str:
    return f"{GRAPH_UID_PREFIX}{account.id}:{immutable_id}"


def _resolve_immutable_metadata(access_token: str, items: list[dict]) -> dict[str, dict]:
    if not items:
        return {}

    auth_headers = {"Authorization": f"Bearer {access_token}"}
    resolved: dict[str, dict] = {}
    for start in range(0, len(items), GRAPH_BATCH_LIMIT):
        chunk = items[start:start + GRAPH_BATCH_LIMIT]
        request_map: dict[str, str] = {}
        batch_requests = []
        for offset, item in enumerate(chunk):
            legacy_id = item.get("id")
            if not legacy_id:
                raise RuntimeError("graph message missing default id before ImmutableId resolution")
            request_id = str(start + offset)
            request_map[request_id] = legacy_id
            encoded = quote(legacy_id, safe="")
            batch_requests.append({
                "id": request_id,
                "method": "GET",
                "url": f"/me/messages/{encoded}?$select=id,conversationId,parentFolderId",
                "headers": {"Prefer": GRAPH_IMMUTABLE_PREFER},
            })

        response = requests.post(
            "https://graph.microsoft.com/v1.0/$batch",
            headers=auth_headers,
            json={"requests": batch_requests},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        by_id = {str(row.get("id")): row for row in payload.get("responses", [])}
        for request_id, legacy_id in request_map.items():
            row = by_id.get(request_id)
            body = row.get("body", {}) if row else {}
            if not row or row.get("status") != 200 or not body.get("id"):
                status = row.get("status") if row else "missing"
                raise RuntimeError(
                    f"graph ImmutableId resolution failed for message {legacy_id!r}: status={status}")
            resolved[legacy_id] = body
    return resolved


def _well_known_folder_ref(folder: str) -> str | None:
    normalized = "".join(str(folder).strip().lower().split())
    return _GRAPH_WELL_KNOWN.get(normalized)


def _resolve_graph_folder_targets(
    access_token: str,
    account: AccountConfig,
    folders: list[str],
) -> tuple[list[tuple[str, str | None]], list[dict] | None]:
    """Resolve custom display names to provider IDs once per sync.

    Well-known folders are addressed by Graph's stable well-known names. Explicit
    ``id:<provider-folder-id>`` is also supported. Any other configured name is a
    display name and must resolve uniquely through recursive folder discovery.
    """
    targets: list[tuple[str, str | None]] = []
    custom_names: list[str] = []
    for folder in folders:
        value = str(folder).strip()
        if not value:
            raise ValueError("graph folder name cannot be empty")
        if _well_known_folder_ref(value) is not None:
            targets.append((value, None))
        elif value.lower().startswith("id:"):
            folder_id = value[3:].strip()
            if not folder_id:
                raise ValueError("graph folder id: prefix requires a folder id")
            targets.append((value, folder_id))
        else:
            targets.append((value, ""))
            custom_names.append(value)

    if not custom_names:
        return targets, None

    rows = discover_graph_folders(access_token, account)
    by_name: dict[str, list[str]] = {}
    for row in rows:
        name = str(row.get("display_name") or "").strip().lower()
        folder_id = str(row.get("provider_folder_id") or "").strip()
        if name and folder_id:
            by_name.setdefault(name, []).append(folder_id)

    resolved: list[tuple[str, str | None]] = []
    for logical, ref in targets:
        if ref != "":
            resolved.append((logical, ref))
            continue
        matches = list(dict.fromkeys(by_name.get(logical.lower(), [])))
        if not matches:
            raise ValueError(
                f"graph folder {logical!r} not found; use id:<folder-id> for an explicit target")
        if len(matches) != 1:
            raise ValueError(
                f"graph folder {logical!r} is ambiguous ({len(matches)} matches); "
                "use id:<folder-id>")
        resolved.append((logical, matches[0]))
    return resolved, rows


def _graph_message_url(folder_ref: str) -> str:
    return (
        f"https://graph.microsoft.com/v1.0/me/mailFolders/{quote(folder_ref, safe='')}/messages"
        "?$select=id,receivedDateTime,subject&$top=50&$orderby=receivedDateTime+desc"
    )


def _validated_message_next_link(value) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    if not value.startswith("https://graph.microsoft.com/"):
        raise RuntimeError("graph message pagination returned an unexpected host")
    return value


def _collect_pending_graph_items(
    access_token: str,
    account: AccountConfig,
    folder: str,
    state: SyncState,
    folder_ref: str,
) -> list[dict]:
    """Collect the contiguous unseen prefix, newest -> oldest.

    For an established folder, pagination continues until the first seen legacy ID.
    That seen record is the historical anchor. If the unseen prefix spans more than
    one batch, the caller processes its *oldest* batch first so the anchor moves
    monotonically toward newer mail on subsequent runs and no page is stranded.
    """
    headers = {"Authorization": f"Bearer {access_token}"}
    seen = state.get_pop3_seen(account.id, folder)
    first_sync = not seen
    pending: list[dict] = []
    url: str | None = _graph_message_url(folder_ref)
    visited_urls: set[str] = set()
    scanned = 0
    hit_seen_anchor = False

    while url:
        if url in visited_urls:
            raise RuntimeError("graph message pagination loop detected")
        visited_urls.add(url)
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        payload = response.json()
        values = payload.get("value", []) if isinstance(payload, dict) else []
        if not isinstance(values, list):
            raise RuntimeError("graph message listing returned invalid value payload")

        for item in values:
            if not isinstance(item, dict):
                continue
            mid = str(item.get("id") or "").strip()
            if not mid:
                continue
            scanned += 1
            if graph_uid_key(account, folder, mid) in seen:
                hit_seen_anchor = True
                break
            pending.append(item)

        if hit_seen_anchor or first_sync:
            break

        next_link = _validated_message_next_link(
            payload.get("@odata.nextLink") if isinstance(payload, dict) else None)
        if not next_link:
            break
        if scanned >= _MAX_GRAPH_MESSAGE_SCAN:
            # Fail visibly instead of processing a truncated prefix and creating a
            # false anchor that could strand unseen mail beyond the safety cap.
            raise RuntimeError(
                f"graph message backlog exceeded scan cap {_MAX_GRAPH_MESSAGE_SCAN} before seen anchor")
        url = next_link

    if first_sync:
        initial_limit = getattr(account, "initial_sync_limit", 50)
        if initial_limit > 0 and len(pending) > initial_limit:
            older = pending[initial_limit:]
            state.add_pop3_seen_many(
                account.id, folder,
                [graph_uid_key(account, folder, row["id"]) for row in older],
            )
            pending = pending[:initial_limit]
            log.info(
                "graph account=%s initial sync limit applied: syncing latest %d msgs, marking %d older seen",
                account.id, len(pending), len(older),
            )
    elif len(pending) > BATCH_SIZE:
        # pending is newest -> oldest. Process oldest first so on the next run the
        # first seen key appears deeper/newer and remaining unseen mail stays reachable.
        pending = pending[-BATCH_SIZE:]

    pending.reverse()  # oldest -> newest for ingest
    return pending


def fetch_graph_messages(
    access_token: str,
    account: AccountConfig,
    folder: str,
    state: SyncState,
    folder_ref: str | None = None,
) -> tuple[list[tuple[GraphMessageMeta, bytes]], list[str]]:
    """Fetch one safe Graph batch while preserving legacy seen-state compatibility."""
    resolved_ref = folder_ref or _well_known_folder_ref(folder) or folder
    pending_items = _collect_pending_graph_items(
        access_token, account, folder, state, resolved_ref)
    if not pending_items:
        return [], []

    immutable = _resolve_immutable_metadata(access_token, pending_items)
    headers = {"Authorization": f"Bearer {access_token}"}
    fetched: list[tuple[GraphMessageMeta, bytes]] = []
    oversize_ids: list[str] = []

    for item in pending_items:
        legacy_id = item["id"]
        stable = immutable[legacy_id]
        mime_url = f"https://graph.microsoft.com/v1.0/me/messages/{quote(legacy_id, safe='')}/$value"
        res = requests.get(mime_url, headers=headers, timeout=30)
        if res.status_code != 200:
            log.warning("graph fetch mime failed account=%s msg_id=%s status=%s",
                        account.id, legacy_id, res.status_code)
            continue

        raw_bytes = res.content
        if len(raw_bytes) > MAX_SINGLE_BYTES:
            log.warning(
                "graph skip oversize message account=%s msg_id=%s bytes=%d > limit=%d",
                account.id, legacy_id, len(raw_bytes), MAX_SINGLE_BYTES)
            oversize_ids.append(graph_uid_key(account, folder, legacy_id))
            continue

        received_at_ms = None
        received_at = item.get("receivedDateTime")
        if received_at:
            try:
                received_at_ms = int(datetime.fromisoformat(
                    received_at.replace("Z", "+00:00")).timestamp() * 1000)
            except (TypeError, ValueError):
                log.warning("graph invalid receivedDateTime account=%s msg_id=%s value=%r",
                            account.id, legacy_id, received_at)

        fetched.append((GraphMessageMeta(
            id=stable["id"],
            legacy_id=legacy_id,
            received_at_ms=received_at_ms,
            subject=item.get("subject"),
            conversation_id=stable.get("conversationId"),
            parent_folder_id=stable.get("parentFolderId"),
        ), raw_bytes))

    return fetched, oversize_ids


def sync_graph(account: AccountConfig, config: Config, state: SyncState,
               config_path: str | None = None) -> dict:
    if not account.oauth:
        raise ValueError(f"graph account {account.id} requires oauth configuration")

    access_token = graph_access_token(
        account.oauth,
        make_rotated_callback(config if config.config_path or account.user_managed else None, account),
    )
    folders = account.folders or ["INBOX"]
    targets, discovered_rows = _resolve_graph_folder_targets(access_token, account, folders)
    maybe_sync_graph_folder_catalog(
        access_token, config, account, discovered_rows=discovered_rows)

    total_synced = 0
    total_dropped = 0
    for folder, folder_ref in targets:
        if folder_ref is None:
            # Preserve the historical 4-argument call shape for well-known folders.
            fetched, oversize = fetch_graph_messages(access_token, account, folder, state)
        else:
            fetched, oversize = fetch_graph_messages(
                access_token, account, folder, state, folder_ref=folder_ref)
        if oversize:
            state.add_pop3_seen_many(account.id, folder, oversize)
            total_dropped += len(oversize)
        if not fetched:
            continue

        batch = []
        uploaded_ids = []
        for meta, raw_bytes in fetched:
            legacy_key = graph_uid_key(account, folder, meta.legacy_id)
            try:
                norm = normalize_message(
                    raw_bytes, account, folder,
                    uidvalidity=0, uid=0,
                    internal_date_ms=meta.received_at_ms,
                    imap_uid_override=legacy_key,
                    provider="graph",
                    provider_message_id=meta.id,
                    provider_thread_id=meta.conversation_id,
                    source_folder_id=meta.parent_folder_id,
                    source_key_override=graph_source_key(account, meta.id),
                )
                batch.append(norm)
                uploaded_ids.append(legacy_key)
            except Exception as e:
                total_dropped += 1
                log.warning("skip graph message id=%s account=%s: %r",
                            meta.legacy_id, account.id, e)

        if batch:
            result = upload_emails(config, batch)
            total_synced += result.get("inserted", len(batch))
            state.add_pop3_seen_many(account.id, folder, uploaded_ids)

    return {"synced": total_synced, "dropped": total_dropped, "protocol": "graph"}
