"""OAuth2 / XOAUTH2 / Graph send adapters for external-account outbound mail.

Gmail and Outlook/Hotmail/Microsoft 365 use OAuth2 refresh-token exchange +
XOAUTH2 SMTP auth. Graph-based mailboxes send through
POST /me/sendMail.

Every adapter follows the same contract as smtp_sender.py: return
provider_message_id on success, raise classified exceptions for the
process-outbound layer to map to report statuses.
"""
from __future__ import annotations

import base64
import logging
import time
from datetime import datetime

import requests

from .config import AccountConfig
from .graph_source import graph_access_token, GRAPH_IMMUTABLE_PREFER
from .oauth import gmail_access_token, msa_access_token, outlook_access_token
from .smtp_sender import (
    OutboundIdentityError,
    OutboundOutcomeUnknown,
    OutboundSendError,
    OutboundUnsupported,
    ReconcileError,
    build_outbound_mime,
    connect_smtp,
    reconcile_sent_folder,
)
from .token_store import make_rotated_callback, redemption_lock, refresh_rt_from_config

log = logging.getLogger("one-mail-agg")

# Gmail supports XOAUTH2 on port 587 (STARTTLS required). Port 465 is not
# supported for XOAUTH2 by Gmail.
_GMAIL_SMTP = ("smtp.gmail.com", 587, False)
_OUTLOOK_SMTP = ("smtp-mail.outlook.com", 587, False)

_SCOPE_SEND = "mail.send"
_SCOPE_READ = "mail.read"
_SCOPE_READWRITE = "mail.readwrite"


def _scope_token(scope: str) -> str:
    return scope.strip().lower().rstrip("/")


def _graph_scope_allows_send(oauth: dict) -> bool:
    """Fail early only when the stored scope explicitly proves read-only access.

    Older cards may omit scope entirely, and .default app scopes don't expose
    individual delegated permissions. Those cases are allowed to attempt the
    send and let Graph make the authoritative decision.
    """
    raw = str(oauth.get("scope") or "").strip()
    if not raw:
        return True
    tokens = {_scope_token(token) for token in raw.split() if token.strip()}
    # Any write-capable scope implies send permission.
    if any(token == _SCOPE_READWRITE or token.endswith(f"/{_SCOPE_READWRITE}") for token in tokens):
        return True
    if any(token == _SCOPE_SEND or token.endswith(f"/{_SCOPE_SEND}") for token in tokens):
        return True
    # mail.read and nothing else is explicitly read-only.
    if any(token == _SCOPE_READ or token.endswith(f"/{_SCOPE_READ}") for token in tokens):
        return False
    return True


def _xoauth2_auth(client, username: str, access_token: str) -> None:
    """Perform SMTP XOAUTH2 authentication.

    The auth string format is: user={email}\x01auth=Bearer {token}\x01\x01
    """
    auth_string = f"user={username}\x01auth=Bearer {access_token}\x01\x01"
    encoded = base64.b64encode(auth_string.encode()).decode()
    code, resp = client.docmd("AUTH", "XOAUTH2 " + encoded)
    # XOAUTH2 response is 334 + base64 challenge on success, or a JSON error.
    if code != 334:
        error_text = (resp.decode(errors="replace")
                      if isinstance(resp, bytes) else str(resp))
        raise OutboundIdentityError(f"XOAUTH2 auth rejected: {error_text}")


def _send_smtp_xoauth(
    account: AccountConfig,
    payload: dict,
    config,
    token_fn,
    provider_label: str,
) -> str | None:
    """Shared XOAUTH2 SMTP send path used by both Gmail and Outlook."""
    host, port, use_ssl = _GMAIL_SMTP if provider_label == "gmail" else _OUTLOOK_SMTP
    if not account.oauth:
        raise OutboundIdentityError(f"{provider_label} account {account.id} has no OAuth config")

    on_rotated = make_rotated_callback(
        config if (config is not None and (config.config_path or account.user_managed)) else None,
        account,
    )
    with redemption_lock():
        refresh_rt_from_config(config, account)
        access_token = token_fn(account.oauth or {}, on_rotated)

    msg = build_outbound_mime(payload)
    client = None
    try:
        client = connect_smtp(host, port, use_ssl)
        _xoauth2_auth(client, account.username, access_token)
        failures = client.send_message(msg, account.username, payload.get("to_addr") or "")
        if failures:
            rejected = ", ".join(
                f"{addr}: ({code}, {msg_.decode(errors='replace')})"
                for addr, (code, msg_) in failures.items()
            )
            raise OutboundSendError(
                f"{provider_label} SMTP send rejected for recipients: {rejected}")
    except (OutboundIdentityError, OutboundSendError, OutboundOutcomeUnknown):
        raise
    except OSError as error:
        raise OutboundOutcomeUnknown(
            f"{provider_label} SMTP transport lost for {account.id}: {error}") from error
    except Exception as error:
        raise OutboundOutcomeUnknown(
            f"{provider_label} SMTP send outcome is unknown for {account.id}: {error}") from error
    finally:
        if client is not None:
            try:
                client.quit()
            except Exception:
                pass
    return None


