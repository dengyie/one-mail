import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "db" / "2026-09-12-mail-mutation-jobs.sql"


def _columns(conn, table):
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def test_mutation_migration_is_idempotent_and_indexed():
    conn = sqlite3.connect(":memory:")
    sql = MIGRATION.read_text(encoding="utf-8")

    conn.executescript(sql)
    conn.executescript(sql)

    assert _columns(conn, "mail_mutation_jobs") >= {
        "id", "email_id", "account_id", "provider", "operation",
        "desired_value", "status", "attempts", "next_attempt_at",
        "lease_token", "lease_until", "last_error", "created_at",
        "updated_at", "completed_at",
    }
    indexes = {
        row[1]
        for row in conn.execute("PRAGMA index_list(mail_mutation_jobs)")
    }
    assert "idx_mail_mutation_jobs_ready" in indexes
    assert "idx_mail_mutation_jobs_email_operation" in indexes
    assert "idx_mail_mutation_jobs_account" in indexes


def test_mutation_schema_rejects_invalid_operation_status_and_desired_value():
    conn = sqlite3.connect(":memory:")
    conn.executescript(MIGRATION.read_text(encoding="utf-8"))
    base = (
        "INSERT INTO mail_mutation_jobs "
        "(id,email_id,account_id,provider,operation,desired_value,status,created_at,updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)"
    )

    for values in [
        ("bad-op", "m1", "a1", "imap", "delete", 1, "pending", 1, 1),
        ("bad-value", "m1", "a1", "imap", "set_read", 2, "pending", 1, 1),
        ("bad-status", "m1", "a1", "imap", "set_read", 1, "done", 1, 1),
    ]:
        try:
            conn.execute(base, values)
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError(f"invalid mutation row accepted: {values}")
