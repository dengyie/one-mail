import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EMAIL_COLUMNS, FOLDER_COLUMNS, FileStore, configFromEnv, createTransport, digest, main, parseArgs, runMigration, verify } from './backfill_shard.mjs';

const config = { primaryAccount: 'accountA', primaryD1: 'primary-db', targetAccount: 'accountB', targetD1: 'target-db', shardBase: 'https://target.account-b.workers.dev', shardToken: 's'.repeat(32), primaryHeaders: { Authorization: 'Bearer primary-secret' }, targetHeaders: { Authorization: 'Bearer target-secret' }, primaryWorker: 'primary', targetWorker: 'target' };
const baseOptions = { command: 'copy', account: 'mailbox', shard: 'shard1', stateFile: '/fake/state.json', chunkSize: 2, delayMs: 1000, timeoutMs: 100, stableMs: 65000, dailyBudget: 80000, confirmCopy: 'mailbox', confirmDelete: 'mailbox', sourceQuiesced: true };
const email = (id, received = 10, extra = {}) => ({ ...Object.fromEntries(EMAIL_COLUMNS.map(k => [k, null])), id, account_id: 'mailbox', source: 'imap_qq', from_addr: 'sender@example', to_addr: 'inbox@example', received_at: received, is_read: 1, is_starred: 1, updated_at: 777, subject: `mail ${id}`, text_body: 'content', flags_json: '["\\\\Seen"]', headers_json: '{}', attachments_json: '[]', ...extra });

class MemoryStore {
    stateFile = 'state'; budgetFile = 'budget'; files = new Map(); held = false;
    async load(file) { return structuredClone(this.files.get(file) ?? null); }
    async save(file, data) { this.files.set(file, structuredClone(data)); }
    async lock() { assert.equal(this.held, false); this.held = true; return async () => { this.held = false; }; }
}
class FakeDB {
    constructor() {
        this.sqlite = new DatabaseSync(':memory:'); this.calls = []; this.deleteFactor = 3;
        this.sqlite.exec(`CREATE TABLE emails (${EMAIL_COLUMNS.map(k => `${k} ${['received_at','updated_at','internal_date','is_read','is_starred','has_attachments','sync_version'].includes(k) ? 'INTEGER' : 'TEXT'}${k === 'id' ? ' PRIMARY KEY' : ''}`).join(',')});
            CREATE INDEX account_idx ON emails(account_id);
            CREATE UNIQUE INDEX provider_idx ON emails(account_id,provider,provider_message_id) WHERE provider_message_id IS NOT NULL;
            CREATE UNIQUE INDEX source_key_idx ON emails(source_key) WHERE source_key IS NOT NULL;
            CREATE UNIQUE INDEX imap_idx ON emails(imap_uid) WHERE imap_uid IS NOT NULL;
            CREATE TABLE mail_account_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, ${FOLDER_COLUMNS.map(k => `${k} ${['uidvalidity','last_sync_at','created_at','updated_at'].includes(k) ? 'INTEGER' : 'TEXT'}`).join(',')});
            CREATE UNIQUE INDEX folder_name_idx ON mail_account_folders(mail_account_id,provider,canonical_name);
            CREATE UNIQUE INDEX folder_provider_idx ON mail_account_folders(mail_account_id,provider,provider_folder_id) WHERE provider_folder_id IS NOT NULL;
            CREATE TABLE mail_mutation_jobs (id TEXT PRIMARY KEY, email_id TEXT, account_id TEXT, status TEXT);`);
    }
    put(row) { this.sqlite.prepare(`INSERT INTO emails (${EMAIL_COLUMNS.join(',')}) VALUES (${EMAIL_COLUMNS.map(() => '?').join(',')})`).run(...EMAIL_COLUMNS.map(k => row[k] ?? null)); }
    folder(row) { this.sqlite.prepare(`INSERT INTO mail_account_folders (${FOLDER_COLUMNS.join(',')}) VALUES (${FOLDER_COLUMNS.map(() => '?').join(',')})`).run(...FOLDER_COLUMNS.map(k => row[k] ?? null)); }
    async query(sql, params = []) {
        assert.ok(params.length <= 100, 'D1 binding cap');
        this.calls.push({ sql, params });
        const statement = this.sqlite.prepare(sql);
        if (/^(SELECT|PRAGMA)/.test(sql)) return { success: true, results: statement.all(...params).map(r => ({ ...r })), meta: { rows_written: 0 } };
        const result = statement.run(...params);
        return { success: true, results: [], meta: { changes: result.changes, rows_written: result.changes * (sql.startsWith('DELETE') ? this.deleteFactor : 1) } };
    }
    all() { return this.sqlite.prepare('SELECT * FROM emails ORDER BY id').all().map(r => ({ ...r })); }
}
function harness(sourceRows = []) {
    const source = new FakeDB(), target = new FakeDB(), store = new MemoryStore(), waits = [], uploads = [];
    sourceRows.forEach(row => source.put(row));
    let fail = false, proofFails = false;
    const transport = {
        source, target,
        async health() { return { ok: true, shard_mode: true, shard_id: 'shard1' }; },
        async cutoverProof() { if (proofFails) throw new Error('KV mismatch'); },
        async ingest(body) {
            uploads.push(structuredClone(body));
            if (fail) throw new Error('upload failed');
            assert.equal(body.migration, true, 'Supplied IDs alone must never select archival mode');
            const archive = (table, columns, row) => {
                assert.deepEqual(Object.keys(row).sort(), [...columns].sort(), 'Exact archival projection');
                return target.sqlite.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(key => row[key])).changes;
            };
            const folders_upserted = body.folders.reduce((count, folder) => count + archive('mail_account_folders', FOLDER_COLUMNS, folder), 0);
            const inserted = body.emails.reduce((count, row) => count + archive('emails', EMAIL_COLUMNS, row), 0);
            return { inserted, skipped: body.emails.length - inserted, folders_upserted };
        },
    };
    const dependencies = { transport, store, wait: async ms => waits.push(ms), now: () => Date.UTC(2026, 9, 4) };
    const run = (command, extra = {}) => runMigration({ ...baseOptions, command, ...extra }, config, dependencies);
    return { source, target, store, waits, uploads, dependencies, transport, run, setFail: value => { fail = value; }, setProofFails: value => { proofFails = value; } };
}
async function prepared(rows) { const h = harness(rows); await h.run('copy'); await h.run('verify'); return h; }
const deletions = h => h.source.calls.filter(c => c.sql.startsWith('DELETE'));

