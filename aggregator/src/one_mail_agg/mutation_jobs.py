"""Durable provider write-back worker for Unified Inbox message state.

The Worker owns authorization and queue state. This module only claims short
leases, executes provider-specific desired-state mutations, and reports the
outcome. Desired-state operations are idempotent, so lease expiry/retry cannot
turn a duplicate delivery into a toggle.
"""
from __future__ import annotations

import logging
import uuid
from urllib.parse import quote

import requests
from imapclient.exceptions import IMAPClientAbortError, IMAPClientError

from .config import AccountConfig, Config
from .graph_source import GRAPH_IMMUTABLE_PREFER, graph_access_token
from .network_guard import assert_public_user_account, UnsafeMailTargetError
from .oauth import oauth_client_factory
from .remote_accounts import fetch_user_accounts
from .sync import default_client_factory
from .token_store import make_rotated_callback

log = logging.getLogger("one-mail-agg")

CLAIM_LIMIT = 20


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
) -> None:
    body = {"lease_token": lease_token, "status": status}
    if error:
        body["error"] = str(error)[:500]
    if retry_after_ms is not None:
        body["retry_after_ms"] = int(retry_after_ms)
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


def _apply_imap_mutation(config: Config, account: AccountConfig, job: dict) -> None:
    if str(job.get("provider") or "").lower() == "pop3" or account.protocol == "pop3":
        raise MutationUnsupported("POP3 has no safe read/flag write-back semantics")

    folder, expected_uidvalidity, uid = _imap_identity(job)
    factory = oauth_client_factory(account, config) if account.oauth is not None else default_client_factory
    client = factory(account)
    try:
        selected = client.select_folder(folder, readonly=False)
        current_uidvalidity = int(selected[b"UIDVALIDITY"])
        if current_uidvalidity != expected_uidvalidity:
            raise MutationIdentityError(
                f"IMAP UIDVALIDITY changed: expected={expected_uidvalidity} current={current_uidvalidity}")
        if uid not in client.search(["UID", str(uid)], charset=None):
            raise MutationIdentityError(f"IMAP UID {uid} no longer exists in folder {folder!r}")

        operation = job.get("operation")
        desired = bool(job.get("desired_value"))
        if operation == "set_read":
            flags = [b"\\Seen"]
        elif operation == "set_starred":
            flags = [b"\\Flagged"]
        else:
            raise MutationUnsupported(f"unsupported IMAP mutation operation: {operation!r}")

        if desired:
            client.add_flags([uid], flags)
        else:
            client.remove_flags([uid], flags)
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
    attempt PATCH and let Graph make the authoritative decision. A recorded
    Mail.Read token without Mail.ReadWrite, however, can never perform this
    mutation and requires user re-authorization rather than retries.
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


def _apply_graph_mutation(config: Config, account: AccountConfig, job: dict) -> None:
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
    desired = bool(job.get("desired_value"))
    operation = job.get("operation")
    if operation == "set_read":
        body = {"isRead": desired}
    elif operation == "set_starred":
        body = {"flag": {"flagStatus": "flagged" if desired else "notFlagged"}}
    else:
        raise MutationUnsupported(f"unsupported Graph mutation operation: {operation!r}")

    response = requests.patch(
        f"https://graph.microsoft.com/v1.0/me/messages/{quote(message_id, safe='')}",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Prefer": GRAPH_IMMUTABLE_PREFER,
        },
        json=body,
        timeout=30,
    )
    response.raise_for_status()


def execute_mutation(config: Config, account: AccountConfig, job: dict) -> None:
    provider = str(job.get("provider") or "").lower()
    if provider == "graph":
        _apply_graph_mutation(config, account, job)
        return
    if provider == "imap":
        _apply_imap_mutation(config, account, job)
        return
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
            execute_mutation(config, account, job)
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
            report_mutation_result(config, job_id, lease_token, "succeeded")
            result["succeeded"] += 1

    return result
