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


def test_overseas_hosts_do_not_require_dns(monkeypatch):
    # Overseas hosts (e.g. mail.linux.do, imap.gmail.com) route via SOCKS5 proxy
    # and must not be rejected by local DNS poisoning.
    def poisoned_resolver(host, port, **kwargs):
        raise socket.gaierror("local DNS poisoned or unavailable")
    monkeypatch.setattr(socket, "getaddrinfo", poisoned_resolver)

    assert_public_mail_host("mail.linux.do", 993)
    assert_public_mail_host("imap.gmail.com", 993)


def test_ipv6_2001_routable_accepted_and_doc_rejected():
    # 2001::/23 routable addresses must be accepted
    assert_public_mail_host("2001::68f4:2eba:993", 993)

    # 2001:db8::/32 documentation addresses must be rejected
    with pytest.raises(UnsafeMailTargetError):
        assert_public_mail_host("2001:db8::1", 993)


def test_user_account_can_send_validates_smtp_target():
    account = AccountConfig(
        id="u2",
        source="imap_custom",
        host="8.8.8.8",
        port=993,
        username="u@example.net",
        password="secret",
        can_send=True,
        smtp_host="10.0.0.1",  # private IP -> must be rejected
        smtp_port=465,
    )
    with pytest.raises(UnsafeMailTargetError):
        assert_public_user_account(account)


def test_user_account_proxy_policy_always_bypasses_dns(monkeypatch):
    def poisoned_resolver(host, port, **kwargs):
        raise socket.gaierror("local DNS poisoned or unavailable")
    monkeypatch.setattr(socket, "getaddrinfo", poisoned_resolver)

    account = AccountConfig(
        id="u3",
        source="imap_custom",
        host="mail.custom-overseas.org",
        port=993,
        username="u@custom.org",
        password="secret",
        proxy_policy="always",
    )
    # Should not raise because proxy_policy="always" uses SOCKS5 remote domain addressing
    assert_public_user_account(account)
