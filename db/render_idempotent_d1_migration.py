#!/usr/bin/env python3
"""Render a shape-aware D1 migration from the canonical one-time SQL file.

The provider-identity migration contains SQLite ``ALTER TABLE ... ADD COLUMN``
statements, which are intentionally not re-runnable. Deployment first queries
``PRAGMA table_info(emails)`` remotely, then this script keeps only ALTERs for
columns that are actually missing and appends the idempotent remainder of the
canonical migration.

If the emails table does not exist yet (fresh, uninitialized installation), the
output is empty. The normal admin database initializer will create the fresh
schema later; deployment must not turn first install into a migration failure.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

ALTER_RE = re.compile(
    r"^\s*ALTER\s+TABLE\s+emails\s+ADD\s+COLUMN\s+"
    r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s+(?P<definition>[^;]+);\s*$",
    re.IGNORECASE | re.MULTILINE,
)


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

    # PRAGMA table_info returns rows containing a `name` field. An empty result
    # set is valid and means the table does not exist yet.
    for rows in candidates:
        if not rows:
            return set()
        if all(isinstance(row, dict) and "name" in row for row in rows):
            return {str(row["name"]) for row in rows}
    raise ValueError("remote D1 schema query did not return PRAGMA table_info rows")


def render_migration(migration_sql: str, existing_columns: set[str]) -> str:
    alters = list(ALTER_RE.finditer(migration_sql))
    if not alters:
        raise ValueError("canonical migration contains no emails ADD COLUMN statements")

    # Empty PRAGMA table_info means a fresh DB with no emails table. ALTER would
    # be invalid; initialization later creates the current fresh schema.
    if not existing_columns:
        return ""

    missing = []
    for match in alters:
        name = match.group("name")
        if name not in existing_columns:
            definition = match.group("definition").strip()
            missing.append(f"ALTER TABLE emails ADD COLUMN {name} {definition};")

    # Remove every canonical ADD COLUMN from the body. The remaining UPDATEs,
    # CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS statements are
    # safe to replay and repair a migration that previously stopped mid-flight.
    body = ALTER_RE.sub("", migration_sql).lstrip()
    rendered = "\n".join(missing)
    if rendered:
        rendered += "\n\n"
    rendered += body
    return rendered.rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema-json", required=True, type=Path)
    parser.add_argument("--migration", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    payload = json.loads(args.schema_json.read_text(encoding="utf-8"))
    existing = parse_remote_columns(payload)
    canonical = args.migration.read_text(encoding="utf-8")
    rendered = render_migration(canonical, existing)
    args.output.write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
