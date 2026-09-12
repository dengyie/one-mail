"""Durable provider write-back worker for Unified Inbox message state.

The Worker owns authorization and queue state. This module only claims short
leases, executes provider-specific desired-state mutations, and reports the
outcome. Provider writes are designed for at-least-once delivery: read/star use
absolute desired state, Graph move uses ImmutableId, and IMAP move/delete add
explicit recovery rules before a retried lease may be reported successful.
"""
from __future__ import annotations

import logging
import re
import uuid
from urllib.parse import quote

import requests
from imapclient.exceptions import IMAPClientAbortError, IMAPClientError

from .config import AccountConfig, Config
from .graph_source import (
    GRAPH_IMMUTABLE_PREFER,
    graph_access_token,
    graph_source_key,
)
from .imap_base import make_imap_uid
from .network_guard import assert_public_user_account, UnsafeMailTargetError
from .oauth import oauth_client_factory
from .remote_accounts import fetch_user_accounts
from .sync import default_client_factory
from .token_store import make_rotated_callback

log = logging.getLogger("one-mail-agg")

CLAIM_LIMIT = 20
_COPYUID_RE = re.compile(r"(?:^|\[)COPYUID\s+(\d+)\s+([0-9:,]+)\s+([0-9:,]+)(?:\]|$)", re.IGNORECASE)
_MAX_UID_SET_EXPANSION = 1000


class MutationUnsupported(RuntimeError):
    pass


class MutationIdentityError(RuntimeError):
    pass


def claim_mutation_jobs(config: Config, *, limit: int = CLAIM_LIMIT) -> tuple[str, list[dict]]:
    lease_token = str(uuid.uuid4())
    response = requests.post(
        f"{config.worker_base_url}/admin/unified/mutations/claim",
        headers={"x-admin-auth": config.admin_token},
        json={"lease_token": lease_token, "limit": limit},
        timeout=15,
    )
    response.raise_for_status()
    payload = response.json()
    jobs = payload.get("jobs", []) if isinstance(payload, dict) else []
    if not isinstance(jobs, list):
        raise RuntimeError("mutation claim returned invalid jobs payload")
    return lease_token, [job for job in jobs if isinstance(job, dict)]


def report_mutation_result(
    config: Config,
    job_id: str,
    lease_token: str,
    status: str,
    *,
    error: str | None = None,
    retry_after_ms: int | None = None,
    projection: dict | None = None,
) -> None:
    body = {"lease_token": lease_token, "status": status}
    if error:
        body["error"] = str(error)[:500]
    if retry_after_ms is not None:
        body["retry_after_ms"] = int(retry_after_ms)
    if projection is not None:
        body["projection"] = projection
    response = requests.post(
        f"{config.worker_base_url}/admin/unified/mutations/{quote(str(job_id), safe='')}/result",
        headers={"x-admin-auth": config.admin_token},
        json=body,
        timeout=15,
    )
    response.raise_for_status()


def _imap_identity(job: dict) -> tuple[str, int, int]:
    folder = str(job.get("source_folder") or "").strip()
    source_key = str(job.get("source_key") or "").strip()
    if not folder or not source_key:
        raise MutationIdentityError("missing IMAP folder/source_key")
    try:
        _prefix, uidvalidity_raw, uid_raw = source_key.rsplit(":", 2)
        uidvalidity = int(uidvalidity_raw)
        uid = int(uid_raw)
    except (ValueError, TypeError):
        raise MutationIdentityError("invalid IMAP source identity") from None
    if uidvalidity <= 0 or uid <= 0:
        raise MutationIdentityError("invalid IMAP UIDVALIDITY/UID")
    return folder, uidvalidity, uid


def _require_imap_capability(client, capability: str) -> None:
    if not client.has_capability(capability):
        raise MutationUnsupported(f"IMAP server does not support required {capability} capability")


