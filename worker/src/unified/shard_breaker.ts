/**
 * P4 每分片熔断与降级（docs/unified-inbox-sharding.md §6 P4）。
 *
 * 分片**读**配额逼近日限额时的两级收敛（ingest 永不阻断）：
 * - `read_pct >= degradePct`（默认 80）：该分片的远端 COUNT 关闭——列表继续
 *   发起但 `with_count=0`，count 贡献 null（与「incomplete 时 count 必为
 *   null」的既有语义一致，只是把这次 COUNT 的行读省下来）。
 * - `read_pct >= stalePct`（默认 90）：该分片的列表读不再发起，改用 KV 里
 *   上次成功快照（TTL 2 分钟）「延迟可见」；无快照则按不可达降级。
 *
 * 状态来源：分片自报 `/shard/quota`（该端点零 D1 读——读分片自己的 KV 计量），
 * 网关 isolate 缓存 60s，与 SHARD_MAP 缓存同节奏。判定 fail-open：配额未知
 * （不可达 / payload 非法）一律 normal——熔断的目的是省配额，不是主动制造
 * 不可用。
 *
 * 明确不覆盖：`/shard/verifcodes`（OTP 路径）不做快照延迟可见——验证码新鲜度
 * 高于一切，保持实况扇出 + 既有 degraded 语义。写路径（mutation/删除/归档）
 * 也不熔断：apply-if-exists 原子扇出必须摸到真库。
 */

import { fanOutShards, SHARD_LIST_MAX_BYTES, createShardResponseBudget, type ShardFetchOptions } from "./shard_client.ts";
import { SHARD_FETCH_TIMEOUT_MS } from "./shard_merge.ts";
import type { ShardEndpoint } from "./shard_map.ts";

export type BreakerMode = "normal" | "degraded" | "stale";

export interface BreakerThresholds {
    degradePct: number;
    stalePct: number;
    stateTtlMs: number;
    snapshotTtlSeconds: number;
}

const DEFAULTS: BreakerThresholds = {
    degradePct: 80,
    stalePct: 90,
    stateTtlMs: 60_000,
    // 快照 TTL 必须 ≥ 写节流间隔（否则熔断真正触发时快照已过期）。规范原文
    // 写 TTL 2 分钟，但 KV 免费档 1000 写/天——逐请求写会打穿预算，故改为
    // 「至多 5 分钟一写 + TTL 10 分钟」，熔断触发时快照至多滞后 5 分钟。
    snapshotTtlSeconds: 600,
};

/** 快照写节流（isolate 级）：同一 key 至多 5 分钟落一次 KV，写预算
 * ≤288/天/key，远低于 1000/天；isolate 重启只是多写一次，无正确性影响。 */
const SNAPSHOT_MIN_WRITE_INTERVAL_MS = 300_000;
const lastSnapshotWriteAt = new Map<string, number>();

const clampPct = (value: unknown, fallback: number): number => {
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
    return Math.min(100, Math.max(0, n));
};

export const resolveBreakerThresholds = (env: Partial<Record<string, unknown>> | undefined): BreakerThresholds => {
    const degradePct = clampPct(env?.SHARD_BREAKER_DEGRADE_PCT, DEFAULTS.degradePct);
    const stalePct = Math.max(degradePct, clampPct(env?.SHARD_BREAKER_STALE_PCT, DEFAULTS.stalePct));
    return { degradePct, stalePct, stateTtlMs: DEFAULTS.stateTtlMs, snapshotTtlSeconds: DEFAULTS.snapshotTtlSeconds };
};

/** 纯函数：给定分片自报的读配额百分比，得出熔断档位。quota 未知 → normal。 */
export const breakerStateFor = (readPct: number | null | undefined, thresholds: BreakerThresholds): BreakerMode => {
    if (typeof readPct !== "number" || !Number.isFinite(readPct)) return "normal";
    if (readPct >= thresholds.stalePct) return "stale";
    if (readPct >= thresholds.degradePct) return "degraded";
    return "normal";
};

interface CachedMode { expiresAt: number; mode: BreakerMode }
const modeCache = new Map<string, CachedMode>();

/** 测试隔离：isolate 级缓存在用例间必须清空。 */
export const resetShardBreakerCacheForTests = (): void => modeCache.clear();

const isQuotaPct = (data: unknown): data is { rows_read_pct: number } =>
    typeof data === "object" && data !== null
    && typeof (data as { rows_read_pct?: unknown }).rows_read_pct === "number"
    && Number.isFinite((data as { rows_read_pct: number }).rows_read_pct);

/**
 * 批量取各分片熔断档位（带 isolate 缓存）。网络/解析失败按 normal 处理
 * （fail-open），缓存按 shardId 独立刷新。
 */
