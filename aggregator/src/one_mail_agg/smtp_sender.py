"""SMTP send adapters for external-account outbound mail.

Supports app-password auth (QQ / 163 / custom IMAP) over SSL (465) or STARTTLS
(587). Sending is irreversible: every adapter must implement sent-folder
reconciliation so a timeout after a committed send is never treated as a safe
retry.

Proxy / egress policy follows the same pattern as IMAP: overseas SMTP hosts
route through the local SOCKS5 proxy when configured.
"""
from __future__ import annotations

import logging
import smtplib
import ssl
import time
from email.message import EmailMessage
from email.utils import formataddr, localtime, parsedate_to_datetime

from imapclient.exceptions import IMAPClientAbortError, IMAPClientError
from .config import AccountConfig
from .oauth import oauth_client_factory
from .proxy_client import create_socks5_socket
from .sync import default_client_factory

log = logging.getLogger("one-mail-agg")

# Per-source SMTP endpoint defaults. A host in OVERSEAS_SMTP_HOSTS is routed
# through the configured SOCKS5 proxy like its IMAP counterpart.
SMTP_DEFAULTS: dict[str, tuple[str, int, bool]] = {
    "imap_qq": ("smtp.qq.com", 465, True),
    "imap_163": ("smtp.163.com", 465, True),
    "imap_gmail": ("smtp.gmail.com", 587, False),
    "imap_outlook": ("smtp-mail.outlook.com", 587, False),
    "msa": ("smtp-mail.outlook.com", 587, False),
}

OVERSEAS_SMTP_HOSTS: set[str] = {
    "smtp.gmail.com",
    "smtp-mail.outlook.com",
}

# Well-known Sent folder names by provider. Reconciliation falls back to a few
# common candidates when the primary name is absent.
SENT_FOLDER_CANDIDATES: dict[str, list[str]] = {
    "imap_qq": ["Sent", "已发送", "Sent Items"],
    "imap_163": ["Sent", "已发送", "Sent Items"],
    "imap_custom": ["Sent", "Sent Items"],
    "imap_gmail": ["[Gmail]/Sent Mail", "Sent"],
    "imap_outlook": ["Sent Items", "Sent"],
    "msa": ["Sent Items", "Sent"],
    "graph_outlook": ["Sent Items"],
}


class OutboundUnsupported(RuntimeError):
    pass


class OutboundIdentityError(RuntimeError):
    """Terminal failure: account or credentials are misconfigured."""


class OutboundSendError(RuntimeError):
    """The provider rejected the send with a definite, non-retryable reason."""


class OutboundOutcomeUnknown(RuntimeError):
    """SMTP command was issued but its result is ambiguous (timeout/disconnect).
    Reconciliation must run before this job can be retried or reported succeeded."""


class ReconcileError(RuntimeError):
    """Sent-folder reconciliation could not determine the outcome."""


def _resolve_smtp_endpoint(account: AccountConfig) -> tuple[str, int, bool]:
    """Return (host, port, use_ssl) for the account's SMTP send path.

    Explicit smtp_host / smtp_port on the account override any per-source default.
    Port 465 universally defaults to SSL, while 587 / 25 default to STARTTLS.
    """
    source = str(account.source or "").strip().lower()
    defaults = SMTP_DEFAULTS.get(source, ("", 0, False))
    host = account.smtp_host or defaults[0]
    port = account.smtp_port or defaults[1]
    if port == 465:
        use_ssl = True
    elif port in (587, 25):
        use_ssl = False
    else:
        use_ssl = bool(defaults[2])
    return host, port, use_ssl


def _use_proxy(host: str) -> bool:
    return host.lower() in OVERSEAS_SMTP_HOSTS


class _ProxySMTP_SSL(smtplib.SMTP_SSL):
    """SMTP_SSL whose TCP socket is established through the local SOCKS5 proxy."""

    proxy_host: str = "127.0.0.1"
    proxy_port: int = 1080

    def _get_socket(self, host, port, timeout):
        raw = create_socks5_socket(self.proxy_host, self.proxy_port, host, port, timeout)
        return self.context.wrap_socket(raw, server_hostname=host)


class _ProxySMTP(smtplib.SMTP):
    """Plain SMTP (STARTTLS upgrade path) whose socket goes through SOCKS5."""

    proxy_host: str = "127.0.0.1"
    proxy_port: int = 1080

    def _get_socket(self, host, port, timeout):
        return create_socks5_socket(self.proxy_host, self.proxy_port, host, port, timeout)


