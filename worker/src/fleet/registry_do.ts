import { FleetError } from "./contracts.ts";
import type { AllocateRequest, ConfigureRequest, ConfirmRequest, FleetConfig, FleetMode, FleetSnapshot, ImportRequest, MailboxRoute, MetricSeries, MetricsRequest, MutationRequest, PendingAllocation, PublicShard, ResourceBudget, TombstoneRequest } from "./contracts.ts";
import { choosePlacement, EMPTY_BUDGET, updateMetricSeries } from "./placement.ts";
import type { PlacementDecision } from "./placement.ts";
import { allocateRequest, configureRequest, confirmRequest, id, importRequest, indexValue, metricsRequest, nextEpoch, planRequest, safeAdd, tombstoneRequest } from "./validation.ts";
import { readFleetJson } from "./http_io.ts";

const META = "registry:meta";
const ROUTES = "registry:route:";
const MAILBOXES = "registry:mailbox:";
const METRICS = "registry:metrics:";
const OPERATIONS = "registry:op:";
const AUDIT = "registry:audit:";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_OPERATIONS = 200_000;

interface RegistryMeta {
    revision: string;
    updated_at: string;
    config: FleetConfig | null;
    mailbox_count: number;
    operation_count: number;
}

interface MailboxRecord {
    readonly user_key: string;
    readonly route: MailboxRoute | null;
    readonly pending: PendingAllocation | null;
    readonly deleted: boolean;
    readonly epoch: string;
}

interface OperationRecord {
    readonly fingerprint: string;
    readonly response: Record<string, unknown>;
    readonly created_at: number;
}

type Txn = DurableObjectTransaction;
type Command = ConfigureRequest | ImportRequest | AllocateRequest | ConfirmRequest | MetricsRequest | TombstoneRequest;
type RegistryEnvironment = { FLEET_MODE?: string };
const emptyMeta = (now: number): RegistryMeta => ({ revision: "0", updated_at: new Date(now).toISOString(), config: null, mailbox_count: 0, operation_count: 0 });
const mailboxKey = (mailbox: string): string => `${MAILBOXES}${mailbox}`;
const routeKey = (mailbox: string): string => `${ROUTES}${mailbox}`;
const modeOf = (value?: string): FleetMode => {
    if (value === undefined || value === "") return "legacy-static";
    if (!["legacy-static", "observe", "allocate", "rebalance"].includes(value)) throw new FleetError("INVALID_REQUEST");
    return value as FleetMode;
};
const requireAllocationMode = (mode: FleetMode): void => {
    if (mode !== "allocate" && mode !== "rebalance") throw new FleetError("MODE_DISABLED", 409);
};

function parseCommand(path: string, body: unknown): Command {
    switch (path) {
        case "/configure": return configureRequest(body);
        case "/import": return importRequest(body);
        case "/allocate": return allocateRequest(body);
        case "/confirm": return confirmRequest(body);
        case "/metrics": return metricsRequest(body);
        case "/tombstone": return tombstoneRequest(body);
        default: throw new FleetError("INVALID_REQUEST", 404);
    }
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
    return JSON.stringify(value);
}