def _expand_uid_set(value: str) -> list[int]:
    out: list[int] = []
    for part in value.split(","):
        if ":" in part:
            start_raw, end_raw = part.split(":", 1)
            start, end = int(start_raw), int(end_raw)
            step = 1 if end >= start else -1
            size = abs(end - start) + 1
            if size > _MAX_UID_SET_EXPANSION or len(out) + size > _MAX_UID_SET_EXPANSION:
                raise MutationIdentityError("IMAP COPYUID response is unexpectedly large")
            out.extend(range(start, end + step, step))
        else:
            out.append(int(part))
        if len(out) > _MAX_UID_SET_EXPANSION:
            raise MutationIdentityError("IMAP COPYUID response is unexpectedly large")
    if any(uid <= 0 for uid in out):
        raise MutationIdentityError("IMAP COPYUID contains invalid UID")
    return out


def _parse_copyuid(response, source_uid: int) -> tuple[int, int] | None:
    if response is None:
        return None
    text = response.decode("ascii", errors="replace") if isinstance(response, bytes) else str(response)
    match = _COPYUID_RE.search(text)
    if not match:
        return None
    uidvalidity = int(match.group(1))
    source_uids = _expand_uid_set(match.group(2))
    destination_uids = _expand_uid_set(match.group(3))
    if uidvalidity <= 0 or len(source_uids) != len(destination_uids):
        raise MutationIdentityError("invalid IMAP COPYUID mapping")
    try:
        index = source_uids.index(source_uid)
    except ValueError:
        raise MutationIdentityError("IMAP COPYUID omitted moved source UID") from None
    return uidvalidity, destination_uids[index]


def _imap_recover_moved_message(client, job: dict, target_folder: str) -> tuple[int, int]:
    message_id = str(job.get("message_id_header") or "").strip()
    if not message_id:
        raise MutationIdentityError("IMAP move recovery requires Message-ID")
    selected = client.select_folder(target_folder, readonly=False)
    uidvalidity = int(selected[b"UIDVALIDITY"])
    if uidvalidity <= 0:
        raise MutationIdentityError("invalid target IMAP UIDVALIDITY")
    matches = list(client.search(["HEADER", "Message-ID", message_id], charset=None))
    if len(matches) != 1:
        raise MutationIdentityError(
            f"IMAP move recovery expected exactly one target Message-ID match, found {len(matches)}")
    uid = int(matches[0])
    if uid <= 0:
        raise MutationIdentityError("invalid recovered target IMAP UID")
    return uidvalidity, uid


def _imap_move_projection(
    account: AccountConfig,
    target_folder: str,
    uidvalidity: int,
    uid: int,
) -> dict:
    return {
        "source_folder": target_folder,
        "source_folder_id": None,
        "source_key": make_imap_uid(account.id, account.host, target_folder, uidvalidity, uid),
    }


