import pytest

from one_mail_agg.config import AccountConfig
from one_mail_agg.proxy_client import create_imap_client


def _account(host: str) -> AccountConfig:
    return AccountConfig(
        id="a",
        source="imap_custom",
        host=host,
        port=993,
        username="u@example.com",
        password="p",
    )


def test_create_imap_client_uses_direct_transport_for_regular_host():
    calls = []

    class _Direct:
        def __init__(self, *args, **kwargs):
            calls.append(("direct", args, kwargs))

    class _Proxy:
        def __init__(self, *args, **kwargs):
            calls.append(("proxy", args, kwargs))

    client = create_imap_client(
        _account("imap.qq.com"),
        timeout=17,
        direct_client_cls=_Direct,
        proxied_client_cls=_Proxy,
    )
    assert isinstance(client, _Direct)
    assert calls == [("direct", ("imap.qq.com",), {"port": 993, "ssl": True, "timeout": 17})]


@pytest.mark.parametrize("host", ["IMAP.GMAIL.COM", "imap.mail.me.com"])
def test_create_imap_client_uses_socks_transport_for_overseas_host(host):
    calls = []

    class _Direct:
        def __init__(self, *args, **kwargs):
            calls.append(("direct", args, kwargs))

    class _Proxy:
        def __init__(self, *args, **kwargs):
            calls.append(("proxy", args, kwargs))

    client = create_imap_client(
        _account(host),
        timeout=30,
        direct_client_cls=_Direct,
        proxied_client_cls=_Proxy,
    )
    assert isinstance(client, _Proxy)
    assert calls == [("proxy", (host,), {"port": 993, "ssl": True, "timeout": 30})]
