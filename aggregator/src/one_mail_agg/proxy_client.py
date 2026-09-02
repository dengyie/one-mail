import socket
import ssl
import imaplib
from imapclient import IMAPClient

# 常见国内直连受阻的海外邮箱服务商（通过 pxed 本地 SOCKS5 1080 隧道出站）
OVERSEAS_IMAP_HOSTS = {
    "imap.gmail.com",
    "outlook.office365.com",
    "imap-mail.outlook.com",
    "imap.mail.yahoo.com",
}

DEFAULT_SOCKS5_PROXY = ("127.0.0.1", 1080)


def create_socks5_socket(
    proxy_host: str,
    proxy_port: int,
    target_host: str,
    target_port: int,
    timeout: float = 30.0,
) -> socket.socket:
    """创建经由 SOCKS5 代理建立的底层 TCP socket（支持域名端解析）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if timeout:
        s.settimeout(timeout)
    s.connect((proxy_host, proxy_port))

    # 1. 协商版本与认证方法：无密码
    s.sendall(b"\x05\x01\x00")
    resp = s.recv(2)
    if len(resp) < 2 or resp[0] != 5 or resp[1] != 0:
        s.close()
        raise ConnectionError(f"SOCKS5 proxy {proxy_host}:{proxy_port} handshake failed: {resp}")

    # 2. 发起 CONNECT 请求（使用域名 0x03 避免本地 DNS 污染）
    target_bytes = target_host.encode("utf-8")
    req = b"\x05\x01\x00\x03" + bytes([len(target_bytes)]) + target_bytes + target_port.to_bytes(2, "big")
    s.sendall(req)

    # 3. 读取代理回包
    resp = s.recv(10)
    if len(resp) < 4 or resp[1] != 0:
        s.close()
        rep_code = resp[1] if len(resp) > 1 else -1
        raise ConnectionError(f"SOCKS5 proxy connect to {target_host}:{target_port} failed with code {rep_code}")

    return s


class SOCKS5IMAP4_SSL(imaplib.IMAP4_SSL):
    """支持走 SOCKS5 代理的 IMAP4_SSL 客户端。"""

    proxy_host: str = "127.0.0.1"
    proxy_port: int = 1080

    def _create_socket(self, timeout=None):
        raw_sock = create_socks5_socket(
            self.proxy_host,
            self.proxy_port,
            self.host,
            self.port,
            timeout=30.0,
        )
        return self.ssl_context.wrap_socket(raw_sock, server_hostname=self.host)


class ProxiedIMAPClient(IMAPClient):
    """在需要海外代理出站时使用的 IMAPClient。"""

    def __init__(self, *args, proxy_host: str = "127.0.0.1", proxy_port: int = 1080, **kwargs):
        self.proxy_host = proxy_host
        self.proxy_port = proxy_port
        super().__init__(*args, **kwargs)

    def _create_IMAP4(self):
        class _CustomSOCKS5(SOCKS5IMAP4_SSL):
            proxy_host = self.proxy_host
            proxy_port = self.proxy_port

        return _CustomSOCKS5(self.host, self.port, ssl_context=self.ssl_context, timeout=self._timeout)