def send_gmail(account: AccountConfig, payload: dict, config) -> str | None:
    """Send one message as a Gmail account via XOAUTH2 SMTP.

    Uses smtp.gmail.com:587 with STARTTLS. The connected account's
    credentials (oauth.client_id + refresh_token) are exchanged for an
    access token via the gmail_access_token helper, which preserves the
    original OAuth scope.
    """
    return _send_smtp_xoauth(account, payload, config, gmail_access_token, "gmail")


def send_outlook_smtp(account: AccountConfig, payload: dict, config) -> str | None:
    """Send one message as an Outlook/Hotmail account via XOAUTH2 SMTP.

    Uses smtp-mail.outlook.com:587 with STARTTLS. Consumer (Hotmail/Outlook.com)
    accounts go through the /consumers tenant; organizational accounts use
    /common. The choice is made by the token_fn passed in — see oauth.py for
    the distinction.
    """
    # MSA (consumer) or organizational? The account source determines the tenant.
    source = str(account.source or "").strip().lower()
    token_fn = msa_access_token if source in ("msa", "imap_outlook") else outlook_access_token
    return _send_smtp_xoauth(account, payload, config, token_fn, "outlook")


def send_graph(account: AccountConfig, payload: dict, config) -> str | None:
    """Send one message through Microsoft Graph's sendMail endpoint.

    Requires the Mail.Send delegated permission on the account's OAuth scope —
    most existing IMAP-only cards will not have this and will need a re-auth
    flow to add the scope (see docs/send-mail-external-accounts.md §2.6).

    Returns the Graph ImmutableId of the sent message when saveToSentItems
    successfully creates it, or None if the provider does not expose it.
    """
    if not account.oauth:
        raise OutboundIdentityError(f"Graph account {account.id} has no OAuth config")
    if not _graph_scope_allows_send(account.oauth):
        raise OutboundUnsupported(
            "Microsoft Graph account has a read-only scope; "
            "reconnect it with Mail.ReadWrite or Mail.Send to send mail")
    with redemption_lock():
        refresh_rt_from_config(config, account)
        access_token = graph_access_token(
            account.oauth,
            make_rotated_callback(
                config if (config is not None and (config.config_path or account.user_managed)) else None,
                account,
            ),
        )
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Prefer": GRAPH_IMMUTABLE_PREFER,
    }
    is_html = bool(payload.get("is_html") or payload.get("body_html"))
    content = payload.get("body_html") if is_html else (payload.get("body_text") or "")
    message_body = {
        "subject": str(payload.get("subject") or ""),
        "body": {
            "contentType": "html" if is_html else "text",
            "content": content,
        },
        "toRecipients": [{
            "emailAddress": {
                "address": payload.get("to_addr") or "",
                "name": payload.get("to_name") or "",
            },
        }],
    }
    graph_body = {
        "message": message_body,
        "saveToSentItems": True,
    }
    try:
        response = requests.post(
            "https://graph.microsoft.com/v1.0/me/sendMail",
            headers=headers,
            json=graph_body,
            timeout=30,
        )
        response.raise_for_status()
    except requests.HTTPError as error:
        status = error.response.status_code if error.response is not None else 0
        if status == 403:
            raise OutboundUnsupported(f"Graph sendMail forbidden (scope or policy): {error}") from error
        if status == 408 or status == 429 or status >= 500:
            raise OutboundOutcomeUnknown(
                f"Graph sendMail transient error HTTP {status}: {error}") from error
        raise OutboundSendError(
            f"Graph sendMail rejected HTTP {status}: {error}") from error
    except (requests.Timeout, requests.ConnectionError) as error:
        raise OutboundOutcomeUnknown(
            f"Graph sendMail request lost for {account.id}: {error}") from error
    except requests.RequestException as error:
        raise OutboundOutcomeUnknown(
            f"Graph sendMail outcome is unknown for {account.id}: {error}") from error
    # sendMail returns 202 Accepted with no body on success, so no
    # provider_message_id is available synchronously. The caller can reconcile
    # the Sent Items folder if needed.
    return None


