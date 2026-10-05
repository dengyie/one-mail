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

from .config import AccountConfig, Config, WorkerDestination
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
from .token_store import make_rotated_callback, redemption_lock, refresh_rt_from_config

log = logging.getLogger("one-mail-agg")

CLAIM_LIMIT = 20
_COPYUID_RE = re.compile(r"(?:^|\[)COPYUID\s+(\d+)\s+([0-9:,]+)\s+([0-9:,]+)(?:\]|$)", re.IGNORECASE)
_MAX_UID_SET_EXPANSION = 1000


class MutationUnsupported(RuntimeError):
    pass


class MutationIdentityError(RuntimeError):
    pass


class MutationOutcomeUnknown(RuntimeError):
    """A location-changing provider call may have committed but cannot be proven yet."""


def _claim_response(config: Config | WorkerDestination, path: str, lease_token: str, limit: int):
    destination = config.destinations[0] if isinstance(config, Config) else config
    return requests.post(
        destination.api_url(path),
        headers=destination.headers(),
        json={"lease_token": lease_token, "limit": limit},
        timeout=15,
    )


def claim_mutation_jobs(config: Config, *, limit: int = CLAIM_LIMIT) -> tuple[str, list[dict]]:
    """Claim with the v2 operation set, falling back to old Workers safely.

    New Workers keep the historical endpoint read/star-only so an old Aggregator
    can never consume move/delete work during a rolling deploy. New Aggregators
    prefer the v2 endpoint; a 404 means the Worker predates v2, where the legacy
    endpoint still has the original read/star behavior.
    """
    return _claim_destination_jobs(config, limit=limit)


def _claim_destination_jobs(
    destination: Config | WorkerDestination, *, limit: int,
) -> tuple[str, list[dict]]:
    lease_token = str(uuid.uuid4())
    response = _claim_response(destination, "/mutations/v2/claim", lease_token, limit)
    if response.status_code == 404:
        response = _claim_response(destination, "/mutations/claim", lease_token, limit)
    response.raise_for_status()
    payload = response.json()
    jobs = payload.get("jobs", []) if isinstance(payload, dict) else []
    if not isinstance(jobs, list):
        raise RuntimeError("mutation claim returned invalid jobs payload")
    return lease_token, [job for job in jobs if isinstance(job, dict)]