test('composite received_at,id cursor preserves equal timestamps, zero/negative dates and every column', async () => {
    const originals = [email('a', -1), email('b', 0), email('c'), email('d'), email('e')];
    const h = harness(originals);
    h.source.put(email('native', 2, { source: 'cf_routing' }));
    await h.run('copy');
    assert.deepEqual(h.uploads.flatMap(b => b.emails.map(e => e.id)), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(h.target.all(), originals);
    assert.equal(h.store.files.get('state').pass.cursor.id, 'e');
    assert.equal((await h.run('verify')).sourceCount, 5);
    assert.equal(deletions(h).length, 0);
});

test('failed upload does not advance cursor; replay resumes without duplicate generated IDs', async () => {
    const h = harness([email('a'), email('b')]);
    h.setFail(true);
    await assert.rejects(h.run('copy'), /upload failed/);
    assert.equal(h.store.files.get('state').pass.cursor, null);
    assert.equal(h.store.held, false);
    h.setFail(false);
    await h.run('copy');
    assert.deepEqual(h.target.all(), [email('a'), email('b')]);
    assert.equal(h.uploads.length, 2);
});

test('ambiguous successful ingest is safely replayed and acknowledged chunks are skipped on resume', async () => {
    const h = harness([email('a'), email('b'), email('c')]);
    const ingest = h.transport.ingest;
    let attempts = 0;
    h.transport.ingest = async body => { const ack = await ingest(body); if (++attempts === 2) throw new Error('lost ack'); return ack; };
    await assert.rejects(h.run('copy'), /lost ack/);
    assert.equal(h.store.files.get('state').pass.cursor.id, 'b');
    await h.run('copy');
    assert.deepEqual(h.uploads.map(b => b.emails.map(e => e.id)), [['a', 'b'], ['c'], ['c']]);
    assert.equal(h.target.all().length, 3);
});

test('delta scans old received_at arrivals and rejects changed source state without overwriting target', async () => {
    const h = harness([email('newer', 100)]);
    await h.run('copy');
    h.source.put(email('late', 1));
    await h.run('delta');
    assert.deepEqual(h.target.all(), h.source.all());
    assert.equal((await h.run('verify')).sourceCount, 2);
    const baseline = h.target.all();
    h.source.sqlite.exec("UPDATE emails SET is_starred = 0, is_read = 0, updated_at = 888 WHERE id = 'newer'");
    await assert.rejects(h.run('delta'), /archival verification failed/);
    assert.deepEqual(h.target.all(), baseline);
    assert.equal(h.store.files.get('state').pass.done, false);
});

test('empty-copy initialization differs from missing/uninitialized checkpoint', async () => {
    const h = harness();
    await assert.rejects(h.run('delta'), /completed copy/);
    await h.run('verify');
    await assert.rejects(h.run('delete'), /completed copy/);
    await h.run('copy');
    assert.equal(h.store.files.get('state').initialized, true);
    assert.equal(h.uploads.length, 0);
    await h.run('delta');
    assert.equal((await h.run('verify')).sourceCount, 0);
});

test('folder catalog copied even without emails; generated timestamps and folder IDs do not affect digest', async () => {
    const h = harness();
    h.source.folder({ mail_account_id: 'mailbox', provider: 'imap', canonical_name: 'Archive', display_name: 'My Archive', folder_type: 'archive', uidvalidity: 123, last_cursor: 'abc', last_error: 'prior error', last_sync_at: 10, created_at: 10, updated_at: 20 });
    await h.run('copy');
    assert.equal(h.uploads[0].folders[0].mail_account_id, 'mailbox');
    assert.equal(Object.hasOwn(h.uploads[0].folders[0], 'id'), false);
    h.target.sqlite.exec('UPDATE mail_account_folders SET id = 999, created_at = 90, updated_at = 100, last_sync_at = 200');
    assert.equal((await h.run('verify')).folderCount, 1);
    h.target.sqlite.exec("UPDATE mail_account_folders SET last_cursor = 'wrong'");
    await assert.rejects(h.run('verify'), /folder catalog mismatch/);
});

test('archival email ingest never infers or updates the exact source folder catalog', async () => {
    const h = harness([email('a', 10, { provider: 'imap', provider_message_id: 'p-a', source_folder: 'Inbox' })]);
    h.source.folder({ mail_account_id: 'mailbox', provider: 'imap', canonical_name: 'Inbox', display_name: 'Custom Inbox', folder_type: 'inbox', uidvalidity: 10, last_error: 'historic warning', last_cursor: 'provider-cursor', created_at: 12, updated_at: 14 });
    await h.run('copy');
    assert.equal((await h.run('verify')).folderCount, 1);
    const targetFolder = h.target.sqlite.prepare('SELECT * FROM mail_account_folders').get();
    assert.equal(targetFolder.display_name, 'Custom Inbox');
    assert.equal(targetFolder.last_error, 'historic warning');
});

test('equal count with wrong IDs/content/starred/updated_at never permits delete', async () => {
    for (const sql of ["UPDATE emails SET id = 'wrong'", "UPDATE emails SET text_body = 'wrong'", 'UPDATE emails SET is_starred = 0', 'UPDATE emails SET updated_at = 999']) {
        const h = await prepared([email('a')]);
        h.target.sqlite.exec(sql);
        assert.deepEqual(await h.run('count'), { sourceCount: 1, targetCount: 1, informationalOnly: true });
        await assert.rejects(h.run('delete'), /Verification failed/);
        assert.equal(deletions(h).length, 0);
    }
});

test('live KV mismatch, unresolved jobs, and unstable source block deletion', async () => {
    const h = await prepared([email('a')]);
    h.setProofFails(true);
    await assert.rejects(h.run('delete'), /KV mismatch/);
    h.setProofFails(false);
    h.source.sqlite.exec("INSERT INTO mail_mutation_jobs VALUES ('j','a','mailbox','processing')");
    await assert.rejects(h.run('delete'), /Unresolved mutation/);
    h.source.sqlite.exec('DELETE FROM mail_mutation_jobs');
    h.dependencies.wait = async ms => { if (ms === 65000) { h.source.put(email('late', 1)); h.target.put(email('late', 1)); } };
    await assert.rejects(h.run('delete'), /Source is not stable/);
    assert.equal(deletions(h).length, 0);
});

test('actual index-inclusive rows_written persisted; throttle and budget constrain bounded deletes', async () => {
    const h = await prepared([email('a'), email('b'), email('c')]);
    h.source.put(email('native', 1, { source: 'cf_routing' }));
    h.waits.length = 0;
    // Six units reserved per row (table + five indexes), actual is three.
    await assert.rejects(h.run('delete', { dailyBudget: 8 }), /budget exhausted/);
    assert.equal(deletions(h).length, 1);
    assert.equal(deletions(h)[0].params.length, 1 + EMAIL_COLUMNS.length);
    assert.equal(h.store.files.get('budget').days['2026-10-04'], 3);
    assert.deepEqual(h.waits, [65000, 1000]);
    const result = await h.run('delete');
    assert.equal(result.deleted, 2);
    assert.equal(result.dailyRowsWritten, 9);
    assert.deepEqual(h.source.all().map(r => r.id), ['native']);
    assert.ok(deletions(h).every(call => call.sql.includes("source != 'cf_routing'") && call.params.length <= 100));
});

test('ambiguous delete retains reserved budget and verifies remaining rows on resume', async () => {
    const h = await prepared([email('a')]);
    const query = h.source.query.bind(h.source);
    h.source.query = async (sql, params) => { if (sql.startsWith('DELETE')) { await query(sql, params); throw new Error('lost delete response'); } return query(sql, params); };
    await assert.rejects(h.run('delete'), /lost delete response/);
    assert.equal(h.store.files.get('budget').days['2026-10-04'], 6);
    await assert.rejects(h.run('delete'), /Source changed/);
    await h.run('verify');
    assert.equal((await h.run('delete')).dailyRowsWritten, 6);
});

test('immediate guarded delete compares all columns and refuses changed rows', async () => {
    const h = await prepared([email('a')]);
    const query = h.source.query.bind(h.source);
    h.source.query = async (sql, params) => { if (sql.startsWith('DELETE')) h.source.sqlite.exec('UPDATE emails SET is_starred = 0'); return query(sql, params); };
    await assert.rejects(h.run('delete'), /Conditional delete/);
    assert.equal(h.source.all().length, 1);
});

test('provider identity with different target ID is never remapped, even without mutation references', async () => {
    const original = email('a', 1, { provider: 'imap', provider_message_id: 'provider-id' });
    for (const hasJob of [false, true]) {
        const h = harness([original]);
        const existing = { ...original, id: 'generated' };
        h.target.put(existing);
        if (hasJob) h.target.sqlite.exec("INSERT INTO mail_mutation_jobs VALUES ('job','generated','mailbox','succeeded')");
        await assert.rejects(h.run('copy'), /archival verification failed/);
        assert.deepEqual(h.target.all(), [existing]);
        assert.equal(h.store.files.get('state').pass.cursor, null);
        assert.equal(h.target.calls.some(call => /^(UPDATE|INSERT|DELETE)/.test(call.sql)), false);
    }
});

test('triggers and foreign-key dependents prevent deletion budget underestimation', async () => {
    for (const schema of ["CREATE TRIGGER expensive AFTER DELETE ON emails BEGIN INSERT INTO mail_mutation_jobs VALUES ('x','a','mailbox','pending'); END", 'CREATE TABLE dependent (email_id TEXT REFERENCES emails(id))']) {
        const h = await prepared([email('a')]);
        h.source.sqlite.exec(schema);
        await assert.rejects(h.run('delete'), /bounded delete budget/);
        assert.equal(deletions(h).length, 0);
    }
});

test('unsupported email columns fail closed instead of silently dropping data', async () => {
    const h = harness([email('a')]);
    h.source.sqlite.exec('ALTER TABLE emails ADD COLUMN future_column TEXT');
    await assert.rejects(h.run('copy'), /Unsupported source\/target schema/);
    assert.equal(h.uploads.length, 0);
});

test('missing/excess write metadata blocks ledger and records observed excess', async () => {
    for (const actual of [undefined, 9]) {
        const h = await prepared([email('a')]);
        const query = h.source.query.bind(h.source);
        h.source.query = async (sql, params) => { const result = await query(sql, params); if (sql.startsWith('DELETE')) result.meta.rows_written = actual; return result; };
        await assert.rejects(h.run('delete'), /rows_written/);
        assert.equal(h.store.files.get('budget').blocked, true);
        assert.equal(h.store.files.get('budget').days['2026-10-04'], actual ?? 6);
        await h.run('verify');
        await assert.rejects(h.run('delete'), /ledger blocked/);
    }
});

test('deletion pauses near UTC boundary before spending any write budget', async () => {
    const h = await prepared([email('a')]);
    h.dependencies.now = () => Date.UTC(2026, 9, 4, 23, 59, 50);
    await assert.rejects(h.run('delete'), /UTC midnight/);
    assert.equal(deletions(h).length, 0);
});

test('interrupted pass cannot switch command; different target checkpoint rejected', async () => {
    const h = harness([email('a')]); h.setFail(true);
    await assert.rejects(h.run('copy'));
    h.store.files.get('state').initialized = true;
    await assert.rejects(h.run('delta'), /same command/);
    await assert.rejects(runMigration(baseOptions, { ...config, targetD1: 'different' }, h.dependencies), /different migration/);
});

test('cancellation releases lock and prevents cursor checkpoint', async () => {
    const h = harness([email('a')]);
    const controller = new AbortController(); h.dependencies.signal = controller.signal;
    const ingest = h.transport.ingest;
    h.transport.ingest = async body => { const ack = await ingest(body); controller.abort(); return ack; };
    await assert.rejects(h.run('copy'), /cancelled/);
    assert.equal(h.store.files.get('state').pass.cursor, null);
    assert.equal(h.store.held, false);
});

test('native fake-fetch transport sends correct REST auth/SQL; rejects redirects and sanitizes secrets', async () => {
    const calls = [];
    const transport = createTransport(config, { fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({ success: true, result: [{ success: true, results: [], meta: { rows_written: 0 } }] }), { status: 200 });
    } });
    await transport.source.query('SELECT * FROM emails WHERE account_id = ?', ['mailbox']);
    await transport.target.query('SELECT * FROM emails', []);
    assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/accountA/d1/database/primary-db/query');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer primary-secret');
    assert.equal(calls[1].options.headers.Authorization, 'Bearer target-secret');
    assert.equal(calls[0].options.redirect, 'error');
    assert.deepEqual(JSON.parse(calls[0].options.body), { sql: 'SELECT * FROM emails WHERE account_id = ?', params: ['mailbox'] });
    await assert.rejects(transport.source.query('SELECT ?', Array(101).fill(1)), /binding limit/);
    for (const fetchImpl of [async () => new Response('secret-token-in-response', { status: 403 }), async () => { throw new Error('https://secret-token-in-url'); }, async () => new Response('not JSON'), async () => new Response(JSON.stringify({ success: false, errors: ['secret-token'] }))]) {
        await assert.rejects(createTransport(config, { fetchImpl }).source.query('SELECT 1'), error => !error.message.includes('secret-token'));
    }
});

