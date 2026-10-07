import { FleetError } from "./contracts.ts";
import type { AllocateRequest, CloudAccount, ConfigureRequest, ConfirmRequest, Epoch, FleetConfig, FleetSnapshot, ImportRequest, MailboxRoute, MetricReport, MetricsRequest, MutationRequest, PlanRequest, PublicShard, ResourceBudget, Shard, TombstoneRequest } from "./contracts.ts";

export const MAX_EPOCH = 18_446_744_073_709_551_615n;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_MAILBOXES = 1_000;
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const invalid = (): never => { throw new FleetError("INVALID_REQUEST"); };

export function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    if (keys && Object.keys(value).some(key => !keys.includes(key))) return invalid();
    return value as Record<string, unknown>;
}

export function id(value: unknown): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(value)) return invalid();
    return value;
}

export function counter(value: unknown, positive = false): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) return invalid();
    return value;
}

export function safeAdd(...values: readonly number[]): number {
    let total = 0;
    for (const value of values) {
        if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) throw new FleetError("COUNTER_OVERFLOW", 409);
        total += value;
    }
    return total;
}

export function epoch(value: unknown): Epoch {
    if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > MAX_EPOCH) return invalid();
    return value;
}

export function nextEpoch(value: Epoch): Epoch {
    const current = BigInt(epoch(value));
    if (current === MAX_EPOCH) throw new FleetError("COUNTER_OVERFLOW", 409);
    return (current + 1n).toString();
}

export function utcInstant(value: unknown): string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return invalid();
    const parsed = new Date(value);
    const canonical = value.includes(".") ? value : value.slice(0, -1) + ".000Z";
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== canonical) return invalid();
    return value;
}

export const indexValue = <T>(index: Readonly<Record<string, T>>, key: string): T | undefined => own(index, key) ? index[key] : undefined;

export function utcDate(value: unknown): string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid();
    utcInstant(`${value}T00:00:00.000Z`);
    return value;
}

function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
    if (typeof value !== "string" || !values.includes(value as T)) return invalid();
    return value as T;
}

function flag(value: unknown): boolean {
    if (typeof value !== "boolean") return invalid();
    return value;
}

function items(value: unknown, maximum: number): unknown[] {
    if (!Array.isArray(value) || value.length > maximum) return invalid();
    return value;
}

function origin(value: unknown): string {
    if (typeof value !== "string" || value.length > 256) return invalid();
    let url: URL;
    try { url = new URL(value); } catch (cause) { throw new FleetError("INVALID_REQUEST", 400, false, cause); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port) return invalid();
    return url.origin;
}

export function publicShard(value: unknown): PublicShard {
    const item = record(value, ["shard_id", "account_key", "base_url", "state", "schema_version", "protocol_version", "storage_limit_bytes", "observed_size_bytes"]);
    return {
        shard_id: id(item.shard_id), account_key: id(item.account_key), base_url: origin(item.base_url),
        state: enumeration(item.state, ["prepared", "healthy", "draining", "degraded", "exhausted", "disabled"]),
        schema_version: counter(item.schema_version, true), protocol_version: counter(item.protocol_version, true),
        storage_limit_bytes: counter(item.storage_limit_bytes, true), observed_size_bytes: counter(item.observed_size_bytes),
    };
}

export function route(value: unknown): MailboxRoute {
    const item = record(value, ["mail_account_id", "owner_shard_id", "epoch", "state", "migration_id", "updated_at"]);
    return {
        mail_account_id: id(item.mail_account_id), owner_shard_id: id(item.owner_shard_id), epoch: epoch(item.epoch),
        state: enumeration(item.state, ["active", "frozen", "deleting"]),
        migration_id: item.migration_id === null ? null : id(item.migration_id), updated_at: utcInstant(item.updated_at),
    };
}

export function resourceBudget(value: unknown): ResourceBudget {
    const item = record(value, ["reserved_read", "reserved_write", "reserved_worker_requests", "reserved_bytes"]);
    return { reserved_read: counter(item.reserved_read), reserved_write: counter(item.reserved_write), reserved_worker_requests: counter(item.reserved_worker_requests), reserved_bytes: counter(item.reserved_bytes) };
}

