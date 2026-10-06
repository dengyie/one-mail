"""Real SMTP loopback send test for the external-account outbound path.

Unlike the unit tests (which fake smtplib), this spins up a minimal server-
side SMTP sink on 127.0.0.1 and pushes a message through the *real* socket
path: AccountConfig -> connect_smtp -> smtplib.login -> send_message ->
delivered MIME, and then the full claim -> execute -> report loop against a
loopback stub Worker endpoint. No external network, no Mailpit container, no
TLS (the documented plain-loopback test exemption only).

The sink and stub are implemented with the stdlib only (socketserver /
http.server), so this test adds no third-party dependency.
"""
import base64
import http.server
import json
import socketserver
import threading

import pytest

import one_mail_agg.outbound_jobs as outbound
from one_mail_agg.config import AccountConfig, Config
from one_mail_agg.smtp_sender import send_smtp_message


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


class _SmtpSinkHandler(socketserver.StreamRequestHandler):
    """Minimal SMTP server: EHLO/HELO, AUTH LOGIN, MAIL/RCPT/DATA, QUIT.

    Advertises no STARTTLS (matching the plain-loopback test exemption) and
    only AUTH LOGIN, so smtplib drives its standard challenge/response login.
    Delivered messages land in ``self.server.delivered`` as bytes.
    """

    def _reply(self, line: str) -> None:
        self.wfile.write(line.encode("ascii") + b"\r\n")
        self.wfile.flush()

    def handle(self) -> None:
        self._reply("220 one-mail-loopback-sink")
        state = "cmd"  # cmd | auth_user | auth_pass | data
        message = bytearray()
        while True:
            raw = self.rfile.readline()
            if not raw:
                break
            line = raw.decode("ascii", errors="replace")
            line = line.rstrip("\r\n")

            if state == "data":
                if line == ".":
                    self.server.delivered.append(bytes(message))
                    message = bytearray()
                    state = "cmd"
                    self._reply("250 ok: queued")
                else:
                    message += raw
                continue

            if state == "auth_user":
                # Client replies with base64(username).
                try:
                    decoded = base64.b64decode(line, validate=True).decode("utf-8")
                except (ValueError, UnicodeDecodeError):
                    self._reply("501 bad base64")
                    state = "cmd"
                    continue
                if decoded != self.server.expect_user:
                    self._reply("535 auth failed")
                    state = "cmd"
                    continue
                state = "auth_pass"
                self._reply("334 " + _b64(b"Password:"))
                continue

            if state == "auth_pass":
                # Client replies with base64(password).
                try:
                    decoded = base64.b64decode(line, validate=True).decode("utf-8")
                except (ValueError, UnicodeDecodeError):
                    self._reply("535 bad base64")
                    state = "cmd"
                    continue
                if decoded != self.server.expect_pass:
                    self._reply("535 auth failed")
                else:
                    self._reply("235 Authentication successful")
                state = "cmd"
                continue

            command = line.upper()
            if command.startswith("AUTH LOGIN"):
                # smtplib may send an initial-response username inline
                # (AUTH LOGIN <b64-user>) per RFC 4954.
                parts = line.split()
                initial = parts[2] if len(parts) >= 3 else None
                if initial is not None:
                    try:
                        decoded = base64.b64decode(initial, validate=True).decode("utf-8")
                    except (ValueError, UnicodeDecodeError):
                        self._reply("501 bad base64")
                        continue
                    if decoded != self.server.expect_user:
                        self._reply("535 auth failed")
                        continue
                    state = "auth_pass"
                    self._reply("334 " + _b64(b"Password:"))
                else:
                    state = "auth_user"
                    self._reply("334 " + _b64(b"Username:"))
            elif command.startswith("EHLO") or command.startswith("HELO"):
                # 250-multi lines, last line terminated with a space.
                self._reply("250-one-mail-loopback-sink")
                self._reply("250-AUTH LOGIN")
                self._reply("250 8BITMIME")
            elif command.startswith("MAIL FROM"):
                self._reply("250 ok")
            elif command.startswith("RCPT TO"):
                self._reply("250 ok")
            elif command == "DATA":
                state = "data"
                self._reply("354 go ahead")
            elif command == "QUIT":
                self._reply("221 bye")
                break
            elif command == "NOOP" or command == "RSET":
                self._reply("250 ok")
            else:
                self._reply("500 unknown")


class _SmtpSink:
    def __init__(self, expect_user: str, expect_pass: str):
        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _SmtpSinkHandler)
        self.server.daemon_threads = True
        self.server.delivered = []
        self.server.expect_user = expect_user
        self.server.expect_pass = expect_pass
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def port(self) -> int:
        return self.server.server_address[1]

    @property
    def delivered(self) -> list[bytes]:
        return list(self.server.delivered)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self._thread.join(timeout=3)


@pytest.fixture
def smtp_sink():
    sink = _SmtpSink("you@example.com", "app-password")
    try:
        yield sink
    finally:
        sink.close()


def _outbound_account(smtp_port: int) -> AccountConfig:
    return AccountConfig(
        id="acc-1",
        source="imap_custom",
        host="imap.example.com",
        port=993,
        username="you@example.com",
        password="app-password",
        use_ssl=True,
        smtp_host="127.0.0.1",
        smtp_port=smtp_port,
        can_send=True,
    )