def _apply_imap_mutation(config: Config, account: AccountConfig, job: dict) -> dict | None:
    if str(job.get("provider") or "").lower() == "pop3" or account.protocol == "pop3":
        raise MutationUnsupported("POP3 has no safe provider write-back semantics")

    folder, expected_uidvalidity, uid = _imap_identity(job)
    factory = oauth_client_factory(account, config) if account.oauth is not None else default_client_factory
    client = factory(account)
    try:
        operation = job.get("operation")
        attempts = max(1, int(job.get("attempts") or 1))

        if operation == "move":
            target_folder = str(job.get("target_folder") or "").strip()
            if not target_folder:
                raise MutationIdentityError("IMAP move missing target folder")
            if not str(job.get("message_id_header") or "").strip():
                raise MutationIdentityError("IMAP move requires Message-ID for retry recovery")
            # MOVE gives atomic source removal; UIDPLUS gives UID EXPUNGE and the
            # server-side UID mapping needed to avoid guessing after a move.
            _require_imap_capability(client, "MOVE")
            _require_imap_capability(client, "UIDPLUS")

            selected = client.select_folder(folder, readonly=False)
            current_uidvalidity = int(selected[b"UIDVALIDITY"])
            if current_uidvalidity != expected_uidvalidity:
                if attempts > 1:
                    recovered = _imap_recover_moved_message(client, job, target_folder)
                    return _imap_move_projection(account, target_folder, *recovered)
                raise MutationIdentityError(
                    f"IMAP UIDVALIDITY changed: expected={expected_uidvalidity} current={current_uidvalidity}")

            if uid not in client.search(["UID", str(uid)], charset=None):
                if attempts > 1:
                    recovered = _imap_recover_moved_message(client, job, target_folder)
                    return _imap_move_projection(account, target_folder, *recovered)
                raise MutationIdentityError(f"IMAP UID {uid} no longer exists in folder {folder!r}")

            response = client.move([uid], target_folder)
            mapped = _parse_copyuid(response, uid)
            if mapped is None:
                # UIDPLUS servers SHOULD return COPYUID for UID MOVE, but safe
                # interoperability still needs a deterministic fallback when a
                # server omits it. Message-ID recovery is deliberately strict.
                mapped = _imap_recover_moved_message(client, job, target_folder)
            else:
                destination_uidvalidity, destination_uid = mapped
                selected_target = client.select_folder(target_folder, readonly=False)
                actual_target_uidvalidity = int(selected_target[b"UIDVALIDITY"])
                if actual_target_uidvalidity != destination_uidvalidity:
                    raise MutationIdentityError(
                        "IMAP MOVE COPYUID target UIDVALIDITY does not match selected destination")
                if destination_uid not in client.search(["UID", str(destination_uid)], charset=None):
                    raise MutationIdentityError("IMAP MOVE destination UID does not exist after MOVE")
            return _imap_move_projection(account, target_folder, *mapped)

        selected = client.select_folder(folder, readonly=False)
        current_uidvalidity = int(selected[b"UIDVALIDITY"])
        if current_uidvalidity != expected_uidvalidity:
            if operation == "delete" and attempts > 1:
                # The old mailbox identity can no longer exist. Never apply the
                # old UID to a reset mailbox; desired deletion is already safe.
                return None
            raise MutationIdentityError(
                f"IMAP UIDVALIDITY changed: expected={expected_uidvalidity} current={current_uidvalidity}")
        exists = uid in client.search(["UID", str(uid)], charset=None)
        if not exists:
            if operation == "delete" and attempts > 1:
                # A prior DELETE may have succeeded and only its Worker report
                # was lost. Absence on a retried lease satisfies desired delete.
                return None
            raise MutationIdentityError(f"IMAP UID {uid} no longer exists in folder {folder!r}")

        desired = bool(job.get("desired_value"))
        if operation == "set_read":
            flags = [b"\\Seen"]
            if desired:
                client.add_flags([uid], flags)
            else:
                client.remove_flags([uid], flags)
            return None
        if operation == "set_starred":
            flags = [b"\\Flagged"]
            if desired:
                client.add_flags([uid], flags)
            else:
                client.remove_flags([uid], flags)
            return None
        if operation == "delete":
            # Plain EXPUNGE could destroy unrelated messages another client
            # already marked \Deleted. UID EXPUNGE is the required exact-delete
            # primitive for this durable job.
            _require_imap_capability(client, "UIDPLUS")
            client.delete_messages([uid], silent=True)
            client.uid_expunge([uid])
            return None
        raise MutationUnsupported(f"unsupported IMAP mutation operation: {operation!r}")
    finally:
        try:
            client.logout()
        except Exception:
            pass


def _scope_token(scope: str) -> str:
    return scope.strip().lower().rstrip("/")


