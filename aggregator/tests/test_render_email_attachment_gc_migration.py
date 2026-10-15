import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "db" / "render_email_attachment_gc_migration.py"
MIGRATION = ROOT / "db" / "2026-10-16-email-attachment-gc.sql"

spec = importlib.util.spec_from_file_location("render_email_attachment_gc_migration", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_render_installs_trigger_for_initialized_emails_schema():
    canonical = MIGRATION.read_text(encoding="utf-8")
    rendered = module.render_migration(canonical, {"id", "attachments_json"})
    assert "CREATE TRIGGER IF NOT EXISTS trg_emails_attachment_gc_after_delete" in rendered


def test_render_skips_uninitialized_database():
    assert module.render_migration("CREATE TRIGGER ...;", set()) == ""


def test_render_rejects_initialized_schema_missing_attachment_metadata():
    with pytest.raises(ValueError, match="attachments_json"):
        module.render_migration("CREATE TRIGGER ...;", {"id", "source"})
