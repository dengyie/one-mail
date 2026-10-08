import importlib.util
from pathlib import Path
import sqlite3

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    'render_outbound_mail_migration', ROOT / 'db/render_outbound_mail_migration.py'
)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
MIGRATIONS = [
    ROOT / 'db/2026-10-05-user-mail-accounts-can-send.sql',
    ROOT / 'db/2026-10-08-user-mail-accounts-smtp-proxy.sql',
]


def migrate(db: sqlite3.Connection) -> None:
    for path in MIGRATIONS:
        columns = {row[1] for row in db.execute('PRAGMA table_info(user_mail_accounts)')}
        db.executescript(module.render_migration(path.read_text(encoding='utf-8'), columns))


@pytest.mark.parametrize('partial', [False, True])
def test_existing_can_send_does_not_skip_missing_export_columns(partial: bool) -> None:
    with sqlite3.connect(':memory:') as db:
        db.execute('CREATE TABLE user_mail_accounts (id TEXT PRIMARY KEY, cred_enc TEXT, can_send INTEGER DEFAULT 0)')
        db.execute("INSERT INTO user_mail_accounts VALUES ('account', 'encrypted', 1)")
        if partial:
            db.execute('ALTER TABLE user_mail_accounts ADD COLUMN smtp_host TEXT')
            db.execute("UPDATE user_mail_accounts SET smtp_host = 'smtp.example.com'")
        migrate(db)
        row = db.execute('SELECT id, cred_enc, can_send, smtp_host, smtp_port, smtp_ssl, proxy_policy FROM user_mail_accounts').fetchone()
        assert row == ('account', 'encrypted', 1, 'smtp.example.com' if partial else None, None, 1, 'auto')
        before = '\n'.join(db.iterdump())
        migrate(db)
        assert '\n'.join(db.iterdump()) == before


def test_can_send_and_fresh_install_contracts_remain_valid() -> None:
    with sqlite3.connect(':memory:') as db:
        for path in MIGRATIONS:
            assert module.render_migration(path.read_text(encoding='utf-8'), set()) == ''
        db.execute('CREATE TABLE user_mail_accounts (id TEXT PRIMARY KEY)')
        db.execute("INSERT INTO user_mail_accounts VALUES ('account')")
        migrate(db)
        assert db.execute('SELECT can_send, smtp_ssl, proxy_policy FROM user_mail_accounts').fetchone() == (0, 1, 'auto')


def test_malformed_migration_and_failed_schema_query_fail_closed() -> None:
    with pytest.raises(ValueError):
        module.render_migration('DROP TABLE user_mail_accounts;', {'id'})
    with pytest.raises(ValueError):
        module.parse_remote_columns([{'success': False, 'results': []}])