test('live cutover proof reads actual bound primary KV and validates target D1/account/origin/token', async () => {
    let wrongDB = false, wrongMap = false;
    const requests = [];
    const transport = createTransport(config, { fetchImpl: async url => {
        requests.push(url);
        let value;
        if (url.includes('/accountA/workers/')) value = { success: true, result: { bindings: [{ name: 'DB', type: 'd1', id: 'primary-db' }, { name: 'KV', type: 'kv_namespace', namespace_id: 'actual-primary-kv' }] } };
        else if (url.includes('/accountB/workers/scripts/')) value = { success: true, result: { bindings: [{ name: 'DB', type: 'd1', id: wrongDB ? 'wrong' : 'target-db' }] } };
        else if (url.endsWith('/workers/subdomain')) value = { success: true, result: { subdomain: 'account-b' } };
        else if (url.includes('/storage/kv/')) value = { v: 1, accounts: { mailbox: wrongMap ? 'other' : 'shard1' }, shards: [{ id: 'shard1', base_url: config.shardBase, token: config.shardToken }] };
        else value = { ok: true, shard_mode: true, shard_id: 'shard1' };
        return new Response(JSON.stringify(value));
    } });
    await transport.cutoverProof('mailbox', 'shard1');
    assert.ok(requests.some(url => url.includes('/accountA/storage/kv/namespaces/actual-primary-kv/values/one-mail%3Ashard-map')));
    wrongDB = true;
    await assert.rejects(transport.cutoverProof('mailbox', 'shard1'), /Target Worker D1/);
    wrongDB = false; wrongMap = true;
    await assert.rejects(transport.cutoverProof('mailbox', 'shard1'), /Live primary KV/);
});

