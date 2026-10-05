#!/usr/bin/env node
/**
 * Offline P3 operator tool. No deployment, KV writes, or implicit source deletion.
 * node db/backfill_shard.mjs --help
 * Explicit archival ingest inserts exact source rows and NEVER updates conflicts.
 * A failed/ambiguous request is replayed, never checkpointed before verification.
 * Delta scans all source rows, including late arrivals with old received_at.
 * Existing-row writers must be quiesced throughout copy/cutover/delta/verify;
 * changed source or target state fails closed rather than overwriting user edits.
 */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const EMAIL_COLUMNS = 'id source account_id from_addr to_addr subject text_body html_body received_at internal_date headers_json is_read is_starred flags_json attachments_json raw_ref imap_uid updated_at provider source_folder source_folder_id provider_message_id provider_thread_id message_id_header in_reply_to references_json has_attachments source_key sync_version'.split(' ');
export const FOLDER_COLUMNS = 'mail_account_id provider provider_folder_id canonical_name display_name folder_type uidvalidity last_cursor last_sync_at last_error created_at updated_at'.split(' ');
const FOLDER_DIGEST_COLUMNS = FOLDER_COLUMNS.filter(k => !['last_sync_at', 'created_at', 'updated_at'].includes(k));
const API = 'https://api.cloudflare.com/client/v4';
const MAP_KEY = 'one-mail:shard-map';
const VERSION = 2; // Reject checkpoints produced by the former update-based protocol.
const BUDGET_VERSION = 1; // Keep existing reservations; never reset the source ledger.
class SafeError extends Error {}
const requireThat = (condition, message) => { if (!condition) throw new SafeError(message); };
const values = (row, columns) => columns.map(k => row[k] ?? null);
export const digest = (row, columns = EMAIL_COLUMNS) => createHash('sha256').update(JSON.stringify(values(row, columns))).digest('hex');
// Order-independent accumulator allows subtraction of acknowledged deleted rows
// without rescanning the entire remaining mailbox after every three-row DELETE.
const xorDigest = (accumulator, hex) => {
    const bytes = Buffer.from(hex, 'hex');
    for (let i = 0; i < accumulator.length; i++) accumulator[i] ^= bytes[i];
};
const quoted = k => `"${k}"`;
const placeholders = n => Array(n).fill('?').join(',');
const normalizeURL = value => {
    const url = new URL(value);
    requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname.replace(/\/$/, '') === '', 'SHARD_BASE_URL must be an HTTPS origin');
    return url.origin;
};

export const HELP = `Usage (Node 24, all secrets from environment only):
  node db/backfill_shard.mjs copy --account ID --shard ID --state FILE --confirm-copy ID --source-quiesced
  node db/backfill_shard.mjs delta --account ID --shard ID --state FILE --confirm-copy ID --source-quiesced
  node db/backfill_shard.mjs verify --account ID --shard ID --state FILE
  node db/backfill_shard.mjs count --account ID --shard ID --state FILE
  node db/backfill_shard.mjs delete --account ID --shard ID --state FILE --confirm-delete ID --source-quiesced
Options: --chunk-size 15 (1..100), --delay-ms 1000 (0..60000),
         --timeout-ms 45000 (1..300000), --stable-ms 65000 (>=65000),
         --daily-budget 80000 (1..80000, actual source rows_written including indexes).
Required env: PRIMARY_ACCOUNT_ID PRIMARY_D1_ID and PRIMARY_API_TOKEN OR
              PRIMARY_API_KEY + PRIMARY_API_EMAIL;
              TARGET_ACCOUNT_ID TARGET_D1_ID TARGET_API_TOKEN;
              SHARD_BASE_URL SHARD_TOKEN (>=32 characters).
Delete additionally requires PRIMARY_WORKER_NAME TARGET_WORKER_NAME. Their live
Cloudflare settings must bind DB to the specified D1s; target origin must equal
https://TARGET_WORKER_NAME.<account-B-subdomain>.workers.dev (P2 deployment).
The actual primary KV binding supplies one-mail:shard-map, whose account mapping,
shard origin and token must match.
--source-quiesced is required for copy/delta/delete. For copy/delta it attests
existing-row writers (provider refresh, retention and user mutations) stopped on
BOTH stores throughout copy -> cutover -> delta -> verification. Insert-only new
arrivals may continue until cutover. For delete it additionally attests aggregator
routing/cache convergence and ALL source writers stopped throughout deletion;
existing-row writers on the TARGET must also remain stopped until deletion ends.
Verify compares source IDs and ALL email columns against target (target extras
are permitted after cutover); count is informational and never permits deletion.
Delta requires completed copy; each new delta starts from the beginning. Interrupted
passes resume the acknowledged composite cursor. Use the SAME state file always.
State and shared source daily-budget ledger use atomic writes and exclusive locks.
Legacy v1 migration checkpoints are rejected; v1 budget reservations are retained.
Ambiguous deletes retain their reserved budget. Never remove/reset the ledger to
bypass a budget. After a crash, remove a .lock only after confirming its PID is dead.
Explicit migration:true ingest inserts missing rows only, preserving exact source
values. Conflicting IDs/content/state fail verification without target updates.
Changed source rows also fail; resolve conflicts manually before any deletion.
No folders, mutation jobs, or cf_routing emails are deleted. No automatic retries.
`;

