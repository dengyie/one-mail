#!/usr/bin/env python3
"""Render the attachment cleanup trigger only for an initialized emails table."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys as _sys

_sys.path.insert(0, str(Path(__file__).resolve().parent))
from wrangler_json import load_first_json_document  # noqa: E402
from render_idempotent_d1_migration import parse_remote_columns  # noqa: E402


def render_migration(migration_sql: str, existing_columns: set[str]) -> str:
    if not existing_columns:
        return ""
    if "attachments_json" not in existing_columns:
        raise ValueError("emails table is missing attachments_json")
    return migration_sql.rstrip() + "\n"


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