def _connect_smtp_ssl(host: str, port: int, timeout: float) -> smtplib.SMTP_SSL:
    """Create an SMTP_SSL connection, optionally via SOCKS5 for overseas hosts."""
    if _use_proxy(host):
        return _ProxySMTP_SSL(host, port, timeout=timeout)
    return smtplib.SMTP_SSL(host, port, timeout=timeout)


def _connect_smtp_starttls(host: str, port: int, timeout: float) -> smtplib.SMTP:
    """Create a plain SMTP connection, then upgrade to STARTTLS. Proxy-aware."""
    if _use_proxy(host):
        client: smtplib.SMTP = _ProxySMTP(host, port, timeout=timeout)
    else:
        client = smtplib.SMTP(host, port, timeout=timeout)
    # ehlo_or_helo_if_needed() issues EHLO (falling back to HELO) and raises
    # SMTPHeloError when the greeting fails; it returns None, so the reply code
    # must not be unpacked from its return value.
    try:
        client.ehlo_or_helo_if_needed()
    except smtplib.SMTPHeloError as error:
        raise OutboundIdentityError(f"SMTP EHLO to {host}:{port} failed: {error}") from error
    if client.has_extn("starttls"):
        ctx = ssl.create_default_context()
        client.starttls(context=ctx)
        client.ehlo_or_helo_if_needed()
    return client


def connect_smtp(host: str, port: int, use_ssl: bool, timeout: float = 30.0) -> smtplib.SMTP:
    """Connect to the SMTP server with the correct transport (SSL or STARTTLS)."""
    if use_ssl:
        return _connect_smtp_ssl(host, port, timeout)
    return _connect_smtp_starttls(host, port, timeout)


def build_outbound_mime(payload: dict) -> EmailMessage:
    """Construct an RFC 5322 MIME message from the outbound job payload."""
    msg = EmailMessage()
    msg["From"] = formataddr((
        payload.get("from_name") or "",
        payload.get("from_addr") or "",
    ))
    msg["To"] = formataddr((
        payload.get("to_name") or "",
        payload.get("to_addr") or "",
    ))
    msg["Subject"] = str(payload.get("subject") or "")
    msg["Date"] = localtime()
    is_html = bool(payload.get("is_html") or payload.get("body_html"))
    content = payload.get("body_html") if is_html else (payload.get("body_text") or "")
    subtype = "html" if is_html else "plain"
    msg.set_content(content, subtype=subtype)
    return msg


def send_smtp_message(account: AccountConfig, payload: dict) -> str | None:
    """Send one message via plain password-auth SMTP (QQ/163/custom).

    Returns the provider-allocated message id (if the server provides one), or
    None. Raises OutboundUnsupported / OutboundIdentityError for terminal
    failures and OutboundOutcomeUnknown when the send may have committed but
    the response was lost.
    """
    host, port, use_ssl = _resolve_smtp_endpoint(account)
    if not host:
        raise OutboundUnsupported(
            f"no SMTP host configured for account {account.id} (source={account.source})")
    if not account.username or not account.password:
        raise OutboundIdentityError(f"account {account.id} has no SMTP credentials")

    msg = build_outbound_mime(payload)
    provider_id: str | None = None
    client = None
    try:
        client = connect_smtp(host, port, use_ssl)
        client.login(account.username, account.password)
        failures = client.send_message(msg, account.username, payload.get("to_addr") or "")
        if failures:
            rejected = ", ".join(
                f"{addr}: ({code}, {msg.decode(errors='replace')})"
                for addr, (code, msg) in failures.items()
            )
            raise OutboundSendError(f"SMTP send rejected for recipients: {rejected}")
    except OutboundOutcomeUnknown:
        raise
    except OutboundUnsupported:
        raise
    except OutboundIdentityError:
        raise
    except (smtplib.SMTPAuthenticationError, smtplib.SMTPHeloError) as error:
        raise OutboundIdentityError(f"SMTP auth/HELO failed for {account.id}: {error}") from error
    except (smtplib.SMTPSenderRefused, smtplib.SMTPRecipientsRefused, smtplib.SMTPDataError) as error:
        raise OutboundSendError(f"SMTP send refused for {account.id}: {error}") from error
    except smtplib.SMTPException as error:
        # Any other SMTP error after DATA may have committed the message.
        # The provider has no obligation to report idempotency after a soft
        # protocol error, so treat this as outcome-unknown.
        raise OutboundOutcomeUnknown(
            f"SMTP send outcome is unknown for {account.id}: {error}") from error
    except OSError as error:
        raise OutboundOutcomeUnknown(
            f"SMTP transport lost for {account.id}: {error}") from error
    finally:
        if client is not None:
            try:
                client.quit()
            except Exception:
                pass
    return provider_id


