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