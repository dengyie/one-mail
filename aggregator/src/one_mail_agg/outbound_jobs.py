"""Durable external-account outbound mail worker.

Mirrors mutation_jobs.py: the Worker owns authorization and queue state, and
this module claims short leases, executes provider-specific sends, reconciles
ambiguous outcomes, and reports the result (at-least-once semantics).

Sending is irreversible. When a provider call times out or drops mid-send, the
adapter reconciles the provider's Sent folder before deciding; a reconciled
message is reported succeeded, a definite "not sent" is retried, and an
unresolvable outcome stays unknown so the lease is retried with backoff.
"""
from __future__ import annotations

import logging
import uuid
from urllib.parse import quote

import requests
from imapclient.exceptions import IMAPClientAbortError, IMAPClientError

from .config import AccountConfig, Config, WorkerDestination
from .network_guard import assert_public_user_account, UnsafeMailTargetError
from .oauth_sender import send_oauth_with_reconcile
from .remote_accounts import fetch_user_accounts
from .smtp_sender import (
    OutboundIdentityError,
    OutboundOutcomeUnknown,
    OutboundSendError,
    OutboundUnsupported,
    ReconcileError,
    send_with_reconcile,
)

log = logging.getLogger("one-mail-agg")

OUTBOUND_CLAIM_LIMIT = 20


class OutboundBatchError(RuntimeError):
    """One or more queues failed; result contains only acknowledged outcomes."""

    def __init__(self, failures: list[tuple[str, Exception]], result: dict):
        self.failures = tuple(failures)
        super().__init__("outbound batch incomplete: " + "; ".join(
            f"{context}: {type(error).__name__}" for context, error in self.failures))
        self.result = result


def _claim_response(config: Config | WorkerDestination, lease_token: str, limit: int):
    destination = config.destinations[0] if isinstance(config, Config) else config
    return requests.post(
        destination.api_url("/outbound/claim"),
        headers=destination.headers(),
        json={"lease_token": lease_token, "limit": limit},
        timeout=15,
    )


def claim_outbound_jobs(config: Config, *, limit: int = OUTBOUND_CLAIM_LIMIT) -> tuple[str, list[dict]]:
    """Claim a bounded batch of pending outbound jobs for one worker."""
    lease_token = str(uuid.uuid4())
    response = _claim_response(config, lease_token, limit)
    response.raise_for_status()
    payload = response.json()
    jobs = payload.get("jobs", []) if isinstance(payload, dict) else []
    if not isinstance(jobs, list):
        raise RuntimeError("outbound claim returned invalid jobs payload")
    return lease_token, [job for job in jobs if isinstance(job, dict)]


def report_outbound_result(
    config: Config | WorkerDestination,
    job_id: str,
    lease_token: str,
    status: str,
    *,
    error: str | None = None,
    retry_after_ms: int | None = None,
    provider_message_id: str | None = None,
) -> None:
    body = {"lease_token": lease_token, "status": status}
    if error:
        body["error"] = str(error)[:1000]
    if retry_after_ms is not None:
        body["retry_after_ms"] = int(retry_after_ms)
    if provider_message_id:
        body["provider_message_id"] = str(provider_message_id)
    destination = config.destinations[0] if isinstance(config, Config) else config
    response = requests.post(
        destination.api_url(f"/outbound/{quote(str(job_id), safe='')}/result"),
        headers=destination.headers(),
        json=body,
        timeout=15,
    )
    response.raise_for_status()


def _payload_from_job(job: dict) -> dict:
    """Reconstruct the send payload from a claimed outbound job."""
    import json
    payload_json = job.get("payload_json")
    if isinstance(payload_json, str) and payload_json:
        try:
            parsed = json.loads(payload_json)
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            pass
    return {
        "from_addr": str(job.get("from_addr") or ""),
        "to_addr": str(job.get("to_addr") or ""),
        "subject": str(job.get("subject") or ""),
        "body_text": job.get("body_text"),
        "body_html": job.get("body_html"),
        "is_html": bool(job.get("body_html")),
    }


