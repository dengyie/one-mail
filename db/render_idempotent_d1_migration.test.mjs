import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

test('deployment replays do not rewrite emails whose provider cannot be inferred', t => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec(readFileSync(new URL('schema.sql', import.meta.url), 'utf8'));
    db.exec(`INSERT INTO emails(id, source, from_addr, to_addr, received_at)
        VALUES ('opaque', 'external_import', 'sender@example.test', 'receiver@example.test', 1)`);
    const sql = readFileSync(new URL('2026-09-12-provider-message-identity.sql', import.meta.url), 'utf8');
    const columns = db.prepare('PRAGMA table_info(emails)').all().map(row => row.name);
    const rendered = spawnSync('python3', ['-c',
        'import json,sys\nimport render_idempotent_d1_migration as m\np=json.load(sys.stdin)\nprint(m.render_migration(p["sql"],set(p["columns"])),end="")'], {
        cwd: new URL('.', import.meta.url), input: JSON.stringify({ sql, columns }), encoding: 'utf8',
    });
    assert.equal(rendered.status, 0, rendered.stderr);
    const before = db.prepare('SELECT total_changes() AS n').get().n;
    db.exec(rendered.stdout);
    db.exec(rendered.stdout);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
    assert.equal(db.prepare("SELECT provider FROM emails WHERE id='opaque'").get().provider, null);
});
