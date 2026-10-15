import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "db" / "render_raw_mail_unified_id_migration.py"
MIGRATION = ROOT / "db" / "2026-10-16-raw-mail-unified-id.sql"

spec = importlib.util.spec_from_file_location("render_raw_mail_unified_id_migration", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_render_adds_only_missing_raw_mail_identity_columns():
    canonical = MIGRATION.read_text(encoding="utf-8")
    rendered = module.render_migration(canonical, {"id", "source", "raw", "created_at"})

    assert "ALTER TABLE raw_mails ADD COLUMN unified_id TEXT" in rendered
    assert "CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_mails_unified_id_uq" in rendered
    assert "mirror_pending INTEGER NOT NULL DEFAULT 0" in rendered
    assert "unified_mirror_reconcile_state" not in rendered


def test_render_replays_idempotent_parts_when_column_already_exists():
    canonical = MIGRATION.read_text(encoding="utf-8")
    rendered = module.render_migration(canonical, {"id", "unified_id", "mirror_pending"})

    assert "ALTER TABLE raw_mails ADD COLUMN" not in rendered
    assert "CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_mails_unified_id_uq" in rendered
    assert "CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_mails_unified_id_uq" in rendered
    assert "unified_mirror_reconcile_state" not in rendered


def test_render_uninitialized_db_is_empty():
    canonical = MIGRATION.read_text(encoding="utf-8")
    assert module.render_migration(canonical, set()) == ""


def test_render_rejects_migration_for_a_different_table():
    with pytest.raises(ValueError, match="raw_mails ADD COLUMN"):
        module.render_migration("ALTER TABLE emails ADD COLUMN id TEXT;", {"id"})