def reconcile_graph_sent(
    account: AccountConfig,
    payload: dict,
    config,
    *,
    window_seconds: int = 300,
) -> str | None:
    """Reconcile a Graph sendMail by querying the account's Sent Items folder.

    Graph sendMail returns 202 with no message id, so a timeout after the
    request leaves the outcome ambiguous. This queries the most recent Sent
    Items messages and matches on subject + sent time, mirroring the IMAP
    sent-folder reconciliation. Returns the ImmutableId when exactly one match
    is found, None when none/ambiguous, and raises ReconcileError on transient
    failures.
    """
    subject = str(payload.get("subject") or "").strip().lower()
    with redemption_lock():
        refresh_rt_from_config(config, account)
        access_token = graph_access_token(
            account.oauth,
            make_rotated_callback(
                config if (config is not None and (config.config_path or account.user_managed)) else None,
                account,
            ),
        )
    headers = {"Authorization": f"Bearer {access_token}"}
    params = {"$top": 10, "$orderby": "sentDateTime desc"}
    try:
        response = requests.get(
            "https://graph.microsoft.com/v1.0/me/mailFolders/SentItems/messages",
            headers=headers,
            params=params,
            timeout=30,
        )
        response.raise_for_status()
        items = response.json().get("value", [])
    except (requests.Timeout, requests.ConnectionError, requests.RequestException) as error:
        raise ReconcileError(
            f"Graph Sent Items reconciliation failed for {account.id}: {error}") from error

    now = time.time()
    matches: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if subject and str(item.get("subject") or "").strip().lower() != subject:
            continue
        sent = item.get("sentDateTime")
        if sent is not None:
            try:
                ts = datetime.fromisoformat(str(sent)).timestamp()
            except (TypeError, ValueError):
                continue
            if abs(now - ts) > window_seconds:
                continue
        immutable_id = item.get("id")
        if immutable_id:
            matches.append(str(immutable_id))
        if len(matches) >= 2:
            break  # ambiguous — stop early
    if len(matches) == 1:
        return matches[0]
    return None


def send_oauth_with_reconcile(
    account: AccountConfig,
    payload: dict,
    config,
) -> str | None:
    """Send an OAuth-backed outbound mail and reconcile an ambiguous outcome.

    Gmail/Outlook XOAUTH2 sends reconcile through the provider's IMAP Sent
    folder (they always have IMAP access); pure-Graph mailboxes reconcile
    through Graph's Sent Items. Mirrors send_with_reconcile for the OAuth path.
    """
    try:
        return send_outbound_oauth(account, payload, config)
    except OutboundOutcomeUnknown as original:
        source = str(account.source or "").strip().lower()
        try:
            if source == "graph_outlook":
                reconciled = reconcile_graph_sent(account, payload, config)
            else:
                reconciled = reconcile_sent_folder(account, payload, config)
        except ReconcileError:
            raise original from None
        if reconciled is not None:
            log.info("OAuth send reconciled: account=%s message=%s", account.id, reconciled)
            return reconciled
        raise original from None


def send_outbound_oauth(
    account: AccountConfig,
    payload: dict,
    config,
) -> str | None:
    """Dispatcher for OAuth-based outbound sends: Gmail, Outlook SMTP, or Graph.

    Provider selection is based on account.source (the same taxonomy used by
    the Worker's providerForAccountSource).
    """
    source = str(account.source or "").strip().lower()
    if source == "imap_gmail":
        return send_gmail(account, payload, config)
    if source in ("imap_outlook", "msa"):
        return send_outlook_smtp(account, payload, config)
    if source == "graph_outlook":
        return send_graph(account, payload, config)
    raise OutboundUnsupported(
        f"unknown OAuth send provider for account {account.id} (source={source})")