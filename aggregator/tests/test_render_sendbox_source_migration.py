import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "db" / "render_sendbox_source_migration.py"
MIGRATION = ROOT / "db" / "2026-10-04-sendbox-source.sql"

spec = importlib.util.spec_from_file_location("render_sendbox_source_migration", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

TARGET_COLUMNS = {"source", "channel", "provider_message_id"}


def pragma_payload(columns):
    return [
        {
            "results": [
                {"cid": i, "name": name, "type": "TEXT", "notnull": 0, "pk": 0}
                for i, name in enumerate(columns)
            ],
            "success": True,
        }
    ]


def test_parse_remote_columns_accepts_wrangler_d1_json_shape():
    assert module.parse_remote_columns(pragma_payload(["id", "address", "raw"])) == {
        "id", "address", "raw"
    }


def test_render_adds_only_missing_sendbox_columns_and_keeps_indexes():
    canonical = MIGRATION.read_text(encoding="utf-8")
    rendered = module.render_migration(canonical, {"id", "address", "raw", "created_at", "source"})

    assert "ADD COLUMN source TEXT" not in rendered
    assert "ADD COLUMN channel TEXT" in rendered
    assert "ADD COLUMN provider_message_id TEXT" in rendered
    assert "CREATE INDEX IF NOT EXISTS idx_sendbox_source" in rendered
    assert "CREATE INDEX IF NOT EXISTS idx_sendbox_address_source" in rendered


def test_render_already_migrated_db_replays_only_indexes():
    canonical = MIGRATION.read_text(encoding="utf-8")
    rendered = module.render_migration(
        canonical,
        {"id", "address", "raw", "created_at", *TARGET_COLUMNS},
    )

    assert "ALTER TABLE sendbox ADD COLUMN" not in rendered
    assert "CREATE INDEX IF NOT EXISTS idx_sendbox_source" in rendered
    assert "CREATE INDEX IF NOT EXISTS idx_sendbox_address_source" in rendered


def test_render_uninitialized_db_is_empty_so_first_deploy_still_works():
    canonical = MIGRATION.read_text(encoding="utf-8")
    assert module.render_migration(canonical, set()) == ""


def test_parse_remote_columns_fails_closed_on_d1_error_or_wrong_payload():
    with pytest.raises(ValueError, match="reported failure"):
        module.parse_remote_columns([{"results": [], "success": False}])
    with pytest.raises(ValueError, match="no results payload"):
        module.parse_remote_columns({"unexpected": []})
