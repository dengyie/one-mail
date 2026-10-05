import { safeEqual } from "../core/timing.ts";
import { readBearerToken, SHARD_SCOPE_HEADER, type ShardRequestScope } from "./shard_client.ts";

export const MIN_SHARD_TOKEN_BYTES = 32;
export const shardTokenConfigured = (token: string | undefined | null): token is string =>
    typeof token === "string" && /^[\x21-\x7e]{32,512}$/.test(token);
export const authorizeShardRequest = async (
    env: { SHARD_TOKEN?: string }, request: Request,
): Promise<boolean> => {
    if (!shardTokenConfigured(env.SHARD_TOKEN)) return false;
    const presented = readBearerToken(request);
    return !!presented && safeEqual(presented, env.SHARD_TOKEN);
};

export const parseShardScope = (request: Request): ShardRequestScope | null => {
    const raw = request.headers.get(SHARD_SCOPE_HEADER);
    if (!raw) return null;
    try {
        const value: unknown = JSON.parse(decodeURIComponent(raw));
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const scope = value as Record<string, unknown>;
        const valid = (items: unknown): items is string[] | null => items === null
            || (Array.isArray(items) && items.every((item) => typeof item === "string" && item.trim().length > 0));
        if (!valid(scope.account_ids) || !valid(scope.sources)) return null;
        return { account_ids: scope.account_ids, sources: scope.sources };
    } catch { return null; }
};
export const shardScopeAllowsRow = (
    scope: ShardRequestScope,
    row: { account_id?: string | null; source?: string | null },
): boolean => (scope.account_ids === null || (!!row.account_id && scope.account_ids.includes(row.account_id)))
    && (scope.sources === null || (!!row.source && scope.sources.includes(row.source)));
