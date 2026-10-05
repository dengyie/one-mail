/** Static account → shard registry. Only a genuinely empty configuration is local. */
export const SHARD_MAP_KV_KEY = "one-mail:shard-map";
export const SHARD_MAP_CACHE_MS = 60_000;

export type ShardEndpoint = { id: string; base_url: string; token: string };
export type ShardMap = { v: 1; generation?: number; shards: ShardEndpoint[]; accounts: Record<string, string> };
type ShardRegistryEnv = { KV?: KVNamespace | null; SHARD_FEDERATION_REQUIRED?: string | boolean; SHARD_FEDERATION_MIN_GENERATION?: string | number };
export class ShardMapError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ShardMapError";
    }
}
const emptyMap = (): ShardMap => ({ v: 1, shards: [], accounts: {} });
let cached: { at: number; value: ShardMap; kv: KVNamespace | null | undefined } | null = null;
let cacheNow: () => number = () => Date.now();
export const resetShardMapCacheForTests = (nowFn: () => number = () => Date.now()): void => {
    cached = null;
    cacheNow = nowFn;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);

export const parseShardMap = (raw: string | null | undefined): ShardMap => {
    if (raw == null || raw === "") return emptyMap();
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw new ShardMapError("Invalid shard map JSON", { cause });
    }
    if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.shards) || !isRecord(parsed.accounts)) {
        throw new ShardMapError("Invalid shard map shape or version");
    }
    const generation = parsed.generation == null ? undefined : parsed.generation;
    if (generation !== undefined && (typeof generation !== "number"
        || !Number.isSafeInteger(generation) || generation < 1)) {
        throw new ShardMapError("Invalid shard map generation");
    }
    const shards: ShardEndpoint[] = [];
    const seen = new Set<string>();
    for (const item of parsed.shards) {
        if (!isRecord(item) || typeof item.id !== "string" || typeof item.base_url !== "string"
            || typeof item.token !== "string") throw new ShardMapError("Invalid shard endpoint");
        const id = item.id.trim();
        if (!id || id === "primary" || seen.has(id)) throw new ShardMapError("Invalid or duplicate shard id");
        let url: URL;
        try {
            url = new URL(item.base_url);
        } catch (cause) {
            throw new ShardMapError("Invalid shard endpoint URL", { cause });
        }
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
            || url.pathname !== "/") throw new ShardMapError("Shard endpoint must be an HTTPS origin");
        if (!/^[\x21-\x7e]{32,512}$/.test(item.token)) throw new ShardMapError("Invalid shard token configuration");
        seen.add(id);
        shards.push({ id, base_url: url.origin, token: item.token });
    }
    const entries: [string, string][] = [];
    const accountIds = new Set<string>();
    for (const [rawId, shardId] of Object.entries(parsed.accounts)) {
        const id = rawId.trim();
        if (!id || accountIds.has(id) || typeof shardId !== "string" || !seen.has(shardId)) {
            throw new ShardMapError("Invalid account owner in shard map");
        }
        accountIds.add(id);
        entries.push([id, shardId]);
    }
    return { v: 1, ...(generation === undefined ? {} : { generation }), shards, accounts: Object.fromEntries(entries) };
};

const boolFlag = (value: unknown): boolean => value === true || value === "1" || value === "true";
const minimumGeneration = (env: ShardRegistryEnv): number => {
    const value = Number(env.SHARD_FEDERATION_MIN_GENERATION ?? 1);
    return Number.isSafeInteger(value) && value > 0 ? value : 1;
};

export const loadShardMap = async (env: ShardRegistryEnv): Promise<ShardMap> => {
    const now = cacheNow();
    if (cached && cached.kv === env.KV && now - cached.at < SHARD_MAP_CACHE_MS) return cached.value;
    if (!env.KV) {
        if (boolFlag(env.SHARD_FEDERATION_REQUIRED)) {
            throw new ShardMapError("Shard registry required but KV is unavailable");
        }
        return emptyMap();
    }
    let raw: string | null;
    try {
        raw = await env.KV.get(SHARD_MAP_KV_KEY);
    } catch (cause) {
        // Never turn a registry outage into successful local routing/deletion.
        throw new ShardMapError("Shard registry unavailable", { cause });
    }
    if ((raw == null || raw === "") && boolFlag(env.SHARD_FEDERATION_REQUIRED)) {
        throw new ShardMapError("Shard registry required but no map is published");
    }
    const value = parseShardMap(raw);
    if (boolFlag(env.SHARD_FEDERATION_REQUIRED)
        && (value.generation ?? 0) < minimumGeneration(env)) {
        throw new ShardMapError("Shard registry generation is below the required cutover");
    }
    cached = { at: now, value, kv: env.KV };
    return value;
};
export const hasRemoteShards = (map: ShardMap): boolean => map.shards.length > 0;
export const shardById = (map: ShardMap, shardId: string): ShardEndpoint | null =>
    map.shards.find((shard) => shard.id === shardId) ?? null;
export const accountsOnShard = (map: ShardMap, shardId: string): string[] =>
    Object.entries(map.accounts).filter(([, owner]) => owner === shardId).map(([id]) => id);
export const remoteAccountSet = (map: ShardMap): Set<string> => new Set(Object.keys(map.accounts));
export const groupAccountsByShard = (map: ShardMap, accountIds: readonly string[]): Map<string, string[]> => {
    const grouped = new Map<string, string[]>();
    for (const accountId of accountIds) {
        if (!Object.hasOwn(map.accounts, accountId)) continue;
        const shardId = map.accounts[accountId];
        const list = grouped.get(shardId);
        if (list) list.push(accountId);
        else grouped.set(shardId, [accountId]);
    }
    return grouped;
};