export const getShardBreakerModes = async (
    env: { KV?: KVNamespace, SHARD_BREAKER_DEGRADE_PCT?: unknown, SHARD_BREAKER_STALE_PCT?: unknown },
    shards: readonly ShardEndpoint[],
    nowMs: number = Date.now(),
): Promise<Map<string, BreakerMode>> => {
    const thresholds = resolveBreakerThresholds(env);
    const modes = new Map<string, BreakerMode>();
    const pending: ShardEndpoint[] = [];
    for (const shard of shards) {
        const cached = modeCache.get(shard.id);
        if (cached && cached.expiresAt > nowMs) modes.set(shard.id, cached.mode);
        else pending.push(shard);
    }
    if (!pending.length) return modes;
    const limits: ShardFetchOptions = {
        deadlineAtMs: performance.now() + SHARD_FETCH_TIMEOUT_MS,
        responseBudget: createShardResponseBudget(),
        maxBodyBytes: SHARD_LIST_MAX_BYTES,
    };
    const results = await fanOutShards<unknown>(pending, "/shard/quota", limits);
    for (let index = 0; index < pending.length; index++) {
        const shard = pending[index];
        const result = results[index];
        // fail-open：不可达 / payload 非法 / shard_id 不符 → normal，不缓存负面
        // 结论（下次窗口重试）。
        const mode = result?.ok && isQuotaPct(result.data) && (result.data as { shard_id?: unknown }).shard_id === shard.id
            ? breakerStateFor((result.data as { rows_read_pct: number }).rows_read_pct, thresholds)
            : "normal";
        modes.set(shard.id, mode);
        modeCache.set(shard.id, { expiresAt: nowMs + thresholds.stateTtlMs, mode });
    }
    return modes;
};

/** 快照值上限：KV 单值上限 25MiB，这里取 512KiB —— 列表页是正文行，压不进就截行。 */
const SNAPSHOT_MAX_BYTES = 512_000;

export interface ShardSnapshot {
    rows: Array<Record<string, unknown>>;
    saved_at: number;
}

export const snapshotKey = (shardId: string, fingerprint: string): string =>
    `one-mail:shard-snapshot:${shardId}:${fingerprint}`;

/** 稳定指纹：作用域 + 影响行集的过滤参数 + 页宽（不含游标/offset——
 * 快照服务的是「同一查询形状的第一页」）。FNV-1a 32bit，无异步依赖。 */
export const snapshotFingerprint = (scope: { account_ids: string[] | null; sources: string[] | null }, rest: Record<string, unknown>, pageSize: number): string => {
    const material = JSON.stringify([
        [...(scope.account_ids ?? [])].sort(), scope.sources,
        rest.unread ?? null, rest.starred ?? null, rest.q ?? null,
        rest.since ?? null, rest.until ?? null, rest.to_addr ?? null,
        pageSize,
    ]);
    let hash = 0x811c9dc5;
    for (let index = 0; index < material.length; index++) {
        hash ^= material.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
};

const isSnapshot = (value: unknown): value is ShardSnapshot =>
    typeof value === "object" && value !== null
    && Array.isArray((value as ShardSnapshot).rows)
    && typeof (value as ShardSnapshot).saved_at === "number";

export const loadShardSnapshot = async (env: { KV?: KVNamespace }, key: string): Promise<ShardSnapshot | null> => {
    if (!env.KV) return null;
    try {
        const raw = await env.KV.get(key);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return isSnapshot(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

/** 测试隔离：清空写节流状态。 */
export const resetShardSnapshotThrottleForTests = (): void => lastSnapshotWriteAt.clear();

/** 成功列表后落快照（best-effort：KV 失败绝不影响主响应；带写节流）。
 * 行集超出字节上限时从尾部截行；一行都放不下则放弃。 */
export const saveShardSnapshot = async (
    env: { KV?: KVNamespace },
    key: string,
    rows: Array<Record<string, unknown>>,
    nowMs: number = Date.now(),
    ttlSeconds: number = DEFAULTS.snapshotTtlSeconds,
): Promise<void> => {
    if (!env.KV || !rows.length) return;
    const last = lastSnapshotWriteAt.get(key);
    if (last !== undefined && nowMs - last < SNAPSHOT_MIN_WRITE_INTERVAL_MS) return;
    lastSnapshotWriteAt.set(key, nowMs);
    let kept = rows.slice();
    while (kept.length) {
        const payload = JSON.stringify({ rows: kept, saved_at: nowMs } satisfies ShardSnapshot);
        if (payload.length <= SNAPSHOT_MAX_BYTES) {
            try {
                await env.KV.put(key, payload, { expirationTtl: Math.max(60, ttlSeconds) });
            } catch { /* best-effort */ }
            return;
        }
        kept = kept.slice(0, Math.floor(kept.length / 2));
    }
};