def _graph_scope_allows_write(oauth: dict) -> bool:
    """Fail early only when the stored scope explicitly proves read-only Graph access.

    Older cards can omit scope entirely, and `.default` app scopes do not expose
    individual delegated permissions in this field. Those cases are allowed to
    attempt the write and let Graph make the authoritative decision. A recorded
    Mail.Read token without Mail.ReadWrite can never perform these mutations and
    requires user re-authorization rather than retries.
    """
    raw = str(oauth.get("scope") or "").strip()
    if not raw:
        return True
    tokens = {_scope_token(token) for token in raw.split() if token.strip()}
    if any(token == "mail.readwrite" or token.endswith("/mail.readwrite") for token in tokens):
        return True
    if any(token == "mail.read" or token.endswith("/mail.read") for token in tokens):
        return False
    return True


def _graph_headers(access_token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Prefer": GRAPH_IMMUTABLE_PREFER,
    }


def _graph_move_projection(account: AccountConfig, job: dict, body: dict) -> dict:
    message_id = str(job.get("provider_message_id") or "").strip()
    returned_id = str(body.get("id") or message_id).strip()
    if not returned_id or returned_id != message_id:
        raise MutationIdentityError("Graph move did not preserve ImmutableId")
    target_folder = str(job.get("target_folder") or "").strip()
    target_folder_id = str(body.get("parentFolderId") or job.get("target_folder_id") or "").strip()
    if not target_folder or not target_folder_id:
        raise MutationIdentityError("Graph move result missing target folder identity")
    return {
        "source_folder": target_folder,
        "source_folder_id": target_folder_id,
        "source_key": graph_source_key(account, message_id),
        "provider_message_id": message_id,
    }