def _discover_sent_folder(account: AccountConfig, client) -> str:
    """Find the primary Sent folder for this account's provider.

    Tries the well-known candidates (in order), then falls back to listing
    available folders for an exact or case-insensitive 'Sent' / 'Sent Items'
    match. Raises OutboundUnsupported when no candidate exists.
    """
    source = str(account.source or "").strip().lower()
    candidates = SENT_FOLDER_CANDIDATES.get(source, ["Sent", "Sent Items"])
    try:
        available: list[str] = []
        for entry in client.list_folders():
            if not isinstance(entry, (tuple, list)) or not entry:
                continue
            raw = entry[-1]
            if isinstance(raw, bytes):
                available.append(raw.decode("utf-8", errors="replace"))
            else:
                available.append(str(raw or ""))
    except (IMAPClientError, OSError):
        available = list(candidates)

    for candidate in candidates:
        for folder in available:
            if str(folder).strip() == candidate:
                return candidate
    raise OutboundUnsupported(
        f"no Sent folder found for account {account.id} (source={source})")


def _imap_client_for_account(account: AccountConfig, config):
    """Create an authenticated IMAP client for Sent-folder reconciliation.

    Chooses OAuth or password auth based on the account's credentials, using
    the same factory as the rest of the aggregator.
    """
    if account.oauth is not None:
        factory = oauth_client_factory(account, config)
    else:
        factory = default_client_factory
    return factory(account)


def reconcile_sent_folder(
    account: AccountConfig,
    payload: dict,
    config,
    *,
    window_seconds: int = 300,
) -> str | None:
    """Search the provider's Sent folder for a message matching this send request.

    Looks for messages with the same subject line received within *window_seconds*
    of now. When exactly one match is found, returns its provider message id.
    When zero or multiple matches exist, the outcome stays unknown so the caller
    can retry reconciliation rather than double-send or silently skip.

    Raises ReconcileError when the search cannot complete (transient IMAP error).
    """
    client = None
    try:
        client = _imap_client_for_account(account, config)
        folder = _discover_sent_folder(account, client)
        client.select_folder(folder, readonly=True)
        # Search for messages with this subject that arrived in the window.
        # Prefer the Subject header (no charset) for broadest compatibility.
        subject = str(payload.get("subject") or "").strip()
        criteria = ["SUBJECT", subject] if subject else ["ALL"]
        recent_ids = client.search(criteria)
        if not recent_ids:
            return None
        # Narrow by sent date: fetch INTERNALDATE for the most recent matches
        # and keep only messages within the time window.
        now = time.time()
        matches = []
        for uid in sorted(recent_ids, key=int, reverse=True):
            response = client.fetch([uid], ["INTERNALDATE", "ENVELOPE"])
            data = response.get(uid, {})
            internaldate = data.get(b"INTERNALDATE")
            if internaldate is not None and isinstance(internaldate, bytes):
                internaldate = internaldate.decode("ascii", errors="replace")
            if internaldate is not None:
                try:
                    ts = parsedate_to_datetime(internaldate).timestamp()
                except (TypeError, ValueError):
                    continue
                if abs(now - ts) <= window_seconds:
                    # Exact subject match after the time filter.
                    envelope = data.get(b"ENVELOPE", b"")
                    if envelope and isinstance(envelope, bytes):
                        envelope = envelope.decode("ascii", errors="replace")
                    if subject.lower() in str(envelope).lower():
                        matches.append((uid, internaldate))
            if len(matches) >= 2:
                break  # ambiguous — stop early
        if len(matches) == 1:
            return str(matches[0][0])
    except (IMAPClientError, OSError, IMAPClientAbortError) as error:
        raise ReconcileError(
            f"Sent folder reconciliation failed for {account.id}: {error}") from error
    finally:
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass
    return None


def send_with_reconcile(
    account: AccountConfig,
    payload: dict,
    config,
) -> str | None:
    """Send and, if the outcome is ambiguous, reconcile the Sent folder.

    This is the safe, idempotent wrapper for executing one outbound send. It
    catches OutboundOutcomeUnknown, runs reconciliation, and either returns the
    reconciled provider message id (touch a failed outcome to succeeded) or
    leaves the outcome unknown for the process layer to retry.
    """
    try:
        return send_smtp_message(account, payload)
    except OutboundOutcomeUnknown as original:
        try:
            reconciled = reconcile_sent_folder(account, payload, config)
        except ReconcileError:
            raise original from None
        if reconciled is not None:
            log.info("SMTP send reconciled: account=%s message=%s", account.id, reconciled)
            return reconciled
        raise original from None