export function parseArgs(argv) {
    if (argv.includes('--help')) return { help: true };
    const options = { command: argv[0], chunkSize: 15, delayMs: 1000, timeoutMs: 45000, stableMs: 65000, dailyBudget: 80000, sourceQuiesced: false };
    const names = { '--account': 'account', '--shard': 'shard', '--state': 'stateFile', '--chunk-size': 'chunkSize', '--delay-ms': 'delayMs', '--timeout-ms': 'timeoutMs', '--stable-ms': 'stableMs', '--daily-budget': 'dailyBudget', '--confirm-copy': 'confirmCopy', '--confirm-delete': 'confirmDelete' };
    for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '--source-quiesced') { options.sourceQuiesced = true; continue; }
        const key = names[argv[i]];
        requireThat(key && argv[i + 1] && !argv[i + 1].startsWith('--'), 'Unknown option or missing value; use --help');
        options[key] = argv[++i];
    }
    requireThat(['copy', 'delta', 'verify', 'count', 'delete'].includes(options.command), 'Expected copy, delta, verify, count or delete');
    for (const key of ['account', 'shard', 'stateFile']) requireThat(typeof options[key] === 'string' && options[key].trim(), `--${key === 'stateFile' ? 'state' : key} required`);
    requireThat(options.account !== 'cf_routing' && options.shard !== 'primary', 'External mailbox and remote shard required');
    for (const [key, min, max] of [['chunkSize', 1, 100], ['delayMs', 0, 60000], ['timeoutMs', 1, 300000], ['stableMs', 65000, 86400000], ['dailyBudget', 1, 80000]]) {
        options[key] = Number(options[key]);
        requireThat(Number.isInteger(options[key]) && options[key] >= min && options[key] <= max, `Invalid ${key}`);
    }
    if (['copy', 'delta'].includes(options.command)) {
        requireThat(options.confirmCopy === options.account, '--confirm-copy must equal --account (target writes)');
        requireThat(options.sourceQuiesced, 'Copy/delta requires --source-quiesced (existing-row writers stopped on both stores)');
    }
    if (options.command === 'delete') requireThat(options.confirmDelete === options.account && options.sourceQuiesced, 'Delete requires --confirm-delete ACCOUNT and --source-quiesced');
    options.stateFile = path.resolve(options.stateFile);
    return options;
}