def _apply_graph_mutation(config: Config, account: AccountConfig, job: dict) -> dict | None:
    if not account.oauth:
        raise MutationIdentityError("Graph account has no OAuth configuration")
    if not _graph_scope_allows_write(account.oauth):
        raise MutationUnsupported(
            "Microsoft Graph account has Mail.Read only; reconnect it with Mail.ReadWrite to sync message state")
    message_id = str(job.get("provider_message_id") or "").strip()
    if not message_id:
        raise MutationIdentityError("Graph mutation missing ImmutableId")

    access_token = graph_access_token(
        account.oauth,
        make_rotated_callback(config if config.config_path or account.user_managed else None, account),
    )
    headers = _graph_headers(access_token)
    encoded_id = quote(message_id, safe="")
    operation = job.get("operation")
    desired = bool(job.get("desired_value"))

    if operation == "set_read":
        body = {"isRead": desired}
        response = requests.patch(
            f"https://graph.microsoft.com/v1.0/me/messages/{encoded_id}",
            headers=headers,
            json=body,
            timeout=30,
        )
        response.raise_for_status()
        return None
    if operation == "set_starred":
        body = {"flag": {"flagStatus": "flagged" if desired else "notFlagged"}}
        response = requests.patch(
            f"https://graph.microsoft.com/v1.0/me/messages/{encoded_id}",
            headers=headers,
            json=body,
            timeout=30,
        )
        response.raise_for_status()
        return None
    if operation == "move":
        target_folder = str(job.get("target_folder") or "").strip()
        target_folder_id = str(job.get("target_folder_id") or "").strip()
        if not target_folder or not target_folder_id:
            raise MutationIdentityError("Graph move requires stable destination folder ID")

        # If a prior move succeeded but its Worker report was lost, ImmutableId
        # lets us prove the message is already in the requested destination and
        # avoid issuing a second move.
        if max(1, int(job.get("attempts") or 1)) > 1:
            current = requests.get(
                f"https://graph.microsoft.com/v1.0/me/messages/{encoded_id}?$select=id,parentFolderId",
                headers=headers,
                timeout=30,
            )
            current.raise_for_status()
            current_body = current.json()
            if str(current_body.get("parentFolderId") or "") == target_folder_id:
                return _graph_move_projection(account, job, current_body)

        response = requests.post(
            f"https://graph.microsoft.com/v1.0/me/messages/{encoded_id}/move",
            headers=headers,
            json={"destinationId": target_folder_id},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise MutationIdentityError("Graph move returned invalid message payload")
        return _graph_move_projection(account, job, payload)
    if operation == "delete":
        response = requests.delete(
            f"https://graph.microsoft.com/v1.0/me/messages/{encoded_id}",
            headers=headers,
            timeout=30,
        )
        if response.status_code == 404:
            if max(1, int(job.get("attempts") or 1)) > 1:
                # Same at-least-once recovery rule as IMAP: a retried desired
                # delete sees absence as success, while first-attempt absence is
                # an identity problem rather than silent success.
                return None
            raise MutationIdentityError("Graph message no longer exists before delete")
        response.raise_for_status()
        return None
    raise MutationUnsupported(f"unsupported Graph mutation operation: {operation!r}")


def execute_mutation(config: Config, account: AccountConfig, job: dict) -> dict | None:
    provider = str(job.get("provider") or "").lower()
    if provider == "graph":
        return _apply_graph_mutation(config, account, job)
    if provider == "imap":
        return _apply_imap_mutation(config, account, job)
    if provider == "pop3":
        raise MutationUnsupported("POP3 provider mutations are unsupported")
    raise MutationUnsupported(f"unsupported mutation provider: {provider!r}")


def _retryable(error: Exception) -> bool:
    if isinstance(error, (requests.Timeout, requests.ConnectionError, OSError, IMAPClientAbortError)):
        return True
    if isinstance(error, requests.HTTPError):
        status = error.response.status_code if error.response is not None else 0
        return status == 408 or status == 429 or status >= 500
    # IMAPClientError includes authentication/protocol failures. Retrying those
    # blindly hides a terminal account problem; normal sync will surface it too.
    if isinstance(error, IMAPClientError):
        return False
    return False


def process_mutation_jobs(config: Config, *, limit: int = CLAIM_LIMIT) -> dict:
    """Claim and process one mutation batch.

    User credentials are fetched only after at least one job is claimed, so the
    5-second idle poll never repeatedly decrypts/exports every mailbox secret.
    """
    lease_token, jobs = claim_mutation_jobs(config, limit=limit)
    if not jobs:
        return {"claimed": 0, "succeeded": 0, "failed": 0, "retried": 0, "unsupported": 0}

    account_map = {str(account.id): account for account in config.accounts}
    missing_ids = {str(job.get("account_id") or "") for job in jobs} - set(account_map)
    if missing_ids:
        for account in fetch_user_accounts(config.worker_base_url, config.admin_token):
            if account.id in missing_ids:
                account_map[account.id] = account

    result = {"claimed": len(jobs), "succeeded": 0, "failed": 0, "retried": 0, "unsupported": 0}
    for job in jobs:
        job_id = str(job.get("id") or "")
        account_id = str(job.get("account_id") or "")
        account = account_map.get(account_id)
        if not account:
            report_mutation_result(config, job_id, lease_token, "failed", error="mail account configuration unavailable")
            result["failed"] += 1
            continue

        try:
            if account.user_managed:
                assert_public_user_account(account)
            projection = execute_mutation(config, account, job)
        except MutationUnsupported as error:
            report_mutation_result(config, job_id, lease_token, "unsupported", error=str(error))
            result["unsupported"] += 1
        except (MutationIdentityError, UnsafeMailTargetError) as error:
            report_mutation_result(config, job_id, lease_token, "failed", error=str(error))
            result["failed"] += 1
        except Exception as error:
            if _retryable(error):
                attempts = max(1, int(job.get("attempts") or 1))
                retry_ms = min(300_000, 5_000 * (2 ** max(0, attempts - 1)))
                report_mutation_result(
                    config, job_id, lease_token, "retry", error=str(error), retry_after_ms=retry_ms)
                result["retried"] += 1
            else:
                report_mutation_result(config, job_id, lease_token, "failed", error=str(error))
                result["failed"] += 1
        else:
            report_mutation_result(config, job_id, lease_token, "succeeded", projection=projection)
            result["succeeded"] += 1

    return result