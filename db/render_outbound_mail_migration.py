#!/usr/bin/env python3
"""Render a shape-aware D1 migration for user_mail_accounts.can_send.

Deployment first queries ``PRAGMA table_info(user_mail_accounts)`` remotely, then
this script outputs the ALTER only when the column is absent. If the table does
not exist yet (fresh, uninitialized installation), the output is empty, because
fresh initialization creates the full schema including the column.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import sys as _sys

_sys.path.insert(0, str(Path(__file__).resolve().parent))
from wrangler_json import load_first_json_document  # noqa: E402

TARGET_TABLE = "user_mail_accounts"
TARGET_COLUMN = "can_send"


def _result_sets(value: Any):
    """Yield D1/Wrangler ``results`` arrays while rejecting reported failures."""
    if isinstance(value, dict):
        if value.get("success") is False:
            raise ValueError("remote D1 schema query reported failure")
        results = value.get("results")
        if isinstance(results, list):
            yield results
        for key in ("result", "data"):
            if key in value:
                yield from _result_sets(value[key])
    elif isinstance(value, list):
        for item in value:
            yield from _result_sets(item)


def parse_remote_columns(payload: Any) -> set[str]:
    """Extract PRAGMA table_info column names from Wrangler JSON output."""
    candidates = list(_result_sets(payload))
    if not candidates:
        raise ValueError("remote D1 schema query returned no results payload")

    for rows in candidates:
        if not rows:
            return set()
        if all(isinstance(row, dict) and "name" in row for row in rows):
            return {str(row["name"]) for row in rows}
    raise ValueError("remote D1 schema query did not return PRAGMA table_info rows")


def render_migration(
    migration_sql: str,
    existing_columns: set[str],
    target_column: str = TARGET_COLUMN,
    target_table: str = TARGET_TABLE,
) -> str:
    """If *target_column* is missing but the table exists, output the ALTER.

    An empty *existing_columns* means the table was not created yet (fresh
    install); the output is empty so fresh initialization creates the full
    schema. When the column is already present, the output is empty (idempotent
    no-op).
    """
    if not existing_columns:
        return ""
    if target_column in existing_columns:
        return ""

    # The migration file is just the ALTER. Output it verbatim.
    trimmed = migration_sql.strip()
    return trimmed + "\n" if trimmed else ""


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