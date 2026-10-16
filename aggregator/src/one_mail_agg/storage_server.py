"""Small authenticated local object store for unified mail attachments."""

from __future__ import annotations

import argparse
import hmac
import os
import re
import stat
import tempfile
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024
STORAGE_KEY_RE = re.compile(r"^/unified/[A-Za-z0-9_-]{43}$")
MAX_ACTIVE_REQUESTS = 64


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """Bound public proxy concurrency so unauthenticated requests cannot fan out unbounded threads."""

    daemon_threads = True
    block_on_close = False

    def __init__(self, server_address, handler_class):
        self._request_slots = threading.BoundedSemaphore(MAX_ACTIVE_REQUESTS)
        super().__init__(server_address, handler_class)

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(60)
        return request, address

    def process_request(self, request, client_address):
        if not self._request_slots.acquire(blocking=False):
            try:
                request.sendall(
                    b"HTTP/1.1 503 Service Unavailable\r\n"
                    b"Connection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n"
                )
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()


class StorageHandler(BaseHTTPRequestHandler):
    server_version = "one-mail-attachment-storage/1"

    def log_message(self, fmt: str, *args: object) -> None:
        # Never include authorization headers, paths containing message data, or bodies.
        if self.path == "/health":
            super().log_message("storage health request")

    @property
    def storage_root(self) -> Path:
        return self.server.storage_root  # type: ignore[attr-defined]

    @property
    def storage_token(self) -> bytes:
        return self.server.storage_token  # type: ignore[attr-defined]

    def _authorized(self) -> bool:
        value = self.headers.get("Authorization", "")
        expected = b"Bearer " + self.storage_token
        return hmac.compare_digest(value.encode("utf-8", "replace"), expected)

    def _send_error(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _path(self) -> Path | None:
        if not STORAGE_KEY_RE.fullmatch(self.path):
            return None
        key = self.path.removeprefix("/unified/")
        root = self.storage_root / "unified"
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        candidate = root / key
        if candidate.parent != root:
            return None
        return candidate

    def do_GET(self) -> None:
        if self.path == "/health":
            if not self._authorized():
                self._send_error(HTTPStatus.UNAUTHORIZED)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "11")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return
        if not self._authorized():
            self._send_error(HTTPStatus.UNAUTHORIZED)
            return
        path = self._path()
        if path is None:
            self._send_error(HTTPStatus.BAD_REQUEST)
            return
        try:
            with path.open("rb") as stream:
                # Stat the opened descriptor. A concurrent idempotent replace
                # cannot make Content-Length describe a different inode than
                # the bytes being streamed.
                file_stat = os.fstat(stream.fileno())
                if not stat.S_ISREG(file_stat.st_mode):
                    raise FileNotFoundError
                if file_stat.st_size > MAX_ATTACHMENT_BYTES:
                    raise FileNotFoundError
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(file_stat.st_size))
                self.send_header("Cache-Control", "private, no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                while chunk := stream.read(1024 * 1024):
                    self.wfile.write(chunk)
        except (FileNotFoundError, NotADirectoryError):
            self._send_error(HTTPStatus.NOT_FOUND)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return

    def do_PUT(self) -> None:
        if not self._authorized():
            self._send_error(HTTPStatus.UNAUTHORIZED)
            return
        path = self._path()
        if path is None:
            self._send_error(HTTPStatus.BAD_REQUEST)
            return
        try:
            size = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            size = -1
        if size < 0 or size > MAX_ATTACHMENT_BYTES:
            self._send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".upload-", dir=path.parent)
        try:
            remaining = size
            with os.fdopen(fd, "wb") as stream:
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        self._send_error(HTTPStatus.BAD_REQUEST)
                        return
                    stream.write(chunk)
                    remaining -= len(chunk)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def do_DELETE(self) -> None:
        if not self._authorized():
            self._send_error(HTTPStatus.UNAUTHORIZED)
            return
        path = self._path()
        if path is None:
            self._send_error(HTTPStatus.BAD_REQUEST)
            return
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Content-Length", "0")
        self.end_headers()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=39001)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    token = Path(args.token_file).read_bytes().strip()
    if len(token) < 32 or any(byte < 0x21 or byte > 0x7E for byte in token):
        raise SystemExit("attachment storage token must be at least 32 printable ASCII bytes")
    server = BoundedThreadingHTTPServer((args.host, args.port), StorageHandler)
    server.storage_root = root  # type: ignore[attr-defined]
    server.storage_token = token  # type: ignore[attr-defined]
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