def execute_outbound(config: Config, account: AccountConfig, job: dict) -> dict | None:
    """Execute one outbound send and return a report projection (or None)."""
    payload = _payload_from_job(job)
    if not payload.get("to_addr"):
        raise OutboundIdentityError("outbound job has no recipient address")
    if not payload.get("from_addr"):
        raise OutboundIdentityError("outbound job has no from address")
    # Defense-in-depth: the Worker enforces the same invariant, but the aggregator
    # must never forge a From header other than the account's own authenticated
    # address (an SMTP/OAuth session logs in as `account.username`).
    if str(payload.get("from_addr")).strip().lower() != account.username.strip().lower():
        raise OutboundIdentityError(
            f"outbound job from address {payload.get('from_addr')!r} does not match account {account.id}")

    source = str(account.source or "").strip().lower()
    if source in ("imap_qq", "imap_163", "imap_custom"):
        # App-password SMTP send with sent-folder reconciliation on ambiguity.
        provider_id = send_with_reconcile(account, payload, config)
    elif source in ("imap_gmail", "imap_outlook", "msa", "graph_outlook"):
        # OAuth/XOAUTH2/Graph send with provider-side reconciliation on ambiguity.
        provider_id = send_oauth_with_reconcile(account, payload, config)
    else:
        raise OutboundUnsupported(
            f"unknown outbound provider for account {account.id} (source={source})")

    if provider_id:
        return {"provider_message_id": provider_id}
    return None


def _retryable(error: Exception) -> bool:
    if isinstance(error, (OutboundOutcomeUnknown, ReconcileError)):
        return True
    # HTTPError is a subclass of OSError (via IOError), so its status-code
    # discrimination must be checked before the generic OSError branch.
    if isinstance(error, requests.HTTPError):
        status = error.response.status_code if error.response is not None else 0
        return status == 408 or status == 429 or status >= 500
    if isinstance(error, (requests.Timeout, requests.ConnectionError, OSError, IMAPClientAbortError)):
        return True
    if isinstance(error, IMAPClientError):
        return False
    return False


def process_outbound_jobs(config: Config, *, limit: int = OUTBOUND_CLAIM_LIMIT) -> dict:
    """Drain a bounded batch of outbound jobs for the primary destination.

    Outbound jobs are only claimed from the primary Worker (the endpoint is not
    sharded); external accounts are always owned by the primary. Fails visibly
    on queue/report errors while acknowledging per-job outcomes.
    """
    result = {"claimed": 0, "succeeded": 0, "failed": 0, "retried": 0, "unsupported": 0}
    failures: list[tuple[str, Exception]] = []
    account_map = {str(account.id): account for account in config.accounts}
    fetched_accounts = False

    try:
        lease_token, jobs = claim_outbound_jobs(config, limit=limit)
    except Exception as error:
        raise OutboundBatchError([("primary claim", error)], result) from error
    result["claimed"] = len(jobs)
    if not jobs:
        return result

    missing_ids = {str(job.get("account_id") or "") for job in jobs} - set(account_map)
    account_fetch_failed = False
    if missing_ids and not fetched_accounts:
        try:
            accounts = fetch_user_accounts(config.worker_base_url, config.admin_token, raise_on_error=True)
            account_map.update((account.id, account) for account in accounts
                               if account.id not in account_map)
            fetched_accounts = True
        except Exception as error:
            failures.append(("primary account fetch", error))
            account_fetch_failed = True

    for job in jobs:
        job_id = str(job.get("id") or "")
        account = account_map.get(str(job.get("account_id") or ""))
        status = "succeeded"
        report: dict = {}
        if not account:
            status = "retry" if account_fetch_failed else "failed"
            report["error"] = "mail account configuration unavailable"
            if account_fetch_failed:
                report["retry_after_ms"] = 5_000
        elif not account.can_send:
            status = "unsupported"
            report["error"] = "account has not been enabled for sending (can_send)"
        else:
            try:
                if account.user_managed:
                    assert_public_user_account(account)
                projection = execute_outbound(config, account, job)
                if projection:
                    report["provider_message_id"] = projection.get("provider_message_id")
            except OutboundUnsupported as error:
                status, report = "unsupported", {"error": str(error)}
            except (OutboundIdentityError, OutboundSendError, UnsafeMailTargetError) as error:
                status, report = "failed", {"error": str(error)}
            except Exception as error:
                status, report = "failed", {"error": str(error)}
                if _retryable(error):
                    status = "retry"
                    attempts = max(1, int(job.get("attempts") or 1))
                    report["retry_after_ms"] = min(300_000, 5_000 * (2 ** max(0, attempts - 1)))
        try:
            report_outbound_result(config, job_id, lease_token, status, **report)
        except Exception as error:
            failures.append((f"primary result job {job_id}", error))
            continue
        result["retried" if status == "retry" else status] += 1

    if failures:
        raise OutboundBatchError(failures, result) from failures[0][1]
    return result