import sqlite3
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "db" / "2026-09-12-provider-message-identity.sql"
FRESH_SCHEMA = ROOT / "db" / "schema.sql"


def _legacy_db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.executescript(
        """
        CREATE TABLE emails (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            account_id TEXT,
            from_addr TEXT NOT NULL,
            to_addr TEXT NOT NULL,
            subject TEXT,
            text_body TEXT,
            html_body TEXT,
            received_at INTEGER NOT NULL,
            internal_date INTEGER,
            headers_json TEXT,
            is_read INTEGER DEFAULT 0,
            is_starred INTEGER DEFAULT 0,
            flags_json TEXT,
            attachments_json TEXT,
            raw_ref TEXT,
            imap_uid TEXT,
            updated_at INTEGER
        );
        CREATE UNIQUE INDEX idx_emails_imap_uid
            ON emails(imap_uid) WHERE imap_uid IS NOT NULL;
        """
    )
    rows = [
        ("imap", "imap_qq", "acc-imap", "imap-key", "acc-imap:imap.qq.com:INBOX:7:1"),
        ("pop", "imap_163", "acc-pop", "pop-key", "pop3:acc-pop:pop.163.com:INBOX:UIDL-1"),
        ("graph", "graph_outlook", "acc-graph", "graph-key", "graph:acc-graph:INBOX:legacy-id"),
        ("native", "cf_routing", "native@example.com", "native-key", None),
    ]
    for row_id, source, account_id, to_addr, imap_uid in rows:
        db.execute(
            """INSERT INTO emails
               (id, source, account_id, from_addr, to_addr, received_at, imap_uid)
               VALUES (?, ?, ?, 'sender@example.com', ?, 1700000000000, ?)""",
            (row_id, source, account_id, to_addr, imap_uid),
        )
    return db


def _columns(db: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in db.execute(f"PRAGMA table_info({table})")}


def _indexes(db: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in db.execute(f"PRAGMA index_list({table})")}


def test_provider_identity_migration_backfills_only_provable_legacy_facts():
    db = _legacy_db()
    db.executescript(MIGRATION.read_text(encoding="utf-8"))

    assert {
        "provider", "source_folder", "source_folder_id", "provider_message_id",
        "provider_thread_id", "message_id_header", "in_reply_to", "references_json",
        "has_attachments", "source_key", "sync_version",
    } <= _columns(db, "emails")

    rows = {
        row[0]: row[1:]
        for row in db.execute(
            "SELECT id, provider, source_key, source_folder, provider_message_id, sync_version FROM emails"
        )
    }
    assert rows["imap"] == (
        "imap", "acc-imap:imap.qq.com:INBOX:7:1", None, None, None,
    )
    assert rows["pop"] == (
        "pop3", "pop3:acc-pop:pop.163.com:INBOX:UIDL-1", None, None, None,
    )
    assert rows["graph"] == (
        "graph", "graph:acc-graph:INBOX:legacy-id", None, None, None,
    )
    # Native routing has a provable canonical folder; no fabricated source_key.
    assert rows["native"] == ("native", None, "INBOX", None, 1)

    assert "idx_emails_source_key_uq" in _indexes(db, "emails")
    assert "idx_emails_provider_message_uq" in _indexes(db, "emails")
    assert _columns(db, "mail_account_folders") >= {
        "id", "mail_account_id", "provider", "provider_folder_id", "canonical_name",
        "folder_type", "uidvalidity", "last_cursor",
    }
    assert {
        "idx_mail_account_folders_provider_id_uq",
        "idx_mail_account_folders_canonical_uq",
    } <= _indexes(db, "mail_account_folders")


def test_migration_enforces_source_and_provider_identity_uniqueness_per_account():
    db = _legacy_db()
    db.executescript(MIGRATION.read_text(encoding="utf-8"))

    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """INSERT INTO emails
               (id, source, account_id, from_addr, to_addr, received_at, source_key)
               VALUES ('dup-source', 'imap_qq', 'other', 'a@b', 'x@y', 1, ?)""",
            ("acc-imap:imap.qq.com:INBOX:7:1",),
        )

    db.execute(
        "UPDATE emails SET provider_message_id = 'immutable-1' WHERE id = 'graph'"
    )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """INSERT INTO emails
               (id, source, account_id, from_addr, to_addr, received_at,
                provider, provider_message_id)
               VALUES ('dup-provider', 'graph_outlook', 'acc-graph', 'a@b', 'x@y', 1,
                       'graph', 'immutable-1')"""
        )

    # The same provider ID in a different mailbox is a different message scope.
    db.execute(
        """INSERT INTO emails
           (id, source, account_id, from_addr, to_addr, received_at,
            provider, provider_message_id)
           VALUES ('other-account', 'graph_outlook', 'acc-other', 'a@b', 'x@y', 1,
                   'graph', 'immutable-1')"""
    )


