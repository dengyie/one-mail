import type { Context } from "hono";
import { handleListQuery } from "../common";
import { cursorPredicate, decodeEmailCursor, encodeEmailCursor } from "./cursor";
import { UNIFIED_EMAIL_ORDER, UNIFIED_EMAIL_SELECT, boundedEmailFilter } from "./unified_sql.ts";

export type UnifiedListRow = {
    id: string;
    received_at: number;
    [key: string]: unknown;
};

export type EmailListQuery = {
    where: string;
    params: (string | number)[];
    limit: number;
    offset?: number;
    cursor?: string;
    withCount: boolean;
    orderBy?: string;
};

export type EmailListResult = {
    results: UnifiedListRow[];
    count: number | null;
    next_cursor: string | null;
    has_more: boolean;
};

export const executeOffsetList = (
    c: Context<HonoCustomType>,
    query: EmailListQuery,
): Promise<Response> => handleListQuery(
    c,
    `${UNIFIED_EMAIL_SELECT} WHERE ${query.where}`,
    `SELECT count(*) as count FROM emails WHERE ${query.where}`,
    query.params as string[],
    query.limit,
    query.offset,
    query.orderBy ?? UNIFIED_EMAIL_ORDER,
    [],
    { skipCount: !query.withCount },
);

const validateQuery = (query: EmailListQuery): void => {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 600) {
        throw new Error("invalid limit");
    }
    if (query.offset !== undefined && (!Number.isInteger(query.offset) || query.offset < 0 || query.offset > 500)) {
        throw new Error("invalid offset");
    }
};

/** Shard offset fan-out may request offset+limit up to 600; handleListQuery caps at 100. */
export const executeUnboundedOffsetList = async (
    c: Context<HonoCustomType>,
    query: EmailListQuery,
): Promise<EmailListResult> => {
    validateQuery(query);
    query = { ...query, ...boundedEmailFilter(query) };
    const offset = query.offset ?? 0;
    const { results } = await c.env.DB.prepare(
        `${UNIFIED_EMAIL_SELECT} WHERE ${query.where} ORDER BY ${UNIFIED_EMAIL_ORDER} LIMIT ? OFFSET ?`,
    ).bind(...query.params, query.limit, offset).all<UnifiedListRow>();
    const count = query.withCount
        ? await c.env.DB.prepare(`SELECT count(*) as count FROM emails WHERE ${query.where}`)
            .bind(...query.params).first<number>("count")
        : null;
    return {
        results: results ?? [],
        count: count ?? null,
        next_cursor: null,
        has_more: (results?.length ?? 0) >= query.limit,
    };
};

export const executeCursorList = async (
    c: Context<HonoCustomType>,
    query: EmailListQuery,
): Promise<EmailListResult> => {
    validateQuery(query);
    query = { ...query, ...boundedEmailFilter(query) };
    let decodedCursor: ReturnType<typeof decodeEmailCursor> | null = null;
    if (query.cursor) {
        decodedCursor = decodeEmailCursor(query.cursor);
    }

    let pageWhere = query.where;
    const pageParams: (string | number)[] = [...query.params];
    if (decodedCursor) {
        const predicate = cursorPredicate(decodedCursor);
        pageWhere = `(${query.where}) AND ${predicate.sql}`;
        pageParams.push(...predicate.params);
    }

    const { results } = await c.env.DB.prepare(
        `${UNIFIED_EMAIL_SELECT} WHERE ${pageWhere} ORDER BY ${UNIFIED_EMAIL_ORDER} LIMIT ?`,
    ).bind(...pageParams, query.limit + 1).all<UnifiedListRow>();

    const hasMore = results.length > query.limit;
    const page = results.slice(0, query.limit);
    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
        const last = page[page.length - 1];
        const sortKey = Number(last.received_at);
        if (!Number.isSafeInteger(sortKey) || typeof last.id !== "string" || !last.id) {
            throw new Error("invalid email sort identity");
        }
        nextCursor = encodeEmailCursor(sortKey, last.id);
    }

    const count = decodedCursor
        ? 0
        : query.withCount
            ? await c.env.DB.prepare(`SELECT count(*) as count FROM emails WHERE ${query.where}`)
                .bind(...query.params).first<number>("count")
            : null;

    return {
        results: page,
        count: count ?? (decodedCursor ? 0 : null),
        next_cursor: nextCursor,
        has_more: hasMore,
    };
};