export function configFromEnv(env) {
    const needed = ['PRIMARY_ACCOUNT_ID', 'PRIMARY_D1_ID', 'TARGET_ACCOUNT_ID', 'TARGET_D1_ID', 'TARGET_API_TOKEN', 'SHARD_BASE_URL', 'SHARD_TOKEN'];
    for (const key of needed) requireThat(env[key], `${key} required`);
    requireThat(env.PRIMARY_API_TOKEN || (env.PRIMARY_API_KEY && env.PRIMARY_API_EMAIL), 'PRIMARY_API_TOKEN or PRIMARY_API_KEY + PRIMARY_API_EMAIL required');
    requireThat(env.SHARD_TOKEN.length >= 32, 'SHARD_TOKEN must be at least 32 characters');
    requireThat(env.PRIMARY_ACCOUNT_ID !== env.TARGET_ACCOUNT_ID, 'Target must be a separate Cloudflare account');
    const primaryHeaders = env.PRIMARY_API_TOKEN ? { Authorization: `Bearer ${env.PRIMARY_API_TOKEN}` } : { 'X-Auth-Key': env.PRIMARY_API_KEY, 'X-Auth-Email': env.PRIMARY_API_EMAIL };
    return { primaryAccount: env.PRIMARY_ACCOUNT_ID, primaryD1: env.PRIMARY_D1_ID, targetAccount: env.TARGET_ACCOUNT_ID, targetD1: env.TARGET_D1_ID, primaryWorker: env.PRIMARY_WORKER_NAME, targetWorker: env.TARGET_WORKER_NAME, primaryHeaders, targetHeaders: { Authorization: `Bearer ${env.TARGET_API_TOKEN}` }, shardBase: normalizeURL(env.SHARD_BASE_URL), shardToken: env.SHARD_TOKEN };
}

// Deliberately never expose remote bodies, URLs, SQL, credentials or raw exceptions.
export function createTransport(config, { fetchImpl = globalThis.fetch, signal, timeoutMs = 45000 } = {}) {
    async function request(url, headers, body, raw = false) {
        try {
            const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
            const response = await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: combined });
            requireThat(response.ok, `Remote HTTP ${response.status}`);
            if (raw) return await response.text();
            const result = await response.json();
            requireThat(result && result.success !== false, 'Remote API rejected request');
            return result;
        } catch (error) {
            if (signal?.aborted) throw new SafeError('Operation cancelled', { cause: error });
            if (error instanceof SafeError) throw error;
            throw new SafeError('Remote request failed, timed out, or returned invalid data', { cause: error });
        }
    }
    const accountURL = (account, suffix) => `${API}/accounts/${encodeURIComponent(account)}/${suffix}`;
    const db = (account, id, headers) => ({
        async query(sql, params = []) {
            requireThat(params.length <= 100, 'D1 binding limit exceeded');
            const data = await request(accountURL(account, `d1/database/${encodeURIComponent(id)}/query`), headers, { sql, params });
            requireThat(Array.isArray(data.result) && data.success === true && data.result.length === 1 && data.result[0].success === true && Array.isArray(data.result[0].results), 'Invalid D1 acknowledgement');
            return data.result[0];
        },
    });
    const shardHeaders = { Authorization: `Bearer ${config.shardToken}` };
    return {
        source: db(config.primaryAccount, config.primaryD1, config.primaryHeaders),
        target: db(config.targetAccount, config.targetD1, config.targetHeaders),
        health: () => request(`${config.shardBase}/shard/health`, shardHeaders),
        ingest: body => request(`${config.shardBase}/shard/ingest`, shardHeaders, body),
        async cutoverProof(account, shard) {
            requireThat(config.primaryWorker && config.targetWorker, 'Delete requires PRIMARY_WORKER_NAME and TARGET_WORKER_NAME');
            const settings = async (id, name, headers) => {
                const result = await request(accountURL(id, `workers/scripts/${encodeURIComponent(name)}/settings`), headers);
                requireThat(Array.isArray(result.result?.bindings), 'Invalid Worker settings acknowledgement');
                return result.result.bindings;
            };
            const primary = await settings(config.primaryAccount, config.primaryWorker, config.primaryHeaders);
            const target = await settings(config.targetAccount, config.targetWorker, config.targetHeaders);
            requireThat(primary.some(b => b.name === 'DB' && b.type === 'd1' && b.id === config.primaryD1), 'Primary Worker D1 binding mismatch');
            requireThat(target.some(b => b.name === 'DB' && b.type === 'd1' && b.id === config.targetD1), 'Target Worker D1 binding mismatch');
            // P2 uses workers.dev. Bind the HTTPS origin to the actual account B
            // deployment, rather than trusting an operator-named unrelated Worker.
            const subdomain = await request(accountURL(config.targetAccount, 'workers/subdomain'), config.targetHeaders);
            requireThat(typeof subdomain.result?.subdomain === 'string' && config.shardBase === `https://${config.targetWorker}.${subdomain.result.subdomain}.workers.dev`, 'Target origin must match account B Worker workers.dev deployment');
            const kv = primary.find(b => b.name === 'KV' && b.type === 'kv_namespace');
            requireThat(kv?.namespace_id, 'Primary Worker KV binding missing');
            const raw = await request(accountURL(config.primaryAccount, `storage/kv/namespaces/${encodeURIComponent(kv.namespace_id)}/values/${encodeURIComponent(MAP_KEY)}`), config.primaryHeaders, undefined, true);
            let map;
            try { map = JSON.parse(raw); } catch (error) { throw new SafeError('Invalid live shard map', { cause: error }); }
            const endpoint = map?.shards?.find(s => s.id === shard);
            requireThat(map?.v === 1 && map.accounts?.[account] === shard && endpoint?.base_url?.replace(/\/+$/, '') === config.shardBase && endpoint?.token === config.shardToken, 'Live primary KV shard map does not match mailbox and target');
            const health = await this.health();
            requireThat(health.ok === true && health.shard_mode === true && health.shard_id === shard, 'Shard health identity mismatch');
        },
    };
}

