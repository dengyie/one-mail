import socket

import pytest

from one_mail_agg.config import AccountConfig
from one_mail_agg.network_guard import (
    UnsafeMailTargetError,
    assert_public_mail_host,
    assert_public_user_account,
)


def _fake_addr(ip: str, port: int = 993):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    sockaddr = (ip, port, 0, 0) if family == socket.AF_INET6 else (ip, port)
    return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)]


def test_rejects_private_and_loopback_literals():
    for host in ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "fe80::1"]:
        with pytest.raises(UnsafeMailTargetError):
            assert_public_mail_host(host, 993)


def test_rejects_local_names():
    for host in ["localhost", "mail.local", "x.localhost"]:
        with pytest.raises(UnsafeMailTargetError):
            assert_public_mail_host(host, 993)


def test_accepts_public_ip_literal():
    assert_public_mail_host("8.8.8.8", 993)
    assert_public_mail_host("2606:4700:4700::1111", 993)


def test_dns_result_must_be_entirely_public(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: _fake_addr("10.1.2.3"))
    with pytest.raises(UnsafeMailTargetError):
        assert_public_mail_host("imap.example.net", 993)


def test_dns_mixed_public_private_is_rejected(monkeypatch):
    def mixed(*args, **kwargs):
        return _fake_addr("8.8.8.8") + _fake_addr("127.0.0.1")
    monkeypatch.setattr(socket, "getaddrinfo", mixed)
    with pytest.raises(UnsafeMailTargetError):
        assert_public_mail_host("imap.example.net", 993)


def test_dns_public_result_is_allowed(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: _fake_addr("8.8.8.8"))
    assert_public_mail_host("imap.example.net", 993)


def test_auto_account_validates_pop3_target_too(monkeypatch):
    calls = []

    def resolver(host, port, **kwargs):
        calls.append((host, port))
        if host == "pop.example.net":
            return _fake_addr("10.0.0.8", port)
        return _fake_addr("8.8.8.8", port)

    monkeypatch.setattr(socket, "getaddrinfo", resolver)
    account = AccountConfig(
        id="u1",
        source="imap_custom",
        host="imap.example.net",
        port=993,
        username="u@example.net",
        password="secret",
        protocol="auto",
        pop3_host="pop.example.net",
        pop3_port=995,
    )
    with pytest.raises(UnsafeMailTargetError):
        assert_public_user_account(account)
    assert calls == [("imap.example.net", 993), ("pop.example.net", 995)]


def test_reserved_test_domains_do_not_require_dns():
    # IANA-reserved test names are non-routable and used throughout the suite.
    assert_public_mail_host("mail.example.test", 993)
    assert_public_mail_host("imap.example.com", 993)
