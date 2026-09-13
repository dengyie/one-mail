from types import SimpleNamespace

import pytest

import one_mail_agg.folder_catalog as catalog
import one_mail_agg.sync as sync_mod
from one_mail_agg.config import AccountConfig, Config


def _imap_account():
    return AccountConfig(
        id="imap-1",
        source="imap_custom",
        host="imap.example.com",
        port=993,
        username="u@example.com",
        password="pw",
        folders=["INBOX"],
        protocol="imap",
    )


def _config():
    return Config(worker_base_url="https://worker.example", admin_token="admin", accounts=[])


def test_discover_imap_folders_includes_empty_selectable_and_skips_noselect():
    class _Client:
        def list_folders(self):
            return [
                ((b"\\HasNoChildren",), b"/", "INBOX"),
                ((b"\\Sent",), b"/", "Sent Items"),
                ((b"\\Noselect",), b"/", "Projects"),
                ((), b"/", "Archive/Empty"),
            ]

    rows = catalog.discover_imap_folders(_Client(), _imap_account())
    assert [row["canonical_name"] for row in rows] == ["INBOX", "Sent Items", "Archive/Empty"]
    assert rows[0]["folder_type"] == "inbox"
    assert rows[1]["folder_type"] == "sent"
    assert rows[2]["folder_type"] == "custom"
    assert all(row["provider"] == "imap" for row in rows)
    assert all(row["uidvalidity"] is None for row in rows)


def test_discover_imap_folder_special_use_types():
    class _Client:
        def list_folders(self):
            return [
                (("\\Drafts",), "/", "草稿"),
                (("\\Trash",), "/", "已删除"),
                (("\\Junk",), "/", "垃圾邮件"),
                (("\\Archive",), "/", "存档"),
            ]

    rows = catalog.discover_imap_folders(_Client(), _imap_account())
    assert [row["folder_type"] for row in rows] == ["drafts", "trash", "spam", "archive"]


def test_sync_imap_discovers_catalog_only_after_first_select_succeeds(monkeypatch):
    calls = []

    class _Client:
        def select_folder(self, folder, readonly=True):
            calls.append(("select", folder))
            return {b"UIDVALIDITY": 7}

    monkeypatch.setattr(sync_mod, "maybe_sync_imap_folder_catalog",
                        lambda client, config, account: calls.append(("catalog", account.id)) or 1)
    monkeypatch.setattr(sync_mod, "fetch_new_messages",
                        lambda client, account, folder, state, oversize=None: [])

    result = sync_mod.sync_imap(_Client(), _config(), _imap_account(), SimpleNamespace())
    assert result == {"synced": 0, "dropped": 0, "protocol": "imap"}
    assert calls == [("select", "INBOX"), ("catalog", "imap-1")]


def test_sync_imap_select_failure_does_not_register_catalog(monkeypatch):
    catalog_calls = []

    class _Client:
        def select_folder(self, folder, readonly=True):
            raise OSError("select failed")

    monkeypatch.setattr(sync_mod, "maybe_sync_imap_folder_catalog",
                        lambda *args, **kwargs: catalog_calls.append(True))

    with pytest.raises(OSError, match="select failed"):
        sync_mod.sync_imap(_Client(), _config(), _imap_account(), SimpleNamespace())
    assert catalog_calls == []


class _Resp:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


def test_discover_graph_folders_handles_pagination_and_nested_children(monkeypatch):
    calls = []

    def fake_get(url, headers=None, timeout=None):
        calls.append(url)
        if "/childFolders" in url:
            return _Resp({"value": [{
                "id": "child-1", "displayName": "Empty Child", "childFolderCount": 0,
            }]})
        if "page=2" in url:
            return _Resp({"value": [{
                "id": "root-2", "displayName": "Archive", "childFolderCount": 0,
            }]})
        return _Resp({
            "value": [{
                "id": "root-1", "displayName": "Projects", "childFolderCount": 1,
            }],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders?page=2",
        })

    monkeypatch.setattr(catalog.requests, "get", fake_get)
    account = SimpleNamespace(id="graph-1")
    rows = catalog.discover_graph_folders("AT", account)

    assert {(row["provider_folder_id"], row["canonical_name"]) for row in rows} == {
        ("root-1", "Projects"),
        ("root-2", "Archive"),
        ("child-1", "Empty Child"),
    }
    assert all(row["provider"] == "graph" for row in rows)
    assert any("childFolders" in url for url in calls)


def test_discover_graph_folders_rejects_untrusted_pagination_host(monkeypatch):
    monkeypatch.setattr(catalog.requests, "get", lambda *a, **k: _Resp({
        "value": [],
        "@odata.nextLink": "https://example.invalid/steal",
    }))
    with pytest.raises(RuntimeError, match="unexpected host"):
        catalog.discover_graph_folders("AT", SimpleNamespace(id="graph-1"))


def test_imap_catalog_sync_is_throttled_and_uploads(monkeypatch):
    catalog._last_attempt.clear()
    discovered = [{
        "account_id": "imap-1", "provider": "imap", "canonical_name": "INBOX",
    }]
    uploads = []
    monkeypatch.setattr(catalog, "discover_imap_folders", lambda client, account: discovered)
    monkeypatch.setattr(catalog, "upload_folders", lambda config, rows: uploads.append(rows) or {"folders_upserted": len(rows)})

    account = _imap_account()
    assert catalog.maybe_sync_imap_folder_catalog(object(), _config(), account, now=10) == 1
    assert catalog.maybe_sync_imap_folder_catalog(object(), _config(), account, now=100) == 0
    assert catalog.maybe_sync_imap_folder_catalog(object(), _config(), account, now=311) == 1
    assert uploads == [discovered, discovered]


def test_graph_catalog_failure_is_best_effort_and_throttled(monkeypatch):
    catalog._last_attempt.clear()
    attempts = []

    def fail(token, account):
        attempts.append(account.id)
        raise OSError("graph unavailable")

    monkeypatch.setattr(catalog, "discover_graph_folders", fail)
    account = SimpleNamespace(id="graph-1")
    assert catalog.maybe_sync_graph_folder_catalog("AT", _config(), account, now=1) == 0
    assert catalog.maybe_sync_graph_folder_catalog("AT", _config(), account, now=2) == 0
    assert attempts == ["graph-1"]