async function fingerprint(path: string, command: Command): Promise<string> {
    const bytes = new TextEncoder().encode(`${path}\n${canonical(command)}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function publicShards(config: FleetConfig): Record<string, PublicShard> {
    return Object.fromEntries(config.shards.map(({ database_id: _database, credential_ref: _credential, ...shard }) => [shard.shard_id, shard]));
}

function requireConfig(meta: RegistryMeta): FleetConfig {
    if (!meta.config) throw new FleetError("NOT_CONFIGURED", 503, true);
    return meta.config;
}

function assertOwner(config: FleetConfig, owner: string): void {
    if (!config.shards.some(shard => shard.shard_id === owner)) throw new FleetError("MISSING_OWNER", 503, true);
}

async function pruneOperations(txn: Txn, meta: RegistryMeta, now: number): Promise<void> {
    const cutoff = `${AUDIT}${String(now - RETENTION_MS).padStart(16, "0")}:`;
    const expired = await txn.list<string>({ prefix: AUDIT, end: cutoff, limit: 100 });
    for (const [indexKey, operationKey] of expired) {
        await txn.delete(operationKey);
        await txn.delete(indexKey);
        meta.operation_count--;
    }
}

async function configure(txn: Txn, meta: RegistryMeta, request: ConfigureRequest): Promise<Record<string, unknown>> {
    const config = request.config;
    if (meta.mailbox_count > config.max_mailboxes) throw new FleetError("CONFIG_CONFLICT", 409);
    if (meta.config && meta.config.primary_shard_id !== config.primary_shard_id) throw new FleetError("CONFIG_CONFLICT", 409);
    const nextShards = new Map(config.shards.map(shard => [shard.shard_id, shard]));
    const nextAccounts = new Map(config.accounts.map(account => [account.account_key, account]));
    const previousAccounts = new Map(meta.config?.accounts.map(account => [account.account_key, account]) ?? []);
    const previousShards = new Map(meta.config?.shards.map(shard => [shard.shard_id, shard]) ?? []);
    for (const previous of meta.config?.shards ?? []) {
        const usage = await txn.get<number>(`registry:shard-usage:${previous.shard_id}`) ?? 0;
        if (!usage) continue;
        const replacement = nextShards.get(previous.shard_id);
        const oldAccount = previousAccounts.get(previous.account_key)!;
        if (!replacement || replacement.account_key !== previous.account_key || replacement.database_id !== previous.database_id
            || replacement.base_url !== previous.base_url || nextAccounts.get(previous.account_key)?.provider_account_id !== oldAccount.provider_account_id) throw new FleetError("CONFIG_CONFLICT", 409);
    }
    // Qualification belongs to the physical account and its measured databases,
    // not to reusable logical names. Credentials and array order are irrelevant.
    const invalidated = new Set<string>();
    for (const account of [...previousAccounts.values(), ...nextAccounts.values()]) {
        if (previousAccounts.get(account.account_key)?.provider_account_id !== nextAccounts.get(account.account_key)?.provider_account_id) invalidated.add(account.account_key);
    }
    for (const shard of [...previousShards.values(), ...nextShards.values()]) {
        const previous = previousShards.get(shard.shard_id);
        const next = nextShards.get(shard.shard_id);
        if (previous?.account_key === next?.account_key && previous?.database_id === next?.database_id) continue;
        if (previous) invalidated.add(previous.account_key);
        if (next) invalidated.add(next.account_key);
    }
    for (const accountKey of invalidated) await txn.delete(`${METRICS}${accountKey}`);
    meta.config = { ...config, accounts: config.accounts.map(account => invalidated.has(account.account_key) ? { ...account, metrics_observed_at: null } : account) };
    return { ok: true };
}

async function incrementUsage(txn: Txn, shard: string): Promise<void> {
    const key = `registry:shard-usage:${shard}`;
    await txn.put(key, safeAdd(await txn.get<number>(key) ?? 0, 1));
}

async function addAffinity(txn: Txn, user: string, shard: string): Promise<void> {
    const key = `registry:user:${user}`;
    const shards = await txn.get<Record<string, number>>(key) ?? {};
    shards[shard] = safeAdd(indexValue(shards, shard) ?? 0, 1);
    await txn.put(key, shards);
}

async function removeAffinity(txn: Txn, user: string, shard: string): Promise<void> {
    const key = `registry:user:${user}`;
    const shards = await txn.get<Record<string, number>>(key) ?? {};
    const count = indexValue(shards, shard) ?? 0;
    if (count <= 1) delete shards[shard];
    else shards[shard] = count - 1;
    if (Object.keys(shards).length) await txn.put(key, shards);
    else await txn.delete(key);
}

async function importRoutes(txn: Txn, meta: RegistryMeta, request: ImportRequest): Promise<Record<string, unknown>> {
    const config = requireConfig(meta);
    if (meta.mailbox_count + request.mailboxes.length > config.max_mailboxes) throw new FleetError("REGISTRY_LIMIT", 409);
    for (const entry of request.mailboxes) {
        assertOwner(config, entry.route.owner_shard_id);
        const key = mailboxKey(entry.route.mail_account_id);
        const existing = await txn.get<MailboxRecord>(key);
        if (existing?.deleted) throw new FleetError("MAILBOX_DELETED", 409);
        if (existing) throw new FleetError("CONFIG_CONFLICT", 409);
        await txn.put(key, { user_key: entry.user_key, route: entry.route, pending: null, deleted: entry.route.state === "deleting", epoch: entry.route.epoch } satisfies MailboxRecord);
        await txn.put(routeKey(entry.route.mail_account_id), entry.route);
        await incrementUsage(txn, entry.route.owner_shard_id);
        await addAffinity(txn, entry.user_key, entry.route.owner_shard_id);
    }
    meta.mailbox_count += request.mailboxes.length;
    return { ok: true, imported: request.mailboxes.length };
}

async function metrics(txn: Txn, meta: RegistryMeta, request: MetricsRequest, now: number): Promise<Record<string, unknown>> {
    const config = requireConfig(meta);
    const snapshot = request.report.snapshot;
    if (!config.accounts.some(account => account.account_key === snapshot.account_key)) throw new FleetError("INVALID_REQUEST");
    const expectedShards = new Set(config.shards.filter(shard => shard.account_key === snapshot.account_key).map(shard => shard.shard_id));
    if (Object.keys(snapshot.shard_sizes).some(shard => !expectedShards.has(shard))) throw new FleetError("INVALID_REQUEST");
    const key = `${METRICS}${snapshot.account_key}`;
    const series = updateMetricSeries(await txn.get<MetricSeries>(key), request.report, now);
    await txn.put(key, series);
    if (series.consecutive_valid_samples > 0) {
        meta.config = {
            ...config,
            accounts: config.accounts.map(account => account.account_key === snapshot.account_key ? { ...account, metrics_observed_at: snapshot.observed_at } : account),
            shards: config.shards.map(shard => indexValue(snapshot.shard_sizes, shard.shard_id) === undefined ? shard : { ...shard, observed_size_bytes: snapshot.shard_sizes[shard.shard_id] }),
        };
    }
    return { ok: true, consecutive_valid_samples: series.consecutive_valid_samples };
}

async function placementFor(txn: Txn, config: FleetConfig, affinity: ReadonlySet<string>, now: number): Promise<{ decision: PlacementDecision; budgets: Record<string, ResourceBudget>; bytes: Record<string, number> }> {
    const budgets = await txn.get<Record<string, ResourceBudget>>("registry:allocation-budgets") ?? {};
    const bytes = await txn.get<Record<string, number>>("registry:reserved-bytes") ?? {};
    const series = await txn.get<MetricSeries>(config.accounts.map(account => `${METRICS}${account.account_key}`));
    const decision = choosePlacement({ config, metrics: Object.fromEntries([...series.values()].map(value => [value.report.snapshot.account_key, value])), account_reservations: budgets, shard_reserved_bytes: bytes, affinity_shards: affinity, now });
    return { decision, budgets, bytes };
}

async function allocate(txn: Txn, meta: RegistryMeta, request: AllocateRequest, now: number, mode: FleetMode): Promise<Record<string, unknown>> {
    requireAllocationMode(mode);
    const config = requireConfig(meta);
    const key = mailboxKey(request.mail_account_id);
    const existing = await txn.get<MailboxRecord>(key);
    if (existing?.deleted) throw new FleetError("MAILBOX_DELETED", 409);
    if (existing && existing.user_key !== request.user_key) throw new FleetError("CONFIG_CONFLICT", 409);
    if (existing?.route) return { ok: true, route: existing.route };
    if (existing?.pending) return { ok: true, pending: existing.pending };
    if (meta.mailbox_count >= config.max_mailboxes) throw new FleetError("REGISTRY_LIMIT", 409);
    const date = new Date(now).toISOString().slice(0, 10);
    const budgetKey = "registry:allocation-budgets";
    const affinities = await txn.get<Record<string, number>>(`registry:user:${request.user_key}`) ?? {};
    const { decision, budgets, bytes: shardBytes } = await placementFor(txn, config, new Set(Object.keys(affinities)), now);
    if (!decision.ok) throw new FleetError(decision.error_code, 503, true);
    const pending: PendingAllocation = { operation_id: request.idempotency_key, mail_account_id: request.mail_account_id, owner_shard_id: decision.shard_id, epoch: "1", created_at: new Date(now).toISOString() };
    const before = indexValue(budgets, decision.account_key) ?? EMPTY_BUDGET;
    const demand = config.allocation_budget;
    budgets[decision.account_key] = { reserved_read: safeAdd(before.reserved_read, demand.reserved_read), reserved_write: safeAdd(before.reserved_write, demand.reserved_write), reserved_worker_requests: safeAdd(before.reserved_worker_requests, demand.reserved_worker_requests), reserved_bytes: safeAdd(before.reserved_bytes, demand.reserved_bytes) };
    shardBytes[decision.shard_id] = safeAdd(indexValue(shardBytes, decision.shard_id) ?? 0, demand.reserved_bytes);
    await txn.put(budgetKey, budgets);
    await txn.put("registry:reserved-bytes", shardBytes);
    // Reservations deliberately survive confirmation, timeouts and tombstones.
    // Their consumption cannot be inferred safely from delayed account telemetry.
    await txn.put(`registry:reservation:${request.mail_account_id}`, { account_key: decision.account_key, shard_id: decision.shard_id, operation_id: pending.operation_id, utc_date: date, ...demand, state: "held" });
    await txn.put(key, { user_key: request.user_key, route: null, pending, deleted: false, epoch: pending.epoch } satisfies MailboxRecord);
    await incrementUsage(txn, decision.shard_id);
    await addAffinity(txn, request.user_key, decision.shard_id);
    meta.mailbox_count++;
    return { ok: true, pending };
}

async function confirm(txn: Txn, meta: RegistryMeta, request: ConfirmRequest, now: number, mode: FleetMode): Promise<Record<string, unknown>> {
    requireAllocationMode(mode);
    const config = requireConfig(meta);
    const key = mailboxKey(request.mail_account_id);
    const mailbox = await txn.get<MailboxRecord>(key);
    if (!mailbox) throw new FleetError("UNKNOWN_MAILBOX", 404);
    if (mailbox.deleted) throw new FleetError("MAILBOX_DELETED", 409);
    const pending = mailbox.pending;
    if (!pending || pending.operation_id !== request.operation_id || pending.owner_shard_id !== request.gate.owner_shard_id || pending.epoch !== request.gate.epoch) throw new FleetError("GATE_MISMATCH", 409);
    assertOwner(config, pending.owner_shard_id);
    if (mailbox.route) return { ok: true, route: mailbox.route };
    const route: MailboxRoute = { mail_account_id: request.mail_account_id, owner_shard_id: pending.owner_shard_id, epoch: pending.epoch, state: "active", migration_id: null, updated_at: new Date(now).toISOString() };
    await txn.put(key, { ...mailbox, route });
    await txn.put(routeKey(request.mail_account_id), route);
    return { ok: true, route };
}

async function tombstone(txn: Txn, meta: RegistryMeta, request: TombstoneRequest, now: number): Promise<Record<string, unknown>> {
    requireConfig(meta);
    const key = mailboxKey(request.mail_account_id);
    const mailbox = await txn.get<MailboxRecord>(key);
    if (mailbox?.deleted) return { ok: true, tombstone: { mail_account_id: request.mail_account_id, epoch: mailbox.epoch } };
    const epoch = nextEpoch(mailbox?.epoch ?? "0");
    await txn.put(key, { user_key: mailbox?.user_key ?? "deleted", route: mailbox?.route ?? null, pending: mailbox?.pending ?? null, deleted: true, epoch } satisfies MailboxRecord);
    await txn.delete(routeKey(request.mail_account_id));
    if (mailbox) {
        meta.mailbox_count--;
        const owner = mailbox.route?.owner_shard_id ?? mailbox.pending?.owner_shard_id;
        if (owner) await removeAffinity(txn, mailbox.user_key, owner);
    }
    return { ok: true, tombstone: { mail_account_id: request.mail_account_id, epoch, owner_shard_id: mailbox?.route?.owner_shard_id ?? mailbox?.pending?.owner_shard_id ?? null, updated_at: new Date(now).toISOString() } };
}

async function execute(txn: Txn, meta: RegistryMeta, path: string, command: Command, now: number, mode: FleetMode): Promise<Record<string, unknown>> {
    switch (path) {
        case "/configure": return configure(txn, meta, command as ConfigureRequest);
        case "/import": return importRoutes(txn, meta, command as ImportRequest);
        case "/metrics": return metrics(txn, meta, command as MetricsRequest, now);
        case "/allocate": return allocate(txn, meta, command as AllocateRequest, now, mode);
        case "/confirm": return confirm(txn, meta, command as ConfirmRequest, now, mode);
        case "/tombstone": return tombstone(txn, meta, command as TombstoneRequest, now);
        default: throw new FleetError("INVALID_REQUEST", 404);
    }
}

/** One named object owns all fleet decisions. Its transactions perform storage I/O only. */
export class FleetRegistryDurableObject implements DurableObject {
    private readonly state: DurableObjectState;
    private readonly env: RegistryEnvironment;

    constructor(state: DurableObjectState, env: RegistryEnvironment) {
        this.state = state;
        this.env = env;
    }

    async fetch(request: Request): Promise<Response> {
        const requestId = crypto.randomUUID();
        try {
            const mode = modeOf(this.env.FLEET_MODE);
            const url = new URL(request.url);
            if (request.method === "GET") return await this.read(url, Date.now());
            if (request.method !== "POST") throw new FleetError("INVALID_REQUEST", 405);
            const body = await readFleetJson(request);
            if (url.pathname === "/plan") return await this.plan(body, Date.now());
            const command = parseCommand(url.pathname, body);
            const digest = await fingerprint(url.pathname, command);
            const now = Date.now();
            const result = await this.state.storage.transaction(async txn => {
                const meta = await txn.get<RegistryMeta>(META) ?? emptyMeta(now);
                const operationKey = `${OPERATIONS}${command.idempotency_key}`;
                const previous = await txn.get<OperationRecord>(operationKey);
                // Replay precedes CAS: callers retry the original body after lost responses.
                if (previous) {
                    if (previous.fingerprint !== digest) throw new FleetError("IDEMPOTENCY_CONFLICT", 409);
                    return previous.response;
                }
                if (meta.revision !== command.expected_revision) throw new FleetError("REVISION_CONFLICT", 409, true);
                const revision = nextEpoch(meta.revision);
                await pruneOperations(txn, meta, now);
                if (meta.operation_count >= MAX_OPERATIONS) throw new FleetError("REGISTRY_LIMIT", 503, true);
                const response = { ...await execute(txn, meta, url.pathname, command, now, mode), revision };
                meta.revision = revision;
                meta.updated_at = new Date(now).toISOString();
                meta.operation_count++;
                await txn.put(META, meta);
                await txn.put(operationKey, { fingerprint: digest, response, created_at: now } satisfies OperationRecord);
                await txn.put(`${AUDIT}${String(now).padStart(16, "0")}:${command.idempotency_key}`, operationKey);
                return response;
            });
            return Response.json(result);
        } catch (cause) {
            const error = cause instanceof FleetError ? cause : new FleetError("REGISTRY_UNAVAILABLE", 503, true, cause);
            if (!(cause instanceof FleetError)) console.error("fleet registry operation failed", { request_id: requestId, cause });
            return Response.json({ ok: false, error_code: error.code, retryable: error.retryable, request_id: requestId }, { status: error.status, headers: error.retryable ? { "Retry-After": "5" } : undefined });
        }
    }

    private async plan(body: unknown, now: number): Promise<Response> {
        const request = planRequest(body);
        const result = await this.state.storage.transaction(async txn => {
            const meta = await txn.get<RegistryMeta>(META) ?? emptyMeta(now);
            const config = requireConfig(meta);
            if (meta.revision !== request.expected_revision) throw new FleetError("REVISION_CONFLICT", 409, true);
            const shards = new Set(config.shards.map(shard => shard.shard_id));
            if (request.affinity_shard_ids.some(shard => !shards.has(shard))) throw new FleetError("INVALID_REQUEST");
            const { decision } = await placementFor(txn, config, new Set(request.affinity_shard_ids), now);
            return { ok: true, revision: meta.revision, decision };
        });
        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }

    private async read(url: URL, now: number): Promise<Response> {
        if (url.pathname !== "/snapshot" && url.pathname !== "/route") throw new FleetError("INVALID_REQUEST", 404);
        const mailboxId = url.pathname === "/route" ? id(url.searchParams.get("mail_account_id")) : null;
        const result = await this.state.storage.transaction(async txn => {
            const meta = await txn.get<RegistryMeta>(META) ?? emptyMeta(now);
            const config = requireConfig(meta);
            if (mailboxId) {
                const mailbox = await txn.get<MailboxRecord>(mailboxKey(mailboxId));
                if (!mailbox) throw new FleetError("UNKNOWN_MAILBOX", 404);
                if (mailbox.deleted) throw new FleetError("MAILBOX_DELETED", 409);
                const owner = mailbox.route?.owner_shard_id ?? mailbox.pending?.owner_shard_id;
                if (!owner) throw new FleetError("MISSING_OWNER", 503, true);
                assertOwner(config, owner);
                return { revision: meta.revision, ok: true, route: mailbox.route, pending: mailbox.pending };
            }
            const routes = await txn.list<MailboxRoute>({ prefix: ROUTES, limit: config.max_mailboxes + 1 });
            if (routes.size > config.max_mailboxes) throw new FleetError("REGISTRY_LIMIT", 503);
            const owners = new Set(config.shards.map(shard => shard.shard_id));
            for (const route of routes.values()) if (!owners.has(route.owner_shard_id)) throw new FleetError("MISSING_OWNER", 503, true);
            const snapshot: FleetSnapshot = { v: 2, revision: meta.revision, published_at: meta.updated_at, mailbox_routes: Object.fromEntries([...routes.values()].map(route => [route.mail_account_id, route])), shards: publicShards(config) };
            return snapshot;
        });
        const etag = `"${result.revision}"`;
        return Response.json(result, { headers: { ETag: etag, "Cache-Control": "no-store" } });
    }
}
