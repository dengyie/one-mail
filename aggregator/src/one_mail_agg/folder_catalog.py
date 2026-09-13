"""Provider folder discovery for move-target catalog population.

Message ingest naturally discovers folders only after at least one message is seen.
This module fills the missing case: selectable but empty folders. Discovery is
best-effort and throttled per account/provider so realtime IDLE events do not
produce repeated LIST/Graph traffic.
"""
from __future__ import annotations

import logging
import time
from urllib.parse import quote

import requests

from .config import AccountConfig, Config
from .uploader import upload_folders

log = logging.getLogger("one-mail-agg")

_DISCOVERY_INTERVAL_SECONDS = 300
_MAX_GRAPH_FOLDERS = 500
_last_attempt: dict[tuple[str, str], float] = {}


def _text(value) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value or "")


def _imap_folder_type(flags, name: str) -> str:
    normalized = {_text(flag).strip().lower() for flag in (flags or [])}
    if "\\inbox" in normalized or name.strip().lower() == "inbox":
        return "inbox"
    if "\\sent" in normalized:
        return "sent"
    if "\\drafts" in normalized:
        return "drafts"
    if "\\trash" in normalized:
        return "trash"
    if "\\junk" in normalized or "\\spam" in normalized:
        return "spam"
    if "\\archive" in normalized or "\\all" in normalized:
        return "archive"
    return "custom"


def discover_imap_folders(client, account: AccountConfig) -> list[dict]:
    """Return selectable IMAP folders from LIST without selecting them.

    LIST can discover empty folders without changing mailbox state. ``\\Noselect``
    hierarchy placeholders are excluded because they cannot be valid move targets.
    """
    rows: list[dict] = []
    seen: set[str] = set()
    for item in client.list_folders():
        if not isinstance(item, (tuple, list)) or len(item) < 3:
            continue
        flags, _delimiter, raw_name = item[0], item[1], item[2]
        flag_names = {_text(flag).strip().lower() for flag in (flags or [])}
        if "\\noselect" in flag_names or "\\nonexistent" in flag_names:
            continue
        name = _text(raw_name).strip()
        if not name or name in seen:
            continue
        seen.add(name)
        rows.append({
            "account_id": account.id,
            "provider": "imap",
            "provider_folder_id": None,
            "canonical_name": name,
            "display_name": name,
            "folder_type": _imap_folder_type(flags, name),
            "uidvalidity": None,
        })
    return rows


def _graph_folder_url(parent_id: str | None = None) -> str:
    base = "https://graph.microsoft.com/v1.0/me/mailFolders"
    if parent_id:
        base = f"{base}/{quote(parent_id, safe='')}/childFolders"
    return f"{base}?$select=id,displayName,childFolderCount&$top=100&includeHiddenFolders=true"


def _validated_graph_next_link(value) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    if not value.startswith("https://graph.microsoft.com/"):
        raise RuntimeError("graph folder pagination returned an unexpected host")
    return value


def discover_graph_folders(access_token: str, account: AccountConfig) -> list[dict]:
    """Discover Graph folders, including nested child folders and empty folders."""
    headers = {"Authorization": f"Bearer {access_token}"}
    queue = [_graph_folder_url()]
    rows: list[dict] = []
    seen_ids: set[str] = set()

    while queue and len(rows) < _MAX_GRAPH_FOLDERS:
        url = queue.pop(0)
        while url and len(rows) < _MAX_GRAPH_FOLDERS:
            response = requests.get(url, headers=headers, timeout=30)
            response.raise_for_status()
            payload = response.json()
            values = payload.get("value", []) if isinstance(payload, dict) else []
            if not isinstance(values, list):
                raise RuntimeError("graph folder listing returned invalid value payload")

            for item in values:
                if not isinstance(item, dict):
                    continue
                folder_id = str(item.get("id") or "").strip()
                display_name = str(item.get("displayName") or "").strip()
                if not folder_id or not display_name or folder_id in seen_ids:
                    continue
                seen_ids.add(folder_id)
                rows.append({
                    "account_id": account.id,
                    "provider": "graph",
                    "provider_folder_id": folder_id,
                    "canonical_name": display_name,
                    "display_name": display_name,
                    "uidvalidity": None,
                })
                try:
                    child_count = int(item.get("childFolderCount") or 0)
                except (TypeError, ValueError):
                    child_count = 0
                if child_count > 0 and len(rows) < _MAX_GRAPH_FOLDERS:
                    queue.append(_graph_folder_url(folder_id))

            url = _validated_graph_next_link(payload.get("@odata.nextLink")) if isinstance(payload, dict) else None

    if queue or len(rows) >= _MAX_GRAPH_FOLDERS:
        log.warning(
            "graph folder discovery account=%s reached safety cap=%d",
            account.id,
            _MAX_GRAPH_FOLDERS,
        )
    return rows


def _due(provider: str, account_id: str, now: float, force: bool) -> bool:
    if force:
        return True
    previous = _last_attempt.get((provider, account_id))
    return previous is None or now - previous >= _DISCOVERY_INTERVAL_SECONDS


def maybe_sync_imap_folder_catalog(
    client,
    config: Config,
    account: AccountConfig,
    *,
    force: bool = False,
    now: float | None = None,
) -> int:
    """Best-effort IMAP catalog sync; failures never block mail ingestion."""
    current = time.monotonic() if now is None else float(now)
    if not _due("imap", account.id, current, force):
        return 0
    _last_attempt[("imap", account.id)] = current
    try:
        rows = discover_imap_folders(client, account)
        if rows:
            upload_folders(config, rows)
        return len(rows)
    except Exception as error:
        log.warning("imap folder discovery account=%s failed: %s", account.id, error)
        return 0


def maybe_sync_graph_folder_catalog(
    access_token: str,
    config: Config,
    account: AccountConfig,
    *,
    force: bool = False,
    now: float | None = None,
) -> int:
    """Best-effort Graph catalog sync; failures never block message polling."""
    current = time.monotonic() if now is None else float(now)
    if not _due("graph", account.id, current, force):
        return 0
    _last_attempt[("graph", account.id)] = current
    try:
        rows = discover_graph_folders(access_token, account)
        if rows:
            upload_folders(config, rows)
        return len(rows)
    except Exception as error:
        log.warning("graph folder discovery account=%s failed: %s", account.id, error)
        return 0
