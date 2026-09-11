"""Acceptance tests for the connect-time egress guard.

The matrix mirrors the ops baseline: loopback is denied except the exact
local SOCKS5 tunnel port, private/link-local/metadata/reserved ranges are
denied, public destinations are allowed, and a hostname whose DNS answers
flip to a private address (rebinding simulation) is blocked at connect.
"""
import os
import socket

import pytest

from one_mail_agg.egress_guard import (
    EgressBlockedError,
    _original_connect,
    install_egress_guard,
    uninstall_egress_guard,
)


@pytest.fixture()
def guarded():
    install_egress_guard()
    yield
    uninstall_egress_guard()


def _connect(ip: str, port: int):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    s = socket.socket(family, socket.SOCK_STREAM)
    s.settimeout(1.0)
    try:
        s.connect((ip, port))
    finally:
        s.close()


def test_loopback_denied_except_socks_tunnel(guarded):
    with pytest.raises(EgressBlockedError):
        _connect("127.0.0.1", 9999)
    with pytest.raises(EgressBlockedError):
        _connect("127.0.0.1", 1)
    # Local SOCKS5 tunnel: the only precise loopback exception.  Nothing may
    # be listening in the test environment; a plain network error is fine,
    # an egress-policy rejection is not.
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.0)
    try:
        s.connect(("127.0.0.1", 1080))
    except EgressBlockedError:
        pytest.fail("local SOCKS tunnel port was rejected by egress policy")
    except OSError:
        pass
    finally:
        s.close()


@pytest.mark.parametrize(
    "ip,port",
    [
        ("10.0.0.1", 993),
        ("192.168.1.1", 995),
        ("172.16.5.5", 993),
        ("169.254.169.254", 80),
        ("100.64.0.1", 993),
        ("198.18.0.1", 993),
        ("192.0.0.8", 993),
        ("0.0.0.0", 993),
        ("224.0.0.1", 993),
        ("240.0.0.1", 993),
        ("::1", 993),
        ("fc00::1", 993),
        ("fe80::1", 993),
        ("ff02::1", 993),
        ("::", 993),
    ],
)
def test_private_and_metadata_targets_blocked(guarded, ip, port):
    with pytest.raises(EgressBlockedError):
        _connect(ip, port)


def test_public_address_allowed(guarded):
    # 1.1.1.1:443 must not be rejected by policy; it may fail to connect in
    # a sandbox, but the failure must be a network error, not EgressBlocked.
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(2.0)
    try:
        s.connect(("1.1.1.1", 443))
    except EgressBlockedError:
        pytest.fail("public address was rejected by egress policy")
    except OSError:
        pass
    finally:
        s.close()


def _patch_resolver(monkeypatch, host_results):
    real_getaddrinfo = socket.getaddrinfo

    def fake_getaddrinfo(host, port, *args, **kwargs):
        if host in host_results:
            return [
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))
                for ip in host_results[host]
            ]
        return real_getaddrinfo(host, port, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)


def test_rebinding_hostname_blocked_at_connect(guarded, monkeypatch):
    # Admission-time validation saw the public answer; by connect time DNS
    # answers with a private address.  The guard must block the connect.
    _patch_resolver(monkeypatch, {"rebind.example.com": ["10.1.2.3"]})
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        with pytest.raises(EgressBlockedError):
            s.connect(("rebind.example.com", 993))
    finally:
        s.close()


def test_rebinding_mixed_answers_blocked(guarded, monkeypatch):
    _patch_resolver(monkeypatch, {"mixed.example.com": ["1.2.3.4", "192.168.0.9"]})
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        with pytest.raises(EgressBlockedError):
            s.connect(("mixed.example.com", 993))
    finally:
        s.close()


def test_public_hostname_connects_to_validated_numeric_address(guarded, monkeypatch):
    import one_mail_agg.egress_guard as eg
    captured = {}

    def spy_connect(sock, address):
        captured["address"] = address
        raise ConnectionRefusedError(111, "not connecting for real")

    # Patch the stock connect the guard delegates to, so we can observe the
    # numeric address the guard decided to connect to.
    monkeypatch.setattr(eg, "_original_connect", spy_connect)
    _patch_resolver(monkeypatch, {"mail.example.com": ["93.184.216.34"]})
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        with pytest.raises(ConnectionRefusedError):
            s.connect(("mail.example.com", 993))
    finally:
        s.close()
    assert captured["address"] == ("93.184.216.34", 993)


def test_non_tcp_unix_sockets_untouched(guarded):
    # Guard is TCP-only: unix socket connects pass through unchanged.
    path = f"/tmp/om-guard-{os.getpid()}.sock"
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(1)
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.connect(path)  # must not raise EgressBlockedError
    finally:
        client.close()
        server.close()
        try:
            os.unlink(path)
        except OSError:
            pass


def test_install_is_idempotent():
    install_egress_guard()
    install_egress_guard()
    try:
        with pytest.raises(EgressBlockedError):
            _connect("10.0.0.1", 993)
    finally:
        uninstall_egress_guard()
    assert socket.socket.connect is _original_connect
