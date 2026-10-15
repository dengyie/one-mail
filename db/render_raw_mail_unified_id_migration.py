#!/usr/bin/env python3
"""Render the idempotent raw_mails unified identity migration for D1."""

from __future__ import annotations

import argparse
from pathlib import Path
import re

import sys as _sys

_sys.path.insert(0, str(Path(__file__).resolve().parent))
from wrangler_json import load_first_json_document  # noqa: E402
from render_idempotent_d1_migration import parse_remote_columns  # noqa: E402

ALTER_RE = re.compile(
    r"^\s*ALTER\s+TABLE\s+raw_mails\s+ADD\s+COLUMN\s+"
    r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s+(?P<definition>[^;]+);\s*$",
    re.IGNORECASE | re.MULTILINE,
)


def render_migration(migration_sql: str, existing_columns: set[str]) -> str:
    alters = list(ALTER_RE.finditer(migration_sql))
    if not alters:
        raise ValueError("canonical migration contains no raw_mails ADD COLUMN statements")
    if not existing_columns:
        return ""
    missing = [
        f"ALTER TABLE raw_mails ADD COLUMN {match.group('name')} {match.group('definition').strip()};"
        for match in alters if match.group("name") not in existing_columns
    ]
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
    columns = parse_remote_columns(payload)
    canonical = args.migration.read_text(encoding="utf-8")
    args.output.write_text(render_migration(canonical, columns), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
