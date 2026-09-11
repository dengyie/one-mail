import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "db" / "render_idempotent_d1_migration.py"
MIGRATION = ROOT / "db" / "2026-09-12-provider-message-identity.sql"

spec = importlib.util.spec_from_file_location("render_d1_migration", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

TARGET_COLUMNS = {
    "provider",
    "source_folder",
    "source_folder_id",
    "provider_message_id",
    "provider_thread_id",
    "message_id_header",
    "in_reply_to",
    "references_json",
    "has_attachments",
    "source_key",
    "sync_version",
}


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
    assert module.parse_remote_columns(pragma_payload(["id", "source", "provider"])) == {
        "id", "source", "provider"
    }


def test_render_adds_only_missing_provider_columns_and_keeps_repair_tail():
    canonical = MIGRATION.read_text(encoding="utf-8")
    rendered = module.render_migration(canonical, {"id", "source", "provider", "source_folder"})

    assert "ADD COLUMN provider TEXT" not in rendered
    assert "ADD COLUMN source_folder TEXT" not in rendered
    for name in TARGET_COLUMNS - {"provider", "source_folder"}:
        assert f"ADD COLUMN {name} " in rendered

    assert "UPDATE emails" in rendered
    assert "CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_source_key_uq" in rendered
    assert "CREATE TABLE IF NOT EXISTS mail_account_folders" in rendered


def test_render_already_migrated_db_replays_only_idempotent_repair_tail():
    canonical = MIGRATION.read_text(encoding="utf-8")
    rendered = module.render_migration(canonical, {"id", "source", *TARGET_COLUMNS})

    assert "ALTER TABLE emails ADD COLUMN" not in rendered
    assert "UPDATE emails" in rendered
    assert "CREATE INDEX IF NOT EXISTS idx_emails_account_order_cursor" in rendered


def test_render_uninitialized_db_is_empty_so_first_deploy_still_works():
    canonical = MIGRATION.read_text(encoding="utf-8")
    assert module.render_migration(canonical, set()) == ""


def test_parse_remote_columns_fails_closed_on_d1_error_or_wrong_payload():
    with pytest.raises(ValueError, match="reported failure"):
        module.parse_remote_columns([{"results": [], "success": False}])
    with pytest.raises(ValueError, match="no results payload"):
        module.parse_remote_columns({"unexpected": []})
    with pytest.raises(ValueError, match="PRAGMA"):
        module.parse_remote_columns([{"results": [{"foo": "bar"}], "success": True}])