test('fetch receives timeout and caller cancellation signals', async () => {
    const hangingFetch = async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    // Keep a referenced timer while AbortSignal.timeout's timer is unref'd.
    const keepAlive = setInterval(() => {}, 100);
    try {
        await assert.rejects(createTransport(config, { fetchImpl: hangingFetch, timeoutMs: 5 }).health(), /timed out/);
        const controller = new AbortController();
        const pending = createTransport(config, { fetchImpl: hangingFetch, signal: controller.signal }).health();
        controller.abort();
        await assert.rejects(pending, /cancelled/);
    } finally { clearInterval(keepAlive); }
});

test('atomic FileStore survives reload, rejects concurrent locks and corrupt state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'one-mail-backfill-test-'));
    try {
        const store = new FileStore(path.join(dir, 'state.json'), path.join(dir, 'budget.json'));
        const unlock = await store.lock();
        await assert.rejects(store.lock(), /lock held/);
        await store.save(store.stateFile, { initialized: false, cursor: { id: 'a', receivedAt: 10 } });
        assert.deepEqual(await store.load(store.stateFile), { initialized: false, cursor: { id: 'a', receivedAt: 10 } });
        await store.save(store.stateFile, { initialized: true });
        assert.deepEqual(await store.load(store.stateFile), { initialized: true });
        assert.equal((await fs.readdir(dir)).some(f => f.endsWith('.tmp')), false);
        await unlock(); const release = await store.lock(); await release();
        await fs.writeFile(store.stateFile, '{');
        await assert.rejects(store.load(store.stateFile), /corrupt/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('ambiguous archival replay never overwrites a concurrent target user mutation', async () => {
    const h = harness([email('a')]);
    const ingest = h.transport.ingest;
    let first = true;
    h.transport.ingest = async body => {
        const ack = await ingest(body);
        if (first) { first = false; throw new Error('lost ack'); }
        return ack;
    };
    await assert.rejects(h.run('copy'), /lost ack/);
    h.target.sqlite.exec('UPDATE emails SET is_starred = 0, is_read = 0, updated_at = 999');
    const mutated = h.target.all();
    await assert.rejects(h.run('copy'), /archival verification failed/);
    assert.deepEqual(h.target.all(), mutated);
    assert.equal(h.store.files.get('state').pass.cursor, null);
    assert.equal(h.store.files.get('state').initialized, false);
});

test('archive refuses global email key collisions and exact folder conflicts without updates', async () => {
    for (const key of ['id', 'source_key', 'imap_uid']) {
        const original = email('a', 10, { source_key: 'unique-key', imap_uid: 'unique-uid' });
        const h = harness([original]);
        const unrelated = email(key === 'id' ? 'a' : 'other-id', 10, { account_id: 'other-mailbox', [key]: original[key] });
        h.target.put(unrelated);
        await assert.rejects(h.run('copy'), /archival verification failed/);
        assert.deepEqual(h.target.all(), [unrelated]);
    }
    const h = harness();
    const folder = { mail_account_id: 'mailbox', provider: 'imap', canonical_name: 'Inbox', display_name: 'Source Inbox', created_at: 1, updated_at: 2 };
    h.source.folder(folder);
    h.target.folder({ ...folder, display_name: 'User Inbox' });
    const prior = h.target.sqlite.prepare('SELECT * FROM mail_account_folders').all();
    await assert.rejects(h.run('copy'), /folder catalog mismatch/);
    assert.deepEqual(h.target.sqlite.prepare('SELECT * FROM mail_account_folders').all(), prior);
    assert.equal(h.store.files.get('state').pass.folderCursor, null);
});

test('copy and folder verification have explicit bounded projections and no per-row reads/writes', async () => {
    const h = harness(Array.from({ length: 100 }, (_, i) => email(`email-${String(i).padStart(3, '0')}`)));
    for (let i = 0; i < 100; i++) h.source.folder({ mail_account_id: 'mailbox', provider: 'imap', canonical_name: `folder-${i}`, created_at: 1, updated_at: 2 });
    await h.run('copy', { chunkSize: 100 });
    assert.equal(h.uploads.length, 2);
    const folderQueries = h.target.calls.filter(call => call.sql.includes('FROM mail_account_folders'));
    assert.equal(folderQueries.length, 6, 'Three bounded queries per 100-folder chunk, once for ingest and once for final verification');
    const emailQueries = h.target.calls.filter(call => call.sql.includes('FROM emails'));
    assert.equal(emailQueries.length, 3, 'One chunk check and two ID-cursor pages, not 100 identity reads');
    for (const call of [...h.source.calls, ...h.target.calls]) {
        assert.doesNotMatch(call.sql, /SELECT \*/);
        if (/^SELECT .* FROM (emails|mail_account_folders)/.test(call.sql)) assert.match(call.sql, /LIMIT/);
        assert.ok(call.params.length <= 100);
    }
    assert.equal(h.target.calls.some(call => /^(UPDATE|INSERT|DELETE)/.test(call.sql)), false);
});

test('copy/delta reject missing quiescence and unsafe v1 checkpoints while preserving v1 budget reservations', async () => {
    const h = harness([email('a')]);
    await assert.rejects(h.run('copy', { sourceQuiesced: false }), /source-quiesced/);
    assert.equal(h.uploads.length, 0);
    await h.run('copy');
    h.store.files.get('state').version = 1;
    await assert.rejects(h.run('delta'), /different migration or is invalid/);
    assert.equal(h.uploads.length, 1);
    h.store.files.get('state').version = 2;
    await h.run('verify');
    h.store.files.set('budget', { version: 1, primaryAccount: config.primaryAccount, days: { '2026-10-04': 79999 } });
    await assert.rejects(h.run('delete'), /budget exhausted/);
    assert.equal(h.store.files.get('budget').days['2026-10-04'], 79999);
    assert.equal(deletions(h).length, 0);
});

test('sanitized transport and persistent-state errors retain original causes for programmatic callers', async () => {
    const cause = new Error('private token in upstream failure');
    const transport = createTransport(config, { fetchImpl: async () => { throw cause; } });
    await assert.rejects(transport.health(), error => {
        assert.equal(error.cause, cause);
        assert.doesNotMatch(error.message, /private token/);
        return true;
    });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'one-mail-backfill-cause-'));
    try {
        const store = new FileStore(path.join(dir, 'state.json'), path.join(dir, 'budget.json'));
        await fs.writeFile(store.stateFile, '{invalid');
        await assert.rejects(store.load(store.stateFile), error => error.cause instanceof SyntaxError && !error.message.includes('invalid'));
        const unlock = await store.lock();
        await assert.rejects(store.lock(), error => error.cause?.code === 'EEXIST');
        await unlock();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('CLI operator guards, bounded options and env-only credential alternatives', async () => {
    assert.throws(() => parseArgs(['copy', '--account', 'mailbox', '--shard', 'shard1', '--state', 'state']), /confirm-copy/);
    for (const command of ['copy', 'delta']) {
        const args = [command, '--account', 'mailbox', '--shard', 'shard1', '--state', 'state', '--confirm-copy', 'mailbox'];
        assert.throws(() => parseArgs(args), /source-quiesced/);
        assert.equal(parseArgs([...args, '--source-quiesced']).sourceQuiesced, true);
    }
    assert.throws(() => parseArgs(['delete', '--account', 'mailbox', '--shard', 'shard1', '--state', 'state', '--confirm-delete', 'mailbox']), /source-quiesced/);
    assert.throws(() => parseArgs(['count', '--account', 'mailbox', '--shard', 'shard1', '--state', 'state', '--chunk-size', '101']), /Invalid/);
    assert.throws(() => configFromEnv({}), /required/);
    const env = { PRIMARY_ACCOUNT_ID: 'A', PRIMARY_D1_ID: 'p', PRIMARY_API_KEY: 'key-secret', PRIMARY_API_EMAIL: 'operator@example', TARGET_ACCOUNT_ID: 'B', TARGET_D1_ID: 't', TARGET_API_TOKEN: 'target-token', SHARD_BASE_URL: 'https://shard.example/', SHARD_TOKEN: 's'.repeat(32) };
    const parsed = configFromEnv(env);
    assert.equal(parsed.primaryHeaders['X-Auth-Key'], 'key-secret');
    assert.equal(parsed.primaryHeaders['X-Auth-Email'], 'operator@example');
    assert.equal(parsed.shardBase, 'https://shard.example');
    assert.throws(() => configFromEnv({ ...env, SHARD_BASE_URL: 'https://username:password@shard.example' }), /HTTPS origin/);
    assert.equal(configFromEnv({ ...env, PRIMARY_API_TOKEN: 'token' }).primaryHeaders.Authorization, 'Bearer token');
    let help = '';
    await main(['--help'], {}, { log: text => { help = text; } });
    assert.match(help, /PRIMARY_API_KEY/); assert.match(help, /source-quiesced/);
    assert.equal(digest(email('a')), digest({ ...email('a') }));
});