def test_provider_folder_id_survives_rename_and_duplicate_display_names():
    db = sqlite3.connect(":memory:")
    db.executescript(FRESH_SCHEMA.read_text(encoding="utf-8"))

    provider_upsert = """
        INSERT INTO mail_account_folders (
            mail_account_id, provider, provider_folder_id, canonical_name, display_name,
            folder_type, uidvalidity, last_sync_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mail_account_id, provider, provider_folder_id)
        WHERE provider_folder_id IS NOT NULL
        DO UPDATE SET
            canonical_name = excluded.canonical_name,
            display_name = excluded.display_name,
            folder_type = excluded.folder_type,
            uidvalidity = excluded.uidvalidity,
            last_sync_at = excluded.last_sync_at,
            last_error = NULL,
            updated_at = excluded.updated_at
    """
    db.execute(provider_upsert, (
        "acc", "graph", "folder-stable-1", "Old Name", "Old Name",
        "custom", None, 1, 1, 1,
    ))
    db.execute(provider_upsert, (
        "acc", "graph", "folder-stable-1", "Renamed", "Renamed",
        "custom", None, 2, 2, 2,
    ))
    rows = list(db.execute(
        "SELECT provider_folder_id, canonical_name, last_sync_at FROM mail_account_folders"
    ))
    assert rows == [("folder-stable-1", "Renamed", 2)]

    # Hierarchical provider folders may share the same human-readable name. A
    # distinct stable provider_folder_id must remain a distinct row.
    db.execute(provider_upsert, (
        "acc", "graph", "folder-stable-2", "Renamed", "Renamed",
        "custom", None, 3, 3, 3,
    ))
    assert db.execute("SELECT COUNT(*) FROM mail_account_folders").fetchone()[0] == 2


def test_imap_folder_without_provider_id_keys_by_canonical_mailbox_name():
    db = sqlite3.connect(":memory:")
    db.executescript(FRESH_SCHEMA.read_text(encoding="utf-8"))
    imap_upsert = """
        INSERT INTO mail_account_folders (
            mail_account_id, provider, provider_folder_id, canonical_name, display_name,
            folder_type, uidvalidity, last_sync_at, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mail_account_id, provider, canonical_name)
        WHERE provider_folder_id IS NULL
        DO UPDATE SET
            display_name = excluded.display_name,
            folder_type = excluded.folder_type,
            uidvalidity = excluded.uidvalidity,
            last_sync_at = excluded.last_sync_at,
            last_error = NULL,
            updated_at = excluded.updated_at
    """
    db.execute(imap_upsert, ("acc", "imap", "INBOX", "INBOX", "inbox", 7, 1, 1, 1))
    db.execute(imap_upsert, ("acc", "imap", "INBOX", "INBOX", "inbox", 8, 2, 2, 2))
    assert db.execute(
        "SELECT COUNT(*), MAX(uidvalidity) FROM mail_account_folders"
    ).fetchone() == (1, 8)


def test_fresh_schema_contains_identity_model_and_cursor_indexes():
    db = sqlite3.connect(":memory:")
    db.executescript(FRESH_SCHEMA.read_text(encoding="utf-8"))

    assert {
        "provider", "source_folder", "provider_message_id", "provider_thread_id",
        "message_id_header", "references_json", "source_key", "sync_version",
    } <= _columns(db, "emails")
    assert {
        "idx_emails_source_key_uq",
        "idx_emails_provider_message_uq",
        "idx_emails_account_order_cursor",
        "idx_emails_account_folder_order_cursor",
    } <= _indexes(db, "emails")
    assert _columns(db, "mail_account_folders") >= {
        "id", "mail_account_id", "provider", "provider_folder_id", "canonical_name", "folder_type",
    }

    db.execute(
        """INSERT INTO emails
           (id, source, account_id, from_addr, to_addr, received_at)
           VALUES ('q1', 'imap_qq', 'acc-1', 'a@b', 'x@y', 10)"""
    )
    plan = " ".join(
        str(cell)
        for row in db.execute(
            """EXPLAIN QUERY PLAN
               SELECT id FROM emails
               WHERE account_id = 'acc-1'
               ORDER BY COALESCE(internal_date, received_at) DESC, id DESC
               LIMIT 20"""
        )
        for cell in row
    )
    assert "idx_emails_account_order_cursor" in plan


def test_folder_type_constraint_rejects_unknown_semantics():
    db = sqlite3.connect(":memory:")
    db.executescript(FRESH_SCHEMA.read_text(encoding="utf-8"))
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """INSERT INTO mail_account_folders
               (mail_account_id, provider, canonical_name, folder_type, created_at, updated_at)
               VALUES ('a', 'imap', 'INBOX', 'not-a-folder-type', 1, 1)"""
        )
