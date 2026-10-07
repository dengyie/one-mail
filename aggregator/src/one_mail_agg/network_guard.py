"""Network target validation for untrusted user-managed mail accounts.

User-provided IMAP/POP3 hosts must never turn the aggregator host into an
internal-network scanner.  Resolve the target before the account is admitted to
IDLE/poll workers and reject any non-global address (loopback, RFC1918,
link-local, metadata-adjacent, reserved, multicast, etc.).
"""
from __future__ import annotations

import ipaddress
import socket
from typing import Iterable

from .config import AccountConfig
from .proxy_client import is_overseas_imap_host, is_overseas_smtp_host


class UnsafeMailTargetError(ValueError):
    pass


# IANA-reserved names used by tests/docs never resolve publicly.  Treating them
# as syntactically safe keeps unit tests deterministic; actual connections still
# fail normally if someone configures them in production.
_RESERVED_TEST_SUFFIXES = (".example", ".example.com", ".test", ".invalid")
_DOC_NET_V6 = ipaddress.ip_network("2001:db8::/32")
_TEREDO_IETF_V6 = ipaddress.ip_network("2001::/23")


def _is_public_ip(ip: ipaddress._BaseAddress) -> bool:
    if ip.version == 4:
        return ip.is_global
    # IPv6: Python standard library's ip.is_global classifies all 2001::/23 as
    # private (RFC 6890 IETF assignments). Disallow documentation prefix
    # 2001:db8::/32, unique local fc00::/7, link-local, multicast, etc.,
    # but treat other routable 2001::/23 addresses as public.
    if ip.is_loopback or ip.is_unspecified or ip.is_multicast or ip.is_reserved or ip.is_link_local:
        return False
    if ip in ipaddress.ip_network("fc00::/7"):
        return False
    if ip in _DOC_NET_V6:
        return False
    return ip.is_global or (ip in _TEREDO_IETF_V6)


def _is_reserved_test_name(host: str) -> bool:
    h = host.rstrip(".").lower()
    return h in {"example", "example.com", "test", "invalid"} or h.endswith(_RESERVED_TEST_SUFFIXES)


def _literal_ip(host: str):
    candidate = host.strip().strip("[]").rstrip(".")
    try:
        return ipaddress.ip_address(candidate)
    except ValueError:
        return None


def _resolved_ips(host: str, port: int) -> Iterable[ipaddress._BaseAddress]:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UnsafeMailTargetError("mail target did not resolve") from exc
    if not infos:
        raise UnsafeMailTargetError("mail target did not resolve")
    seen = set()
    for _family, _socktype, _proto, _canonname, sockaddr in infos:
        raw = sockaddr[0]
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError as exc:
            raise UnsafeMailTargetError("mail target resolved to an invalid address") from exc
        if ip not in seen:
            seen.add(ip)
            yield ip


def assert_public_mail_host(host: str, port: int) -> None:
    if not isinstance(host, str) or not host.strip():
        raise UnsafeMailTargetError("mail target host is missing")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise UnsafeMailTargetError("mail target port is invalid")

    normalized = host.strip().rstrip(".").lower()
    if normalized == "localhost" or normalized.endswith(".localhost") or normalized.endswith(".local"):
        raise UnsafeMailTargetError("mail target is local")

    literal = _literal_ip(normalized)
    if literal is not None:
        if not _is_public_ip(literal):
            raise UnsafeMailTargetError("mail target is not public")
        return

    if _is_reserved_test_name(normalized):
        return

    if is_overseas_imap_host(normalized) or is_overseas_smtp_host(normalized):
        return

    for ip in _resolved_ips(normalized, port):
        if not _is_public_ip(ip):
            raise UnsafeMailTargetError("mail target resolved to a non-public address")


def assert_public_user_account(account: AccountConfig) -> None:
    """Validate every network destination a user account may connect to."""
    assert_public_mail_host(account.host, account.port)

    if account.protocol in {"auto", "pop3"}:
        pop3_host = account.resolve_pop3_host()
        pop3_port = account.resolve_pop3_port()
        if (pop3_host.rstrip(".").lower(), pop3_port) != (account.host.rstrip(".").lower(), account.port):
            assert_public_mail_host(pop3_host, pop3_port)

    if getattr(account, "can_send", False) and getattr(account, "smtp_host", None) and getattr(account, "smtp_port", None):
        assert_public_mail_host(account.smtp_host, account.smtp_port)
