#!/usr/bin/env python3
"""Render missing user_mail_accounts columns from canonical migration SQL.

Deployment first queries ``PRAGMA table_info(user_mail_accounts)`` remotely, then
this script outputs each ALTER only when its column is absent. If the table does
not exist yet (fresh, uninitialized installation), the output is empty, because
fresh initialization creates the full schema including the column.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import re

import sys as _sys

_sys.path.insert(0, str(Path(__file__).resolve().parent))
from wrangler_json import load_first_json_document  # noqa: E402
from render_idempotent_d1_migration import parse_remote_columns  # noqa: E402

ALTER_RE = re.compile(
    r"ALTER\s+TABLE\s+user_mail_accounts\s+ADD\s+COLUMN\s+"
    r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s+[^;]+;",
    re.IGNORECASE,
)


def render_migration(
    migration_sql: str,
    existing_columns: set[str],
) -> str:
    """Repair partially migrated tables without overwriting existing values."""
    body = re.sub(r"--[^\n]*", "", migration_sql)
    alters = list(ALTER_RE.finditer(body))
    if not alters or ALTER_RE.sub("", body).strip():
        raise ValueError("migration must contain only user_mail_accounts ADD COLUMN statements")
    if not existing_columns:
        return ""
    return "".join(
        match.group(0).strip() + "\n"
        for match in alters if match.group("name") not in existing_columns
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema-json", required=True, type=Path)
    parser.add_argument("--migration", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    payload = load_first_json_document(args.schema_json.read_text(encoding="utf-8"))
    existing = parse_remote_columns(payload)
    canonical = args.migration.read_text(encoding="utf-8")
    args.output.write_text(render_migration(canonical, existing), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