export function fleetConfig(value: unknown): FleetConfig {
    const item = record(value, ["accounts", "shards", "primary_shard_id", "required_schema_version", "required_protocol_version", "allocation_budget", "max_mailboxes"]);
    const accounts: CloudAccount[] = items(item.accounts, 12).map(value => {
        const account = record(value, ["account_key", "provider_account_id", "enabled", "credential_ref", "daily_read_limit", "daily_write_limit", "worker_request_limit", "metrics_observed_at"]);
        return { account_key: id(account.account_key), provider_account_id: id(account.provider_account_id), enabled: flag(account.enabled), credential_ref: id(account.credential_ref), daily_read_limit: counter(account.daily_read_limit, true), daily_write_limit: counter(account.daily_write_limit, true), worker_request_limit: counter(account.worker_request_limit, true), metrics_observed_at: account.metrics_observed_at === null ? null : utcInstant(account.metrics_observed_at) };
    });
    const shards: Shard[] = items(item.shards, 12).map(value => {
        const shard = record(value);
        const { database_id, credential_ref, ...publicFields } = shard;
        return { ...publicShard(publicFields), database_id: id(database_id), credential_ref: id(credential_ref) };
    });
    const accountKeys = new Set(accounts.map(account => account.account_key));
    if (!accounts.length || !shards.length || accountKeys.size !== accounts.length
        || new Set(accounts.map(account => account.provider_account_id)).size !== accounts.length
        || new Set(shards.map(shard => shard.shard_id)).size !== shards.length
        || new Set(shards.map(shard => `${shard.account_key}:${shard.database_id}`)).size !== shards.length
        || new Set(shards.map(shard => shard.base_url)).size !== shards.length
        || shards.some(shard => !accountKeys.has(shard.account_key))) return invalid();
    const primary = id(item.primary_shard_id);
    if (!shards.some(shard => shard.shard_id === primary)) return invalid();
    const maxMailboxes = counter(item.max_mailboxes, true);
    if (maxMailboxes > MAX_MAILBOXES) return invalid();
    const budget = resourceBudget(item.allocation_budget);
    if (!budget.reserved_read || !budget.reserved_write || !budget.reserved_worker_requests || !budget.reserved_bytes) return invalid();
    return { accounts, shards, primary_shard_id: primary, required_schema_version: counter(item.required_schema_version, true), required_protocol_version: counter(item.required_protocol_version, true), allocation_budget: budget, max_mailboxes: maxMailboxes };
}

function mutation(item: Record<string, unknown>): MutationRequest {
    return { expected_revision: epoch(item.expected_revision), idempotency_key: id(item.idempotency_key) };
}

export function configureRequest(value: unknown): ConfigureRequest {
    const item = record(value, ["expected_revision", "idempotency_key", "config"]);
    return { ...mutation(item), config: fleetConfig(item.config) };
}

export function importRequest(value: unknown): ImportRequest {
    const item = record(value, ["expected_revision", "idempotency_key", "mailboxes"]);
    const mailboxes = items(item.mailboxes, 100).map(value => {
        const entry = record(value, ["route", "user_key", "gate_confirmed"]);
        if (entry.gate_confirmed !== true) return invalid();
        return { route: route(entry.route), user_key: id(entry.user_key), gate_confirmed: true as const };
    });
    if (!mailboxes.length || new Set(mailboxes.map(entry => entry.route.mail_account_id)).size !== mailboxes.length) return invalid();
    return { ...mutation(item), mailboxes };
}

export function allocateRequest(value: unknown): AllocateRequest {
    const item = record(value, ["expected_revision", "idempotency_key", "mail_account_id", "user_key", "known_empty"]);
    if (item.known_empty !== true) throw new FleetError("MAILBOX_NOT_EMPTY", 409);
    return { ...mutation(item), mail_account_id: id(item.mail_account_id), user_key: id(item.user_key), known_empty: true };
}

