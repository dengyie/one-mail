/**
 * `SELECT count(*) FROM emails WHERE <scope>` has no index it can use and
 * therefore reads the whole dominant table. D1 bills that as rows_read, and on
 * 2026-10-08 it is what pushed the free tier over its daily limit and took
 * every list endpoint down with it.
 *
 * Counting is opt-in: a client that renders a total must ask for one. Anything
 * unrecognised resolves to "no" so a new or malformed caller degrades to the
 * cheap path instead of the expensive one.
 */
export const wantsEmailCount = (raw: string | number | null | undefined): boolean =>
    raw === "1" || raw === 1 || raw === "true";

/**
 * 历史列表端点（`/api/mails`、`/admin/mails`、`/admin/mails_unknow`、
 * `/user_api/mails`）的契约是「缺省即计数」，不能直接套用上面的 opt-in 语义，
 * 否则所有既有调用方会突然失去分页总数。只有显式传入 `with_count=0/false`
 * 时才跳过 COUNT(*)；未传（undefined/null）与传空串都按缺省处理。
 */
export const wantsLegacyCount = (raw: string | number | null | undefined): boolean =>
    raw === undefined || raw === null ? true : wantsEmailCount(raw);