def test_real_send_reaches_loopback_sink(smtp_sink):
    account = _outbound_account(smtp_sink.port)
    payload = {
        "from_addr": "you@example.com",
        "from_name": "Sender",
        "to_addr": "to@example.com",
        "to_name": "Recipient",
        "subject": "Loopback send",
        "body_text": "hello from the real loopback",
        "body_html": "",
    }
    result = send_smtp_message(account, payload)
    # smtplib send_message does not surface a provider message id; the send
    # path returns None on a clean delivery.
    assert result is None
    assert len(smtp_sink.delivered) == 1
    raw = smtp_sink.delivered[0]
    assert b"Loopback send" in raw
    assert b"hello from the real loopback" in raw
    assert b"From: Sender <you@example.com>" in raw
    assert b"To: Recipient <to@example.com>" in raw


# --------------------------------------------------------------------------- full claim loop

class _StubWorkerHandler(http.server.BaseHTTPRequestHandler):
    job = None
    reports = []

    def _send_json(self, code: int, payload) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_POST(self):
        path = self.path
        if path == "/admin/unified/outbound/claim":
            body = self._read_json()
            self.__class__.job["lease_token"] = body.get("lease_token")
            self._send_json(200, {"jobs": [self.__class__.job]})
            return
        if path.startswith("/admin/unified/outbound/") and path.endswith("/result"):
            self.__class__.reports.append(self._read_json())
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {"error": "not found"})

    def log_message(self, *args):
        pass


class _StubWorker:
    def __init__(self, job: dict):
        _StubWorkerHandler.job = job
        _StubWorkerHandler.reports = []
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _StubWorkerHandler)
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    @property
    def reports(self) -> list[dict]:
        return list(_StubWorkerHandler.reports)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self._thread.join(timeout=3)


def test_full_outbound_loop_claim_send_report(smtp_sink):
    job = {
        "id": "job-1",
        "account_id": "acc-1",
        "from_addr": "you@example.com",
        "to_addr": "to@example.com",
        "subject": "Loopback send",
        "body_text": "hello from the real loopback",
        "body_html": "",
        "attempts": 1,
    }
    worker = _StubWorker(job)
    try:
        config = _config_for(worker.base_url, [_outbound_account(smtp_sink.port)])
        result = outbound.process_outbound_jobs(config, limit=5)

        assert result == {
            "claimed": 1,
            "succeeded": 1,
            "failed": 0,
            "retried": 0,
            "unsupported": 0,
        }
        assert len(smtp_sink.delivered) == 1
        assert b"Loopback send" in smtp_sink.delivered[0]
        assert len(worker.reports) == 1
        report = worker.reports[0]
        assert report["lease_token"] == job["lease_token"]
        assert report["status"] == "succeeded"
    finally:
        worker.close()


def test_full_outbound_loop_worker_shaped_payload_json(smtp_sink):
    """Regression: the Worker validates/stores the client payload which uses
    ``to_mail`` and ``content``/``is_html`` (not ``to_addr``/``body_text``). The
    aggregator must normalise those names from ``payload_json`` or the send would
    fail with "outbound job has no recipient address" (seen in production).
    """
    payload_json = json.dumps({
        "from_addr": "you@example.com",
        "from_name": "Sender",
        "to_mail": "to@example.com",
        "to_name": "Recipient",
        "subject": "Worker-shaped send",
        "content": "hello from the worker-shaped path",
        "is_html": False,
    })
    job = {
        "id": "job-3",
        "account_id": "acc-1",
        "from_addr": "you@example.com",
        "to_addr": "to@example.com",
        "subject": "Worker-shaped send",
        "body_text": None,
        "body_html": None,
        "payload_json": payload_json,
        "attempts": 1,
    }
    worker = _StubWorker(job)
    try:
        config = _config_for(worker.base_url, [_outbound_account(smtp_sink.port)])
        result = outbound.process_outbound_jobs(config, limit=5)

        assert result == {
            "claimed": 1,
            "succeeded": 1,
            "failed": 0,
            "retried": 0,
            "unsupported": 0,
        }
        assert len(smtp_sink.delivered) == 1
        raw = smtp_sink.delivered[0]
        assert b"Worker-shaped send" in raw
        assert b"hello from the worker-shaped path" in raw
        # The content comes from payload_json.content, not the empty body column.
        assert b"Recipient <to@example.com>" in raw
        assert worker.reports[0]["status"] == "succeeded"
    finally:
        worker.close()


def test_full_outbound_loop_rejects_spoofed_from_addr(smtp_sink):
    """Defense-in-depth: a spoofed From must fail and never reach the sink."""
    job = {
        "id": "job-2",
        "account_id": "acc-1",
        "from_addr": "attacker@example.com",
        "to_addr": "to@example.com",
        "subject": "spoof",
        "body_text": "should not send",
        "attempts": 1,
    }
    worker = _StubWorker(job)
    try:
        config = _config_for(worker.base_url, [_outbound_account(smtp_sink.port)])
        result = outbound.process_outbound_jobs(config, limit=5)

        assert result["failed"] == 1
        assert result["succeeded"] == 0
        assert smtp_sink.delivered == []
        assert worker.reports[0]["status"] == "failed"
        assert "does not match account" in worker.reports[0]["error"]
    finally:
        worker.close()


def _config_for(base_url: str, accounts) -> Config:
    return Config(
        worker_base_url=base_url,
        admin_token="admin-token",
        accounts=accounts,
        state_path="state.json",
    )