import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { insertEmails, upsertFolders } from './ingest.ts';

const NOW = Date.parse('2026-10-08T04:00:00Z');

function fixture(t) {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../../../db/schema.sql', import.meta.url), 'utf8'));
    t.after(() => sqlite.close());
    const writes = [];
    const db = {
        prepare(sql) {
            let params = [];
            const run = () => {
                const result = sqlite.prepare(sql).run(...params);
                writes.push({ sql, changes: result.changes });
                return { success: true, meta: result };
            };
            return {
                bind(...values) { params = values; return this; },
                async first(column) { const row = sqlite.prepare(sql).get(...params); return (column ? row?.[column] : row) ?? null; },
                async all() { return { success: true, results: sqlite.prepare(sql).all(...params) }; },
                run,
            };
        },
        async batch(statements) {
            sqlite.exec('BEGIN');
            try {
                const result = statements.map(statement => statement.run());
                sqlite.exec('COMMIT');
                return result;
            } catch (cause) {
                sqlite.exec('ROLLBACK');
                throw cause;
            }
        },
    };
    t.mock.method(Date, 'now', () => NOW);
    return { c: { env: { DB: db } }, sqlite, writes };
}

const email = {
    id: 'message-1', source: 'graph_outlook', account_id: 'account-1',
    from_addr: 'sender@example.test', to_addr: 'receiver@example.test',
    provider: 'graph', provider_message_id: 'provider-message-1',
    source_key: 'graph:account-1:provider-message-1',
    source_folder: 'INBOX', source_folder_id: 'inbox-id',
    provider_thread_id: 'thread-1', sync_version: 1,
    received_at: NOW, updated_at: NOW, is_read: 1, is_starred: 1,
};

test('a new provider email is inserted once without an immediate metadata rewrite', async t => {
    const { c, writes } = fixture(t);
    assert.deepEqual(await insertEmails(c, [email]), { inserted: 1, skipped: 0 });
    assert.equal(writes.filter(row => /UPDATE emails SET/.test(row.sql)).length, 0);
});

test('identical provider replays change neither email nor folder rows', async t => {
    const { c, sqlite, writes } = fixture(t);
    await insertEmails(c, [email]);
    const sequence = sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name='mail_account_folders'").get().seq;
    writes.length = 0;
    t.mock.method(Date, 'now', () => NOW + 60_000);
    assert.deepEqual(await insertEmails(c, [email, email]), { inserted: 0, skipped: 2 });
    assert.equal(writes.reduce((sum, row) => sum + row.changes, 0), 0);
    assert.equal(sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name='mail_account_folders'").get().seq, sequence);
    assert.equal(sqlite.prepare('SELECT updated_at FROM emails').get().updated_at, NOW);
});

test('a provider replay applies a real move once while preserving user flags and content', async t => {
    const { c, sqlite, writes } = fixture(t);
    await insertEmails(c, [{ ...email, text_body: 'retained body' }]);
    t.mock.method(Date, 'now', () => NOW + 60_000);
    const moved = { ...email, source_folder: 'Archive', source_folder_id: 'archive-id', sync_version: 2 };
    writes.length = 0;
    await insertEmails(c, [moved, moved]);
    assert.equal(writes.filter(row => /UPDATE emails SET/.test(row.sql)).reduce((n, row) => n + row.changes, 0), 1);
    const row = sqlite.prepare('SELECT source_folder,source_folder_id,sync_version,is_read,is_starred,text_body,updated_at FROM emails').get();
    assert.deepEqual({ ...row }, {
        source_folder: 'Archive', source_folder_id: 'archive-id', sync_version: 2,
        is_read: 1, is_starred: 1, text_body: 'retained body', updated_at: NOW + 60_000,
    });
});

test('omitted provider metadata does not clear existing fields or rewrite the row', async t => {
    const { c, sqlite, writes } = fixture(t);
    await insertEmails(c, [{ ...email, has_attachments: 1 }]);
    writes.length = 0;
    const replay = { ...email, provider_thread_id: null, has_attachments: null, source_folder: null, source_folder_id: null, sync_version: null };
    t.mock.method(Date, 'now', () => NOW + 60_000);
    await insertEmails(c, [replay]);
    assert.equal(writes.reduce((sum, row) => sum + row.changes, 0), 0);
    assert.equal(sqlite.prepare('SELECT provider_thread_id,has_attachments FROM emails').get().has_attachments, 1);
});

for (const providerFolderId of [null, 'stable-folder']) {
    test(`folder metadata replays coalesce heartbeats but persist real changes (${providerFolderId})`, async t => {
        const { c, sqlite, writes } = fixture(t);
        const folder = { account_id: 'account-1', provider: providerFolderId ? 'graph' : 'imap',
            provider_folder_id: providerFolderId, canonical_name: 'INBOX', display_name: 'Inbox', folder_type: 'inbox', uidvalidity: 10 };
        await upsertFolders(c, [folder]);
        const sequence = sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name='mail_account_folders'").get().seq;
        writes.length = 0;
        t.mock.method(Date, 'now', () => NOW + 60_000);
        assert.equal(await upsertFolders(c, [folder]), 1, 'accepted catalogs include unchanged rows');
        assert.equal(writes.reduce((sum, row) => sum + row.changes, 0), 0);
        assert.equal(sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name='mail_account_folders'").get().seq, sequence);
        await upsertFolders(c, [{ ...folder, display_name: 'Renamed Inbox', uidvalidity: 11 }]);
        assert.equal(sqlite.prepare('SELECT display_name,uidvalidity FROM mail_account_folders').get().uidvalidity, 11);
        t.mock.method(Date, 'now', () => NOW + 360_000);
        await upsertFolders(c, [{ ...folder, display_name: 'Renamed Inbox', uidvalidity: 11 }]);
        assert.equal(sqlite.prepare('SELECT last_sync_at FROM mail_account_folders').get().last_sync_at, NOW + 360_000);
        sqlite.prepare("UPDATE mail_account_folders SET last_error='previous failure'").run();
        await upsertFolders(c, [{ ...folder, display_name: 'Renamed Inbox', folder_type: 'custom', uidvalidity: null }]);
        const row = sqlite.prepare('SELECT last_error,folder_type,uidvalidity FROM mail_account_folders').get();
        assert.equal(row.last_error, null);
        assert.equal(row.folder_type, 'inbox');
        assert.equal(row.uidvalidity, 11);
        assert.equal(sqlite.prepare('SELECT count(*) AS n FROM mail_account_folders').get().n, 1);
    });
}
