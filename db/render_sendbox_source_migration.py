#!/usr/bin/env python3
"""Render a shape-aware D1 migration for sendbox source/channel columns.

Deployment first queries ``PRAGMA table_info(sendbox)`` remotely, then this
script keeps only ALTERs for columns that are actually missing and appends the
idempotent CREATE INDEX remainder of the canonical migration.

If the sendbox table does not exist yet (fresh, uninitialized installation),
the output is empty. Fresh initialization creates the current schema later;
deployment must not turn first install into a migration failure.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Any

import sys as _sys

_sys.path.insert(0, str(Path(__file__).resolve().parent))
from wrangler_json import load_first_json_document  # noqa: E402

ALTER_RE = re.compile(
    r"^\s*ALTER\s+TABLE\s+sendbox\s+ADD\s+COLUMN\s+"
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

    for rows in candidates:
        if not rows:
            return set()
        if all(isinstance(row, dict) and "name" in row for row in rows):
            return {str(row["name"]) for row in rows}
    raise ValueError("remote D1 schema query did not return PRAGMA table_info rows")


def render_migration(migration_sql: str, existing_columns: set[str]) -> str:
    alters = list(ALTER_RE.finditer(migration_sql))
    if not alters:
        raise ValueError("canonical migration contains no sendbox ADD COLUMN statements")

    if not existing_columns:
        return ""

    missing = []
    for match in alters:
        name = match.group("name")
        if name not in existing_columns:
            definition = match.group("definition").strip()
            missing.append(f"ALTER TABLE sendbox ADD COLUMN {name} {definition};")

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

    payload = load_first_json_document(args.schema_json.read_text(encoding="utf-8"))
    existing = parse_remote_columns(payload)
    canonical = args.migration.read_text(encoding="utf-8")
    args.output.write_text(render_migration(canonical, existing), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