export class FileStore {
    constructor(stateFile, budgetFile) { this.stateFile = stateFile; this.budgetFile = budgetFile; }
    async load(file) {
        try { return JSON.parse(await fs.readFile(file, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return null; throw new SafeError('Unreadable or corrupt persistent state', { cause: error }); }
    }
    async save(file, value) {
        const temp = `${file}.${process.pid}.tmp`;
        let handle;
        try {
            handle = await fs.open(temp, 'w', 0o600);
            await handle.writeFile(JSON.stringify(value) + '\n');
            await handle.sync();
            await handle.close(); handle = null;
            await fs.rename(temp, file);
            // Directory fsync is unavailable on some Windows filesystems.
            if (process.platform !== 'win32') { const dir = await fs.open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
        } finally { await handle?.close(); await fs.rm(temp, { force: true }); }
    }
    async lock() {
        const held = [];
        try {
            for (const file of [...new Set([this.stateFile, this.budgetFile])].sort()) {
                await fs.mkdir(path.dirname(file), { recursive: true });
                const lockFile = `${file}.lock`;
                let handle;
                try { handle = await fs.open(lockFile, 'wx', 0o600); }
                catch (error) { throw new SafeError('Cannot acquire state or source-budget lock; lock held or local state unavailable', { cause: error }); }
                held.push(lockFile);
                try { await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync(); } finally { await handle.close(); }
            }
        } catch (error) { for (const file of held) await fs.rm(file, { force: true }); throw error; }
        return async () => { for (const file of held) await fs.rm(file, { force: true }); };
    }
}

const rows = async (db, sql, params = []) => (await db.query(sql, params)).results;
const emailScope = "account_id = ? AND source != 'cf_routing'";
async function emailPage(db, account, cursor, size, byId = false) {
    const suffix = cursor ? (byId ? ' AND id > ?' : ' AND (received_at > ? OR (received_at = ? AND id > ?))') : '';
    const params = [account, ...(cursor ? (byId ? [cursor] : [cursor.receivedAt, cursor.receivedAt, cursor.id]) : []), size];
    return rows(db, `SELECT ${EMAIL_COLUMNS.map(quoted).join(',')} FROM emails WHERE ${emailScope}${suffix} ORDER BY ${byId ? 'id' : 'received_at, id'} LIMIT ?`, params);
}
async function* emailsById(db, account, size) {
    let cursor = null;
    while (true) {
        const page = await emailPage(db, account, cursor, size, true);
        if (!page.length) return;
        for (const row of page) yield row;
        cursor = page.at(-1).id;
    }
}
async function folderPage(db, account, cursor, size) {
    return rows(db, `SELECT ${['id', ...FOLDER_COLUMNS].map(quoted).join(',')} FROM mail_account_folders WHERE mail_account_id = ?${cursor == null ? '' : ' AND id > ?'} ORDER BY id LIMIT ?`, [account, ...(cursor == null ? [] : [cursor]), size]);
}
const project = (row, columns) => Object.fromEntries(columns.map(k => [k, row[k]]));
const folderIdentity = row => JSON.stringify([row.mail_account_id, row.provider, row.provider_folder_id == null ? ['canonical', row.canonical_name] : ['provider', row.provider_folder_id]]);

async function verifyEmailChunk(db, page, message) {
    // One bounded read per chunk, including at the immediate pre-delete gate.
    for (let offset = 0; offset < page.length; offset += 100) {
        const chunk = page.slice(offset, offset + 100);
        const matches = await rows(db, `SELECT ${EMAIL_COLUMNS.map(quoted).join(',')} FROM emails WHERE id IN (${placeholders(chunk.length)}) LIMIT ${chunk.length}`, chunk.map(row => row.id));
        const byId = new Map(matches.map(row => [row.id, row]));
        requireThat(matches.length === chunk.length && chunk.every(row => byId.has(row.id) && digest(row) === digest(byId.get(row.id))), message);
    }
}

async function verifyFolderChunk(db, page, columns = FOLDER_DIGEST_COLUMNS) {
    // Two binds per identity plus the account bind, <=99 total. LIMIT detects
    // ambiguous identities without reading an unbounded catalog or issuing N+1.
    for (let offset = 0; offset < page.length; offset += 49) {
        const chunk = page.slice(offset, offset + 49);
        const predicates = chunk.map(folder => `(provider = ? AND ${folder.provider_folder_id == null ? 'provider_folder_id IS NULL AND canonical_name = ?' : 'provider_folder_id = ?'})`).join(' OR ');
        const matches = await rows(db, `SELECT ${FOLDER_COLUMNS.map(quoted).join(',')} FROM mail_account_folders WHERE mail_account_id = ? AND (${predicates}) LIMIT ${chunk.length + 1}`, [chunk[0].mail_account_id, ...chunk.flatMap(folder => [folder.provider, folder.provider_folder_id ?? folder.canonical_name])]);
        const identities = new Map();
        for (const match of matches) {
            const key = folderIdentity(match);
            const group = identities.get(key) ?? [];
            group.push(match); identities.set(key, group);
        }
        requireThat(matches.length === chunk.length && chunk.every(folder => {
            const group = identities.get(folderIdentity(folder));
            return group?.length === 1 && digest(folder, columns) === digest(group[0], columns);
        }), 'Verification failed: folder catalog mismatch');
    }
}

export async function verify(source, target, account, size) {
    const hash = Buffer.alloc(32);
    let sourceCount = 0, targetCount = 0;
    const iterator = emailsById(target, account, size)[Symbol.asyncIterator]();
    let remote = await iterator.next();
    for await (const row of emailsById(source, account, size)) {
        while (!remote.done && remote.value.id < row.id) { targetCount++; remote = await iterator.next(); }
        requireThat(!remote.done && remote.value.id === row.id && digest(row) === digest(remote.value), 'Verification failed: source email ID/content/state mismatch');
        xorDigest(hash, digest(row)); sourceCount++; targetCount++;
        remote = await iterator.next();
    }
    while (!remote.done) { targetCount++; remote = await iterator.next(); }
    let folderCursor = null, folderCount = 0;
    while (true) {
        const page = await folderPage(source, account, folderCursor, size);
        if (!page.length) break;
        await verifyFolderChunk(target, page);
        for (const folder of page) {
            xorDigest(hash, digest(folder, FOLDER_DIGEST_COLUMNS)); folderCount++;
        }
        folderCursor = page.at(-1).id;
    }
    return { sourceCount, targetCount, folderCount, sourceDigest: hash.toString('hex') };
}

async function validateSchemas(source, target) {
    for (const [table, columns] of [['emails', EMAIL_COLUMNS], ['mail_account_folders', ['id', ...FOLDER_COLUMNS]]]) {
        for (const db of [source, target]) {
            const actual = (await rows(db, `PRAGMA table_info(${table})`)).map(row => row.name).sort();
            requireThat(JSON.stringify(actual) === JSON.stringify([...columns].sort()), 'Unsupported source/target schema; refusing to omit or invent columns');
        }
    }
}

async function noPendingJobs(db, account) {
    const pending = await rows(db, "SELECT id FROM mail_mutation_jobs WHERE account_id = ? AND status NOT IN ('succeeded','superseded') LIMIT 1", [account]);
    requireThat(!pending.length, 'Unresolved mutation jobs block deletion (including failed/unsupported)');
}
async function deletionCost(db) {
    const triggers = await rows(db, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'emails'");
    requireThat(!triggers.length, 'Email triggers prevent a bounded delete budget');
    const tables = await rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'");
    for (const table of tables) {
        const fks = await rows(db, `PRAGMA foreign_key_list(${quoted(table.name.replaceAll('"', '""'))})`);
        requireThat(!fks.some(fk => fk.table === 'emails'), 'Foreign-key dependents prevent a bounded delete budget');
    }
    // Includes the TEXT primary-key autoindex and all partial/expression indexes.
    const indexes = await rows(db, 'PRAGMA index_list(emails)');
    requireThat(indexes.length > 0, 'Missing email primary-key index');
    return 1 + indexes.length;
}

export async function runMigration(options, config, dependencies = {}) {
    const signal = dependencies.signal;
    const transport = dependencies.transport ?? createTransport(config, { signal, timeoutMs: options.timeoutMs });
    const budgetFile = path.join(path.dirname(fileURLToPath(import.meta.url)), `.backfill-budget-${createHash('sha256').update(config.primaryAccount).digest('hex').slice(0, 24)}.json`);
    const store = dependencies.store ?? new FileStore(options.stateFile, budgetFile);
    const wait = dependencies.wait ?? (ms => sleep(ms, undefined, { signal }));
    const now = dependencies.now ?? Date.now;
    const check = () => requireThat(!signal?.aborted, 'Operation cancelled');
    const pause = async ms => { check(); if (ms) await wait(ms); check(); };
    const unlock = await store.lock();
    try {
        const binding = { account: options.account, shard: options.shard, primaryAccount: config.primaryAccount, primaryD1: config.primaryD1, targetAccount: config.targetAccount, targetD1: config.targetD1, shardBase: config.shardBase };
        let state = await store.load(store.stateFile);
        if (state) requireThat(state.version === VERSION && JSON.stringify(state.binding) === JSON.stringify(binding) && typeof state.initialized === 'boolean', 'Checkpoint belongs to a different migration or is invalid');
        else state = { version: VERSION, binding, initialized: false, pass: null };
        const save = () => store.save(store.stateFile, state);
        const { source, target } = transport;
        check();
        await validateSchemas(source, target);
        check();
        if (['copy', 'delta'].includes(options.command)) {
            requireThat(options.confirmCopy === options.account, '--confirm-copy must equal --account');
            requireThat(options.sourceQuiesced, 'Copy/delta requires --source-quiesced (existing-row writers stopped on both stores)');
            requireThat(options.command !== 'delta' || state.initialized, 'Delta requires a completed copy (including an acknowledged empty copy)');
            requireThat(!state.deletionStarted, 'Copy/delta forbidden once source deletion has started');
            const health = await transport.health();
            requireThat(health.ok === true && health.shard_mode === true && health.shard_id === options.shard, 'Shard health identity mismatch');
            if (!state.pass || state.pass.done) state.pass = { command: options.command, phase: 'folders', folderCursor: null, cursor: null, copied: 0, done: false };
            requireThat(state.pass.command === options.command, 'Resume unfinished pass with the same command');
            state.verified = null;
            await save();
            while (state.pass.phase === 'folders') {
                check();
                const page = await folderPage(source, options.account, state.pass.folderCursor, options.chunkSize);
                if (!page.length) { state.pass.phase = 'emails'; await save(); break; }
                const ack = await transport.ingest({ migration: true, emails: [], folders: page.map(folder => project(folder, FOLDER_COLUMNS)) });
                requireThat(Number.isSafeInteger(ack?.folders_upserted) && ack.folders_upserted >= 0 && ack.folders_upserted <= page.length && ack.inserted === 0 && ack.skipped === 0, 'Folder ingest was not acknowledged');
                check();
                await verifyFolderChunk(target, page, FOLDER_COLUMNS);
                check();
                state.pass.folderCursor = page.at(-1).id;
                await save(); await pause(options.delayMs);
            }
            while (true) {
                check();
                const page = await emailPage(source, options.account, state.pass.cursor, options.chunkSize);
                if (!page.length) break;
                for (const row of page) {
                    requireThat(typeof row.id === 'string' && row.id && Number.isSafeInteger(row.received_at) && row.source !== 'cf_routing', 'Invalid email cursor row');
                }
                const ack = await transport.ingest({ migration: true, emails: page.map(row => project(row, EMAIL_COLUMNS)), folders: [] });
                requireThat(Number.isSafeInteger(ack?.inserted) && Number.isSafeInteger(ack.skipped) && ack.inserted >= 0 && ack.skipped >= 0 && ack.inserted + ack.skipped === page.length && ack.folders_upserted === 0, 'Email ingest was not acknowledged idempotently');
                check();
                // Skipped inserts may mean collisions, never permission to overwrite.
                await verifyEmailChunk(target, page, 'Email archival verification failed: conflicting ID/content/state');
                check();
                state.pass.cursor = { receivedAt: page.at(-1).received_at, id: page.at(-1).id };
                state.pass.copied += page.length;
                await save(); await pause(options.delayMs);
            }
            // Full verification also catches changed rows in already acknowledged
            // chunks on resume. It never repairs conflicts by changing target state.
            await verify(source, target, options.account, options.chunkSize);
            check();
            state.pass.done = true; state.initialized = true;
            await save();
            return { command: options.command, copied: state.pass.copied, initialized: true };
        }
        if (options.command === 'count') {
            const count = async db => (await rows(db, `SELECT COUNT(*) AS count FROM emails WHERE ${emailScope}`, [options.account]))[0].count;
            return { sourceCount: await count(source), targetCount: await count(target), informationalOnly: true };
        }
        if (options.command === 'verify') {
            const result = await verify(source, target, options.account, options.chunkSize);
            state.verified = result; await save(); return result;
        }
        requireThat(options.command === 'delete' && options.confirmDelete === options.account && options.sourceQuiesced, 'Explicit delete guards required');
        requireThat(state.initialized && state.pass?.done, 'Delete requires completed copy/delta');
        requireThat(state.verified, 'Run verify successfully before deletion');
        await transport.cutoverProof(options.account, options.shard);
        await noPendingJobs(source, options.account); await noPendingJobs(target, options.account);
        const first = await verify(source, target, options.account, options.chunkSize);
        requireThat(first.sourceDigest === state.verified.sourceDigest && first.sourceCount === state.verified.sourceCount, 'Source changed since persisted verification; run delta/verify again');
        await pause(options.stableMs);
        const stable = await verify(source, target, options.account, options.chunkSize);
        requireThat(stable.sourceDigest === first.sourceDigest && stable.sourceCount === first.sourceCount, 'Source is not stable');
        const cost = await deletionCost(source);
        let ledger = await store.load(store.budgetFile) ?? { version: BUDGET_VERSION, primaryAccount: config.primaryAccount, days: {} };
        requireThat(ledger.version === BUDGET_VERSION && ledger.primaryAccount === config.primaryAccount && ledger.days && typeof ledger.days === 'object', 'Invalid source-budget ledger');
        requireThat(!ledger.blocked, 'Source-budget ledger blocked by missing/excess rows_written; inspect manually');
        state.deletionStarted = true; await save();
        let deleted = 0;
        while (true) {
            check();
            await transport.cutoverProof(options.account, options.shard);
            await noPendingJobs(source, options.account); await noPendingJobs(target, options.account);
            const before = state.verified;
            const clock = now();
            const day = new Date(clock).toISOString().slice(0, 10);
            requireThat(86400000 - (clock % 86400000) > options.timeoutMs + 60000, 'Delete paused near UTC midnight; resume after day rollover');
            const used = ledger.days[day] ?? 0;
            requireThat(Number.isSafeInteger(used) && used >= 0, 'Invalid daily write budget');
            const capacity = Math.floor((options.dailyBudget - used) / cost);
            if (!before.sourceCount) {
                const final = await verify(source, target, options.account, options.chunkSize);
                requireThat(final.sourceCount === 0 && final.sourceDigest === before.sourceDigest, 'Source changed during deletion; verification required');
                return { deleted, sourceCount: 0, dailyRowsWritten: used };
            }
            requireThat(capacity > 0, 'Daily source rows_written budget exhausted; resume another UTC day');
            const maxRows = Math.min(options.chunkSize, capacity, Math.floor((100 - 1) / EMAIL_COLUMNS.length));
            const page = await emailPage(source, options.account, null, maxRows);
            requireThat(page.length > 0, 'Source changed during deletion; verification required');
            await verifyEmailChunk(target, page, 'Immediate pre-delete verification failed');
            const reserveClock = now();
            requireThat(new Date(reserveClock).toISOString().slice(0, 10) === day && 86400000 - (reserveClock % 86400000) > options.timeoutMs + 60000, 'Delete paused near UTC midnight; resume after day rollover');
            const reserved = page.length * cost;
            ledger.days[day] = used + reserved;
            await store.save(store.budgetFile, ledger); // Retain reservation on ambiguity/crash.
            check();
            const predicates = page.map(() => `(${EMAIL_COLUMNS.map(k => `${quoted(k)} IS ?`).join(' AND ')})`).join(' OR ');
            const result = await source.query(`DELETE FROM emails WHERE ${emailScope} AND (${predicates}) AND NOT EXISTS (SELECT 1 FROM mail_mutation_jobs WHERE account_id = emails.account_id AND status NOT IN ('succeeded','superseded'))`, [options.account, ...page.flatMap(row => values(row, EMAIL_COLUMNS))]);
            const actual = result.meta?.rows_written;
            if (!Number.isSafeInteger(actual) || actual < 0) {
                ledger.blocked = true;
                await store.save(store.budgetFile, ledger);
                throw new SafeError('Missing delete rows_written; budget reservation retained; inspect manually');
            }
            ledger.days[day] = used + actual;
            if (actual > reserved) ledger.blocked = true;
            await store.save(store.budgetFile, ledger);
            requireThat(actual <= reserved, 'Delete rows_written exceeded reserved bound; ledger blocked; inspect manually');
            requireThat(result.meta?.changes === page.length, 'Conditional delete rejected changed source rows; verification required');
            deleted += page.length;
            const remaining = Buffer.from(state.verified.sourceDigest, 'hex');
            for (const row of page) xorDigest(remaining, digest(row));
            state.verified = { ...state.verified, sourceCount: state.verified.sourceCount - page.length, sourceDigest: remaining.toString('hex') };
            await save(); await pause(options.delayMs);
        }
    } finally { await unlock(); }
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
    const options = parseArgs(argv);
    if (options.help) { (dependencies.log ?? console.log)(HELP); return; }
    const config = configFromEnv(env);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
        const result = await runMigration(options, config, { ...dependencies, signal: dependencies.signal ?? controller.signal });
        (dependencies.log ?? console.log)(JSON.stringify(result));
        return result;
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => {
        // Our own errors contain no remote content; redact env secrets as defence
        // in depth, and suppress arbitrary filesystem/transport exception text.
        const secrets = Object.entries(process.env).filter(([key, value]) => /TOKEN|KEY|EMAIL|PASSWORD|SECRET/.test(key) && value).map(([, value]) => value);
        // Causes remain available to programmatic callers, never to CLI output.
        let message = error instanceof SafeError ? error.message : 'Local state operation failed or operation cancelled';
        for (const secret of secrets) message = message.replaceAll(secret, '[redacted]');
        console.error(`Backfill failed: ${message || 'operation failed'}`);
        process.exitCode = 1;
    });
}