export function confirmRequest(value: unknown): ConfirmRequest {
    const item = record(value, ["expected_revision", "idempotency_key", "mail_account_id", "operation_id", "gate"]);
    const gate = record(item.gate, ["owner_shard_id", "epoch", "mode"]);
    if (gate.mode !== "active") return invalid();
    return { ...mutation(item), mail_account_id: id(item.mail_account_id), operation_id: id(item.operation_id), gate: { owner_shard_id: id(gate.owner_shard_id), epoch: epoch(gate.epoch), mode: "active" } };
}

export function tombstoneRequest(value: unknown): TombstoneRequest {
    const item = record(value, ["expected_revision", "idempotency_key", "mail_account_id"]);
    return { ...mutation(item), mail_account_id: id(item.mail_account_id) };
}

export function metricReport(value: unknown): MetricReport {
    const item = record(value, ["snapshot", "projected_rows_read", "projected_rows_written", "projected_worker_requests"]);
    const snapshot = record(item.snapshot, ["account_key", "utc_date", "observed_at", "source", "rows_read", "rows_written", "worker_requests", "confidence", "shard_sizes"]);
    const sizes = record(snapshot.shard_sizes);
    if (Object.keys(sizes).length > 12) return invalid();
    const shardSizes = Object.fromEntries(Object.entries(sizes).map(([key, bytes]) => [id(key), counter(bytes)]));
    const result: MetricReport = {
        snapshot: { account_key: id(snapshot.account_key), utc_date: utcDate(snapshot.utc_date), observed_at: utcInstant(snapshot.observed_at), source: enumeration(snapshot.source, ["cloudflare_graphql", "application_meta", "reconciled"]), rows_read: counter(snapshot.rows_read), rows_written: counter(snapshot.rows_written), worker_requests: counter(snapshot.worker_requests), confidence: enumeration(snapshot.confidence, ["authoritative", "partial", "stale"]), shard_sizes: shardSizes },
        projected_rows_read: counter(item.projected_rows_read), projected_rows_written: counter(item.projected_rows_written), projected_worker_requests: counter(item.projected_worker_requests),
    };
    if (result.projected_rows_read < result.snapshot.rows_read || result.projected_rows_written < result.snapshot.rows_written || result.projected_worker_requests < result.snapshot.worker_requests) return invalid();
    return result;
}

export function metricsRequest(value: unknown): MetricsRequest {
    const item = record(value, ["expected_revision", "idempotency_key", "report"]);
    return { ...mutation(item), report: metricReport(item.report) };
}

export function planRequest(value: unknown): PlanRequest {
    const item = record(value, ["expected_revision", "affinity_shard_ids"]);
    const affinity = items(item.affinity_shard_ids ?? [], 12).map(id);
    if (new Set(affinity).size !== affinity.length) return invalid();
    return { expected_revision: epoch(item.expected_revision), affinity_shard_ids: affinity };
}

export function fleetSnapshot(value: unknown): FleetSnapshot {
    const item = record(value, ["v", "revision", "published_at", "mailbox_routes", "shards"]);
    if (item.v !== 2) return invalid();
    const shards = record(item.shards);
    const routes = record(item.mailbox_routes);
    if (Object.keys(shards).length > 12 || Object.keys(routes).length > MAX_MAILBOXES) return invalid();
    const parsedShards = Object.fromEntries(Object.entries(shards).map(([key, value]) => {
        const parsed = publicShard(value);
        if (key !== parsed.shard_id) return invalid();
        return [key, parsed];
    }));
    const parsedRoutes = Object.fromEntries(Object.entries(routes).map(([key, value]) => {
        const parsed = route(value);
        if (key !== parsed.mail_account_id || !own(parsedShards, parsed.owner_shard_id)) throw new FleetError("MISSING_OWNER", 503, true);
        return [key, parsed];
    }));
    return { v: 2, revision: epoch(item.revision), published_at: utcInstant(item.published_at), mailbox_routes: parsedRoutes, shards: parsedShards };
}
