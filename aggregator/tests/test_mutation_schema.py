import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "db" / "2026-09-12-mail-mutation-jobs.sql"
UPGRADE = ROOT / "db" / "2026-09-12-mail-mutation-move-delete.sql"


def _columns(conn, table):
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _indexes(conn, table):
    return {row[1] for row in conn.execute(f"PRAGMA index_list({table})")}


def test_mutation_migration_is_idempotent_and_indexed():
    conn = sqlite3.connect(":memory:")
    sql = MIGRATION.read_text(encoding="utf-8")

    conn.executescript(sql)
    conn.executescript(sql)

    assert _columns(conn, "mail_mutation_jobs") >= {
        "id", "email_id", "account_id", "source", "to_addr", "provider", "operation",
        "desired_value", "source_folder", "source_folder_id", "target_folder",
        "target_folder_id", "provider_message_id", "source_key", "message_id_header",
        "status", "attempts", "next_attempt_at", "lease_token", "lease_until",
        "last_error", "created_at", "updated_at", "completed_at",
    }
    indexes = _indexes(conn, "mail_mutation_jobs")
    assert "idx_mail_mutation_jobs_ready" in indexes
    assert "idx_mail_mutation_jobs_email_operation" in indexes
    assert "idx_mail_mutation_jobs_account" in indexes


def test_mutation_schema_accepts_move_delete_and_rejects_invalid_values():
    conn = sqlite3.connect(":memory:")
    conn.executescript(MIGRATION.read_text(encoding="utf-8"))
    base = (
        "INSERT INTO mail_mutation_jobs "
        "(id,email_id,account_id,provider,operation,desired_value,status,created_at,updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)"
    )

    conn.execute(base, ("move", "m1", "a1", "imap", "move", None, "pending", 1, 1))
    conn.execute(base, ("delete", "m2", "a1", "graph", "delete", None, "pending", 1, 1))

    for values in [
        ("bad-op", "m1", "a1", "imap", "rename", None, "pending", 1, 1),
        ("bad-value", "m1", "a1", "imap", "set_read", 2, "pending", 1, 1),
        ("bad-status", "m1", "a1", "imap", "set_read", 1, "done", 1, 1),
    ]:
        try:
            conn.execute(base, values)
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError(f"invalid mutation row accepted: {values}")


def test_legacy_upgrade_preserves_inflight_jobs_and_widens_operation_check():
    conn = sqlite3.connect(":memory:")
    conn.executescript("""
        CREATE TABLE mail_mutation_jobs (
            id TEXT PRIMARY KEY,
            email_id TEXT NOT NULL,
            account_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            operation TEXT NOT NULL CHECK (operation IN ('set_read', 'set_starred')),
            desired_value INTEGER NOT NULL CHECK (desired_value IN (0, 1)),
            source_folder TEXT,
            source_folder_id TEXT,
            provider_message_id TEXT,
            source_key TEXT,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (
                status IN ('pending', 'processing', 'succeeded', 'failed', 'unsupported', 'superseded')
            ),
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL DEFAULT 0,
            lease_token TEXT,
            lease_until INTEGER,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER
        );
    """)
    conn.execute(
        "INSERT INTO mail_mutation_jobs "
        "(id,email_id,account_id,provider,operation,desired_value,status,attempts,next_attempt_at,created_at,updated_at) "
        "VALUES ('j1','m1','a1','imap','set_read',1,'processing',2,123,10,11)"
    )

    conn.executescript(UPGRADE.read_text(encoding="utf-8"))

    row = conn.execute(
        "SELECT id,email_id,operation,desired_value,status,attempts,next_attempt_at,target_folder "
        "FROM mail_mutation_jobs WHERE id='j1'"
    ).fetchone()
    assert row == ("j1", "m1", "set_read", 1, "processing", 2, 123, None)
    assert "target_folder" in _columns(conn, "mail_mutation_jobs")
    conn.execute(
        "INSERT INTO mail_mutation_jobs "
        "(id,email_id,account_id,provider,operation,desired_value,status,created_at,updated_at) "
        "VALUES ('j2','m2','a1','imap','move',NULL,'pending',1,1)"
    )
