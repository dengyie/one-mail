import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRESH_SCHEMA = ROOT / "db" / "schema.sql"


def test_account_cursor_query_uses_keyset_index():
    db = sqlite3.connect(":memory:")
    db.executescript(FRESH_SCHEMA.read_text(encoding="utf-8"))

    rows = [
        ("m3", 3000),
        ("m2", 2000),
        ("m1", 1000),
    ]
    for mail_id, received_at in rows:
        db.execute(
            """INSERT INTO emails
               (id, source, account_id, from_addr, to_addr, received_at)
               VALUES (?, 'imap_custom', 'acc-1', 'a@b', 'x@y', ?)""",
            (mail_id, received_at),
        )

    plan = " ".join(
        str(cell)
        for row in db.execute(
            """EXPLAIN QUERY PLAN
               SELECT id
                 FROM emails
                WHERE account_id = ?
                  AND (
                    COALESCE(internal_date, received_at) < ?
                    OR (
                      COALESCE(internal_date, received_at) = ?
                      AND id < ?
                    )
                  )
                ORDER BY COALESCE(internal_date, received_at) DESC, id DESC
                LIMIT ?""",
            ("acc-1", 3000, 3000, "m3", 21),
        )
        for cell in row
    )

    assert "idx_emails_account_order_cursor" in plan

    result = [
        row[0]
        for row in db.execute(
            """SELECT id
                 FROM emails
                WHERE account_id = ?
                  AND (
                    COALESCE(internal_date, received_at) < ?
                    OR (
                      COALESCE(internal_date, received_at) = ?
                      AND id < ?
                    )
                  )
                ORDER BY COALESCE(internal_date, received_at) DESC, id DESC
                LIMIT ?""",
            ("acc-1", 3000, 3000, "m3", 21),
        )
    ]
    assert result == ["m2", "m1"]
