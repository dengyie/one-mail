#!/usr/bin/env python3
"""Render the destructive mutation-queue rebuild only for the legacy shape.

The original queue table allowed only read/star operations. New installations get
its current schema directly from 2026-09-12-mail-mutation-jobs.sql; existing
installations need one table rebuild to widen the operation CHECK and add move /
delete metadata. Deployment queries PRAGMA table_info(mail_mutation_jobs) first
and this script emits the canonical rebuild exactly once.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


BASE_COLUMNS = {
    "id",
    "email_id",
    "account_id",
    "provider",
    "operation",
    "desired_value",
    "source_folder",
    "source_folder_id",
    "provider_message_id",
    "source_key",
    "status",
    "attempts",
    "next_attempt_at",
    "lease_token",
    "lease_until",
    "last_error",
    "created_at",
    "updated_at",
    "completed_at",
}
UPGRADE_SENTINEL = "target_folder"


def _result_sets(value: Any):
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
    candidates = list(_result_sets(payload))
    if not candidates:
        raise ValueError("remote D1 schema query returned no results payload")
    for rows in candidates:
        if not rows:
            return set()
        if all(isinstance(row, dict) and "name" in row for row in rows):
            return {str(row["name"]) for row in rows}
    raise ValueError("remote D1 schema query did not return PRAGMA table_info rows")


def render_migration(migration_sql: str, existing_columns: set[str]) -> str:
    # Fresh/uninitialized DB: the preceding CREATE IF NOT EXISTS migration will
    # create the current shape, so there is no legacy table to rebuild here.
    if not existing_columns:
        return ""
    if UPGRADE_SENTINEL in existing_columns:
        return ""

    missing_baseline = BASE_COLUMNS - existing_columns
    if missing_baseline:
        names = ", ".join(sorted(missing_baseline))
        raise ValueError(f"legacy mutation table has unexpected shape; missing: {names}")

    rendered = migration_sql.strip()
    if not rendered:
        raise ValueError("canonical mutation upgrade migration is empty")
    return rendered + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema-json", required=True, type=Path)
    parser.add_argument("--migration", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    payload = json.loads(args.schema_json.read_text(encoding="utf-8"))
    existing = parse_remote_columns(payload)
    canonical = args.migration.read_text(encoding="utf-8")
    args.output.write_text(render_migration(canonical, existing), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())