"""Connect-time egress enforcement for the aggregator process.

network_guard.py validates a mail target's DNS resolution *before* the
account is admitted to the IDLE/poll workers.  Between that check and the
actual connect(2), the same hostname can resolve to a different address
(DNS rebinding / TOCTOU), and the aggregator host has no kernel-level
outbound filtering available (no CAP_NET_ADMIN / systemd / docker in the
deployment container).

This module closes that window inside the process: every outbound TCP
connect is re-validated at the moment the kernel is asked to connect,
against the exact address that would be used.  Hostname arguments are
resolved here and replaced by the validated numeric address, so no second
resolution can happen after the check.
"""
from __future__ import annotations

import errno
import ipaddress
import socket
from typing import Iterable

# The local SOCKS5 tunnel used for overseas IMAP hosts is the only loopback
# destination the aggregator may ever connect to.  A precise host:port
# exception, never a whole loopback range.
_SOCKS_LOOPBACK = (ipaddress.ip_address("127.0.0.1"), 1080)

# Minimum deny set required by the ops baseline.  ``is_global`` rejects a
# superset of these; the explicit nets keep the policy auditable.
_DENY_V4 = [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "224.0.0.0/4",
    "240.0.0.0/4",
]
_DENY_V6 = [
    "::/128",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
    "ff00::/8",
]
_DENY_NETS = [ipaddress.ip_network(n) for n in _DENY_V4 + _DENY_V6]

_original_connect = socket.socket.connect


class EgressBlockedError(OSError):
    def __init__(self, target: str):
        super().__init__(
            errno.EPERM,
            f"egress policy blocked connect to {target}",
        )


def _decode_host(host) -> str:
    if isinstance(host, bytes):
        return host.decode("idna")
    return str(host)


def _is_denied(ip: ipaddress._BaseAddress, port: int) -> bool:
    if ip == _SOCKS_LOOPBACK[0] and port == _SOCKS_LOOPBACK[1]:
        return False
    for net in _DENY_NETS:
        if ip in net:
            return True
    return not ip.is_global


def _validate_sockaddr(host: str, port: int, family: int):
    try:
        ip = ipaddress.ip_address(host.strip("[]").rstrip("."))
    except ValueError:
        return None
    if family in (socket.AF_INET, socket.AF_INET6) and _is_denied(ip, port):
        raise EgressBlockedError(f"{ip}:{port}")
    return ip


def _resolve_and_validate(host: str, port: int) -> list[tuple[int, tuple]]:
    """Resolve a hostname and return validated connect addresses.

    Raises EgressBlockedError when any resolved address is denied: a name
    that rebinding-flips between public and private answers must not get a
    successful connect for the private answer.
    """
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not infos:
        raise EgressBlockedError(f"{host}:{port}")
    validated: list[tuple[int, tuple]] = []
    for family, _socktype, _proto, _canonname, sockaddr in infos:
        ip = _validate_sockaddr(str(sockaddr[0]), port, family)
        if ip is None:
            continue
        if family == socket.AF_INET6:
            validated.append((family, (str(ip), sockaddr[1], sockaddr[2], sockaddr[3])))
        else:
            validated.append((family, (str(ip), sockaddr[1])))
    if not validated:
        raise EgressBlockedError(f"{host}:{port}")
    return validated


def _guarded_connect(self, address):
    if (
        isinstance(address, tuple)
        and len(address) >= 2
        and getattr(self, "type", 0) & socket.SOCK_STREAM
        and getattr(self, "family", 0) in (socket.AF_INET, socket.AF_INET6)
    ):
        host = _decode_host(address[0])
        port = address[1]
        if _validate_sockaddr(host, port, self.family) is None:
            # Hostname: resolve, validate every answer, and connect to the
            # validated numeric address so no post-check re-resolution exists.
            resolved = _resolve_and_validate(host, port)
            same_family = [sa for family, sa in resolved if family == self.family]
            _original_connect(self, (same_family or [resolved[0][1]])[0])
            return
    _original_connect(self, address)


def install_egress_guard() -> None:
    """Patch outbound TCP connects with connect-time policy enforcement."""
    if socket.socket.connect is not _original_connect:
        return
    socket.socket.connect = _guarded_connect


def uninstall_egress_guard() -> None:
    """Restore the stock connect.  Intended for tests only."""
    socket.socket.connect = _original_connect


def iter_denied_targets() -> Iterable[str]:
    """Audit helper: the documented minimum deny list."""
    for net in _DENY_NETS:
        yield str(net)
