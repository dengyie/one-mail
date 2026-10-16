from __future__ import annotations

import http.client
import errno
import shutil
import threading
from pathlib import Path

import one_mail_agg.storage_server as storage_server
from one_mail_agg.storage_server import BoundedThreadingHTTPServer, MAX_ATTACHMENT_BYTES, StorageHandler


def running_storage(tmp_path: Path, token: str):
    server = BoundedThreadingHTTPServer(("127.0.0.1", 0), StorageHandler)
    server.storage_root = tmp_path  # type: ignore[attr-defined]
    server.storage_token = token.encode()  # type: ignore[attr-defined]
    server.min_free_bytes = 0  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def request(server, method, path, token=None, body=b""):
    conn = http.client.HTTPConnection(*server.server_address)
    headers = {"Content-Length": str(len(body))}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    conn.request(method, path, body=body, headers=headers)
    response = conn.getresponse()
    data = response.read()
    conn.close()
    return response.status, dict(response.headers), data


def test_storage_requires_bearer_and_rejects_invalid_paths(tmp_path):
    token = "t" * 32
    server, thread = running_storage(tmp_path, token)
    try:
        assert request(server, "PUT", "/unified/" + "a" * 43, body=b"x")[0] == 401
        assert request(server, "GET", "/unified/../secret", token=token)[0] == 400
        assert request(server, "GET", "/unified/" + "a" * 42, token=token)[0] == 400
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_storage_put_get_delete_is_atomic_and_idempotent(tmp_path):
    token = "t" * 32
    object_id = "b" * 43
    server, thread = running_storage(tmp_path, token)
    try:
        status, _, _ = request(server, "PUT", f"/unified/{object_id}", token=token, body=b"hello")
        assert status == 204
        status, headers, body = request(server, "GET", f"/unified/{object_id}", token=token)
        assert status == 200
        assert body == b"hello"
        assert headers["Content-Length"] == "5"
        assert request(server, "DELETE", f"/unified/{object_id}", token=token)[0] == 204
        assert request(server, "DELETE", f"/unified/{object_id}", token=token)[0] == 204
        assert request(server, "GET", f"/unified/{object_id}", token=token)[0] == 404
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_storage_rejects_oversized_content_before_writing(tmp_path):
    token = "t" * 32
    object_id = "c" * 43
    server, thread = running_storage(tmp_path, token)
    try:
        conn = http.client.HTTPConnection(*server.server_address)
        conn.request("PUT", f"/unified/{object_id}", body=b"", headers={"Authorization": f"Bearer {token}", "Content-Length": str(MAX_ATTACHMENT_BYTES + 1)})
        response = conn.getresponse()
        response.read()
        conn.close()
        assert response.status == 413
        assert not (tmp_path / "unified" / object_id).exists()
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_storage_does_not_reuse_connection_after_content_length_body(tmp_path):
    token = "t" * 32
    object_id = "d" * 43
    server, thread = running_storage(tmp_path, token)
    try:
        conn = http.client.HTTPConnection(*server.server_address)
        conn.putrequest("PUT", f"/unified/{object_id}")
        conn.putheader("Authorization", f"Bearer {token}")
        conn.putheader("Content-Length", "1")
        conn.endheaders()
        conn.send(b"ab")
        response = conn.getresponse()
        response.read()
        assert response.status == 204
        assert response.getheader("Connection") == "close"
        assert (tmp_path / "unified" / object_id).read_bytes() == b"a"
        assert conn.sock is None
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_storage_rejects_uploads_and_health_when_free_space_floor_is_reached(tmp_path):
    token = "t" * 32
    object_id = "e" * 43
    server, thread = running_storage(tmp_path, token)
    try:
        server.min_free_bytes = shutil.disk_usage(tmp_path).free + 1  # type: ignore[attr-defined]
        status, _, _ = request(server, "PUT", f"/unified/{object_id}", token=token, body=b"hello")
        assert status == 507
        status, _, body = request(server, "GET", "/health", token=token)
        assert status == 507
        assert body == b'{"ok":false}'
        assert not (tmp_path / "unified" / object_id).exists()
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_storage_maps_enospc_during_atomic_replace_to_507(tmp_path, monkeypatch):
    token = "t" * 32
    object_id = "f" * 43
    server, thread = running_storage(tmp_path, token)

    def fail_replace(_source, _target):
        raise OSError(errno.ENOSPC, "no space left on device")

    monkeypatch.setattr(storage_server.os, "replace", fail_replace)
    try:
        status, _, _ = request(server, "PUT", f"/unified/{object_id}", token=token, body=b"hello")
        assert status == 507
        assert not (tmp_path / "unified" / object_id).exists()
        assert not list((tmp_path / "unified").glob(".upload-*"))
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_storage_maps_enospc_during_upload_directory_creation_to_507(tmp_path, monkeypatch):
    token = "t" * 32
    object_id = "g" * 43
    server, thread = running_storage(tmp_path, token)
    original_mkdir = Path.mkdir

    def fail_unified_mkdir(self, *args, **kwargs):
        if self == tmp_path / "unified":
            raise OSError(errno.ENOSPC, "no space left on device")
        return original_mkdir(self, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", fail_unified_mkdir)
    try:
        status, _, _ = request(server, "PUT", f"/unified/{object_id}", token=token, body=b"hello")
        assert status == 507
        assert not (tmp_path / "unified" / object_id).exists()
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_storage_reservations_bound_concurrent_upload_capacity(tmp_path, monkeypatch):
    server = BoundedThreadingHTTPServer(("127.0.0.1", 0), StorageHandler)
    server.storage_root = tmp_path  # type: ignore[attr-defined]
    server.min_free_bytes = 10  # type: ignore[attr-defined]
    usage_type = type(shutil.disk_usage(tmp_path))
    monkeypatch.setattr(storage_server.shutil, "disk_usage", lambda _path: usage_type(100, 0, 100))
    try:
        assert server.reserve_upload(60) is True
        assert server.reserve_upload(31) is False
        assert server.storage_healthy() is True
        server.release_upload(60)
        assert server.storage_healthy() is True
    finally:
        server.server_close()
