import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "db" / "render_mutation_move_delete_migration.py"
MIGRATION = ROOT / "db" / "2026-09-12-mail-mutation-move-delete.sql"

spec = importlib.util.spec_from_file_location("render_mutation_move_delete", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def pragma_payload(columns):
    return [{
        "results": [
            {"cid": i, "name": name, "type": "TEXT", "notnull": 0, "pk": 0}
            for i, name in enumerate(columns)
        ],
        "success": True,
    }]


def test_render_legacy_shape_emits_exactly_one_rebuild():
    canonical = MIGRATION.read_text(encoding="utf-8")
    rendered = module.render_migration(canonical, set(module.BASE_COLUMNS))

    assert "CREATE TABLE mail_mutation_jobs_v2" in rendered
    assert "INSERT INTO mail_mutation_jobs_v2" in rendered
    assert "DROP TABLE mail_mutation_jobs" in rendered
    assert "operation IN ('set_read', 'set_starred', 'move', 'delete')" in rendered


def test_render_current_shape_is_noop():
    canonical = MIGRATION.read_text(encoding="utf-8")
    current = {*module.BASE_COLUMNS, "target_folder", "target_folder_id", "source", "to_addr", "message_id_header"}
    assert module.render_migration(canonical, current) == ""


def test_render_uninitialized_shape_is_noop():
    canonical = MIGRATION.read_text(encoding="utf-8")
    assert module.render_migration(canonical, set()) == ""


def test_render_unexpected_legacy_shape_fails_closed():
    canonical = MIGRATION.read_text(encoding="utf-8")
    broken = set(module.BASE_COLUMNS) - {"source_key"}
    with pytest.raises(ValueError, match="unexpected shape"):
        module.render_migration(canonical, broken)


def test_parse_remote_columns_accepts_wrangler_shape_and_rejects_errors():
    assert module.parse_remote_columns(pragma_payload(["id", "target_folder"])) == {"id", "target_folder"}
    with pytest.raises(ValueError, match="reported failure"):
        module.parse_remote_columns([{"results": [], "success": False}])
    with pytest.raises(ValueError, match="PRAGMA"):
        module.parse_remote_columns([{"results": [{"oops": True}], "success": True}])