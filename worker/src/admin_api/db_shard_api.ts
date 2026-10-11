import type { Context } from "hono";
import { isShardMode, resolveDatabaseName } from "../core/d1_quota.ts";
import {
    createShardResponseBudget,
    fanOutShards,
    fetchShardJson,
    type ShardFetchOptions,
} from "../unified/shard_client.ts";
import { SHARD_FETCH_TIMEOUT_MS } from "../unified/shard_merge.ts";
import {
    accountsOnShard,
    hasRemoteShards,
    loadShardMap,
    type ShardMap,
} from "../unified/shard_map.ts";

// Schema maintenance envelopes are tiny JSON objects; a tight budget keeps a
// misbehaving shard from spending this admin path's response memory.
const SHARD_MAINTENANCE_MAX_BYTES = 64 * 1024;

export type ShardHealthView = { shard_id: string; shard_mode: boolean };

/**
 * `/shard/health` is a separate trust domain exactly like `/shard/quota`: a 200
 * whose body does not match the contract must degrade to "unreachable" rather
 * than spread junk into the maintenance card (TypeScript view types are erased
 * at runtime).
 */
export const isShardHealthView = (value: unknown): value is ShardHealthView => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    return v.ok === true
        && typeof v.shard_id === "string" && v.shard_id.length > 0
        && typeof v.shard_mode === "boolean";
};

export type AdminShardEntry = {
    id: string;
    name: string;
    base_url: string;
    account_ids: string[];
    reachable: boolean;
    unavailable_reason: string | null;
    reported_shard_id: string | null;
    shard_mode: boolean | null;
};

export type AdminShardList = {
    primary: { shard_id: string; database_name: string; is_shard_mode: boolean };
    shards: AdminShardEntry[];
    registry_error: string | null;
};

const fetchLimits = (signal?: AbortSignal): ShardFetchOptions => ({
    deadlineAtMs: performance.now() + SHARD_FETCH_TIMEOUT_MS,
    signal,
    responseBudget: createShardResponseBudget(SHARD_MAINTENANCE_MAX_BYTES),
    maxBodyBytes: SHARD_MAINTENANCE_MAX_BYTES,
});

const entryOf = (map: ShardMap, shardId: string, overrides: Partial<AdminShardEntry>): AdminShardEntry => ({
    id: shardId,
    name: map.shards.find((shard) => shard.id === shardId)?.name ?? shardId,
    base_url: map.shards.find((shard) => shard.id === shardId)?.base_url ?? "",
    account_ids: accountsOnShard(map, shardId),
    reachable: false,
    unavailable_reason: null,
    reported_shard_id: null,
    shard_mode: null,
    ...overrides,
});

/**
 * Lists the primary database and every shard registered in SHARD_MAP. The
 * registry tokens stay server-side: entries carry id, origin and account
 * assignment only. A malformed registry degrades to an explicit
 * `registry_error` instead of hiding maintenance targets from the admin — an
 * empty list must never look like "no shards exist".
 */
export const listShards = async (c: Context<HonoCustomType>): Promise<Response> => {
    const primary = { shard_id: "primary", database_name: resolveDatabaseName(c.env), is_shard_mode: isShardMode(c.env) };
    let map: ShardMap;
    try {
        map = await loadShardMap(c.env);
    } catch {
        return c.json({ primary, shards: [], registry_error: "invalid_shard_map" });
    }
    if (!hasRemoteShards(map)) return c.json({ primary, shards: [], registry_error: null });
    const results = await fanOutShards<unknown>(map.shards, "/shard/health", fetchLimits(c.req.raw?.signal));
    const byShard = new Map(results.map((result) => [result.shard_id, result]));
    const shards = map.shards.map((shard) => {
        const result = byShard.get(shard.id);
        if (result?.ok && isShardHealthView(result.data)) {
            return entryOf(map, shard.id, {
                reachable: true,
                reported_shard_id: result.data.shard_id,
                shard_mode: result.data.shard_mode,
            });
        }
        const reason = result?.ok ? "invalid_health_payload" : (result?.error ?? "unreachable");
        console.warn(`[db-shard] shard ${shard.id} unreachable: ${reason}`);
        return entryOf(map, shard.id, { unavailable_reason: reason });
    });
    return c.json({ primary, shards, registry_error: null });
};

const readShardId = async (c: Context<HonoCustomType>): Promise<string | null> => {
    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return null;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const shardId = (body as { shard_id?: unknown }).shard_id;
    if (typeof shardId !== "string") return null;
    const trimmed = shardId.trim();
    return trimmed === "" ? null : trimmed;
};

/**
 * Admin-triggered shard schema maintenance. The primary Worker has no D1
 * binding for a remote shard, so it never runs DDL itself: it forwards to the
 * shard's own idempotent `/shard/schema/initialize` — the same repair the
 * shard's initialize and migrate paths both run — using the endpoint and token
 * from the shard registry. The shard id must be registered in SHARD_MAP, so a
 * request can never point this proxy at an arbitrary URL, and the token is
 * only ever sent to its own endpoint.
 */
export const initializeShard = async (c: Context<HonoCustomType>): Promise<Response> => {
    const shardId = await readShardId(c);
    if (!shardId) return c.json({ ok: false, error: "shard_id is required" }, 400);
    if (shardId === "primary") {
        return c.json({ ok: false, error: "use /admin/db_initialize for the primary database" }, 400);
    }
    let map: ShardMap;
    try {
        map = await loadShardMap(c.env);
    } catch {
        return c.json({ ok: false, error: "shard registry unavailable" }, 503);
    }
    const shard = map.shards.find((entry) => entry.id === shardId);
    if (!shard) return c.json({ ok: false, error: "unknown shard id" }, 404);
    const result = await fetchShardJson<Record<string, unknown>>(shard, "/shard/schema/initialize", {
        ...fetchLimits(c.req.raw?.signal),
        method: "POST",
        body: {},
    });
    if (result.ok && result.data.ok === true) {
        return c.json({ ok: true, shard_id: shardId, message: "Shard schema initialized" });
    }
    const reason = result.ok ? "invalid_initialize_payload" : (result.error ?? "unreachable");
    console.warn(`[db-shard] shard ${shardId} schema maintenance failed: ${reason}`);
    return c.json({ ok: false, shard_id: shardId, error: reason }, 502);
};

export default { list: listShards, initialize: initializeShard };