def report_mutation_result(
    config: Config | WorkerDestination,
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
    destination = config.destinations[0] if isinstance(config, Config) else config
    response = requests.post(
        destination.api_url(f"/mutations/{quote(str(job_id), safe='')}/result"),
        headers=destination.headers(),
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


def _imap_target_message_matches(client, job: dict, target_folder: str) -> tuple[int, list[int]]:
    message_id = str(job.get("message_id_header") or "").strip()
    if not message_id:
        raise MutationIdentityError("IMAP move recovery requires Message-ID")
    selected = client.select_folder(target_folder, readonly=False)
    uidvalidity = int(selected[b"UIDVALIDITY"])
    if uidvalidity <= 0:
        raise MutationIdentityError("invalid target IMAP UIDVALIDITY")
    matches = [int(uid) for uid in client.search(["HEADER", "Message-ID", message_id], charset=None)]
    if any(uid <= 0 for uid in matches):
        raise MutationIdentityError("invalid target IMAP UID")
    return uidvalidity, matches


def _imap_recover_moved_message(client, job: dict, target_folder: str) -> tuple[int, int]:
    uidvalidity, matches = _imap_target_message_matches(client, job, target_folder)
    if len(matches) != 1:
        raise MutationIdentityError(
            f"IMAP move recovery expected exactly one target Message-ID match, found {len(matches)}")
    return uidvalidity, matches[0]


def _imap_assert_move_target_absent(client, job: dict, target_folder: str) -> None:
    _uidvalidity, matches = _imap_target_message_matches(client, job, target_folder)
    if matches:
        raise MutationIdentityError(
            f"IMAP move target already contains {len(matches)} matching Message-ID message(s)")


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


def _imap_move_outcome_unknown(error: Exception) -> MutationOutcomeUnknown:
    return MutationOutcomeUnknown(f"IMAP MOVE outcome is unknown: {error}")


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

            # Recovery uses Message-ID only when the source UID disappeared after
            # a prior attempt. Prove the destination is initially clear before a
            # first MOVE so a later retry cannot mistake a pre-existing duplicate
            # for the message this job moved.
            if attempts == 1:
                _imap_assert_move_target_absent(client, job, target_folder)

            selected = client.select_folder(folder, readonly=False)
            current_uidvalidity = int(selected[b"UIDVALIDITY"])
            if current_uidvalidity != expected_uidvalidity:
                message = (
                    f"IMAP UIDVALIDITY changed: expected={expected_uidvalidity} "
                    f"current={current_uidvalidity}"
                )
                if attempts > 1:
                    # A prior MOVE may already have committed. Once the old UID
                    # namespace resets, neither the old source UID nor a target
                    # Message-ID alone can prove the post-move identity safely.
                    raise MutationOutcomeUnknown(f"IMAP MOVE outcome is unknown: {message}")
                raise MutationIdentityError(message)

            if uid not in client.search(["UID", str(uid)], charset=None):
                if attempts > 1:
                    try:
                        recovered = _imap_recover_moved_message(client, job, target_folder)
                    except (MutationIdentityError, IMAPClientError, OSError) as error:
                        raise _imap_move_outcome_unknown(error) from error
                    return _imap_move_projection(account, target_folder, *recovered)
                raise MutationIdentityError(f"IMAP UID {uid} no longer exists in folder {folder!r}")

            try:
                response = client.move([uid], target_folder)
            except (IMAPClientError, OSError) as error:
                # Once MOVE is issued, a lost/ambiguous command result cannot be
                # classified as a safe terminal failure. Recovery must run first.
                raise _imap_move_outcome_unknown(error) from error

            try:
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
            except (MutationIdentityError, IMAPClientError, OSError) as error:
                raise _imap_move_outcome_unknown(error) from error
            return _imap_move_projection(account, target_folder, *mapped)

        selected = client.select_folder(folder, readonly=False)
        current_uidvalidity = int(selected[b"UIDVALIDITY"])
        if current_uidvalidity != expected_uidvalidity:
            message = (
                f"IMAP UIDVALIDITY changed: expected={expected_uidvalidity} "
                f"current={current_uidvalidity}"
            )
            if operation == "delete" and attempts > 1:
                # A prior exact delete may have committed, but a UIDVALIDITY reset
                # only invalidates the old UID namespace; it does not prove that
                # the message disappeared. Preserve the ordering barrier and retry
                # recovery rather than deleting the local row on an assumption.
                raise MutationOutcomeUnknown(f"IMAP DELETE outcome is unknown: {message}")
            raise MutationIdentityError(message)
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
            # already marked \\Deleted. UID EXPUNGE is the required exact-delete
            # primitive for this durable job.
            _require_imap_capability(client, "UIDPLUS")
            try:
                client.delete_messages([uid], silent=True)
                client.uid_expunge([uid])
            except (IMAPClientError, OSError) as error:
                raise MutationOutcomeUnknown(f"IMAP DELETE outcome is unknown: {error}") from error
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
    returned_id = str(body.get("id") or "").strip()
    if not returned_id or returned_id != message_id:
        raise MutationIdentityError("Graph move did not preserve ImmutableId")
    target_folder = str(job.get("target_folder") or "").strip()
    target_folder_id = str(body.get("parentFolderId") or "").strip()
    if not target_folder or not target_folder_id:
        raise MutationIdentityError("Graph move result missing target folder identity")
    expected_target_id = str(job.get("target_folder_id") or "").strip()
    if not expected_target_id or target_folder_id != expected_target_id:
        raise MutationIdentityError("Graph move result does not match requested destination")
    return {
        "source_folder": target_folder,
        "source_folder_id": target_folder_id,
        "source_key": graph_source_key(account, message_id),
        "provider_message_id": returned_id,
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

    with redemption_lock():
        refresh_rt_from_config(config, account)
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
            try:
                current = requests.get(
                    f"https://graph.microsoft.com/v1.0/me/messages/{encoded_id}?$select=id,parentFolderId",
                    headers=headers,
                    timeout=30,
                )
                current.raise_for_status()
                current_body = current.json()
                if not isinstance(current_body, dict):
                    raise MutationIdentityError("Graph move recovery returned invalid message payload")
                if str(current_body.get("parentFolderId") or "") == target_folder_id:
                    try:
                        return _graph_move_projection(account, job, current_body)
                    except MutationIdentityError as error:
                        raise MutationOutcomeUnknown(
                            f"Graph MOVE outcome is unknown: {error}") from error
            except MutationOutcomeUnknown:
                raise
            except requests.HTTPError as error:
                status = error.response.status_code if error.response is not None else 0
                if status == 408 or status == 429 or status >= 500:
                    raise
                raise MutationOutcomeUnknown(
                    f"Graph MOVE recovery cannot prove current provider identity: HTTP {status}") from error
            except (requests.Timeout, requests.ConnectionError):
                raise
            except (ValueError, MutationIdentityError) as error:
                raise MutationOutcomeUnknown(f"Graph MOVE outcome is unknown: {error}") from error

        response = requests.post(
            f"https://graph.microsoft.com/v1.0/me/messages/{encoded_id}/move",
            headers=headers,
            json={"destinationId": target_folder_id},
            timeout=30,
        )
        response.raise_for_status()
        try:
            payload = response.json()
            if not isinstance(payload, dict):
                raise MutationIdentityError("Graph move returned invalid message payload")
            return _graph_move_projection(account, job, payload)
        except (ValueError, MutationIdentityError) as error:
            # A successful HTTP MOVE response means the side effect may already
            # be committed. Invalid/missing proof fields are recovery work, not a
            # safe terminal failure that lets later stale-identity jobs run.
            raise MutationOutcomeUnknown(f"Graph MOVE outcome is unknown: {error}") from error
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
    if isinstance(error, MutationOutcomeUnknown):
        return True
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


class MutationBatchError(RuntimeError):
    """One or more queues failed; result contains only acknowledged outcomes."""

    def __init__(self, failures: list[tuple[str, Exception]], result: dict):
        # Keep diagnostic context and the original exceptions/tracebacks while
        # making the printable summary safe for logs (no response bodies/tokens).
        self.failures = tuple(failures)
        super().__init__("mutation batch incomplete: " + "; ".join(
            f"{context}: {type(error).__name__}" for context, error in self.failures))
        self.result = result


def process_mutation_jobs(config: Config, *, limit: int = CLAIM_LIMIT) -> dict:
    """Drain a bounded batch per queue, retaining each queue's lease and origin.

    A queue/report failure is raised after the other queues have been serviced.
    Credentials, OAuth rotation and provider execution always use the original
    primary Config. Idle polls do not export credentials when queues are empty.
    """
    result = {"claimed": 0, "succeeded": 0, "failed": 0, "retried": 0, "unsupported": 0}
    failures = []
    account_map = {str(account.id): account for account in config.accounts}
    fetched_accounts = False
    for destination in config.destinations:
        # Keep the public primary interface (and rollout tests) unchanged.
        origin = config if destination.id == "primary" else destination
        try:
            if destination.id == "primary":
                lease_token, jobs = claim_mutation_jobs(config, limit=limit)
            else:
                lease_token, jobs = _claim_destination_jobs(destination, limit=limit)
        except Exception as error:
            failures.append((f"{destination.id} claim", error))
            continue
        result["claimed"] += len(jobs)
        if not jobs:
            continue

        missing_ids = {str(job.get("account_id") or "") for job in jobs} - set(account_map)
        account_fetch_failed = False
        if missing_ids and not fetched_accounts:
            try:
                accounts = fetch_user_accounts(config.worker_base_url, config.admin_token, raise_on_error=True)
                account_map.update((account.id, account) for account in accounts
                                   if account.id not in account_map)
                fetched_accounts = True
            except Exception as error:
                failures.append((f"{destination.id} account fetch", error))
                account_fetch_failed = True
                # Local credentials can still service other jobs/queues.

        for job in jobs:
            job_id = str(job.get("id") or "")
            account = account_map.get(str(job.get("account_id") or ""))
            status = "succeeded"
            report = {}
            if not account:
                status = "retry" if account_fetch_failed else "failed"
                report["error"] = "mail account configuration unavailable"
                if account_fetch_failed:
                    report["retry_after_ms"] = 5_000
            else:
                try:
                    if account.user_managed:
                        assert_public_user_account(account)
                    report["projection"] = execute_mutation(config, account, job)
                except MutationUnsupported as error:
                    status, report = "unsupported", {"error": str(error)}
                except (MutationIdentityError, UnsafeMailTargetError) as error:
                    status, report = "failed", {"error": str(error)}
                except Exception as error:
                    status, report = "failed", {"error": str(error)}
                    if _retryable(error):
                        status = "retry"
                        attempts = max(1, int(job.get("attempts") or 1))
                        report["retry_after_ms"] = min(300_000, 5_000 * (2 ** max(0, attempts - 1)))
            # Transport failure while reporting is not a provider failure and
            # must never be turned into an acknowledged success/retry/failure.
            try:
                report_mutation_result(origin, job_id, lease_token, status, **report)
            except Exception as error:
                failures.append((f"{destination.id} result job {job_id}", error))
                continue
            result["retried" if status == "retry" else status] += 1

    if failures:
        raise MutationBatchError(failures, result) from failures[0][1]
    return result
