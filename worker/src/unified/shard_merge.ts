/**
 * Cross-shard merge helpers. Pure functions, no I/O.
 *
 * Sort identity is (received_at DESC, id DESC). emails.id is a UUID so two
 * shards cannot emit the same (received_at, id) pair; the comparator is a
 * total order and k-way merge is safe.
 */

export const MAX_UNIFIED_OFFSET = 500;
export const SHARD_FETCH_TIMEOUT_MS = 3_000;
export const SHARD_ACCOUNT_BIND_CHUNK = 90;

export type MergeEmailRow = {
    id: string;
    received_at: number;
    [key: string]: unknown;
};

export const compareEmailOrder = (a: MergeEmailRow, b: MergeEmailRow): number => {
    const ak = Number(a.received_at);
    const bk = Number(b.received_at);
    if (ak !== bk) return bk - ak;
    if (a.id === b.id) return 0;
    return a.id < b.id ? 1 : -1;
};

/**
 * k-way merge of already-sorted pages. O(k · out) comparisons, no full sort.
 * Each page must already be in UNIFIED_EMAIL_ORDER. `outLimit` is the number
 * of rows to keep after skipping `skip` leading rows (offset).
 */
export const mergeSortedEmailPages = (
    pages: readonly (readonly MergeEmailRow[])[],
    outLimit: number,
    skip = 0,
): MergeEmailRow[] => {
    const k = pages.length;
    if (k === 0 || outLimit <= 0) return [];
    const index = new Array<number>(k).fill(0);
    const needed = skip + outLimit;
    const taken: MergeEmailRow[] = [];
    taken.length = 0;

    while (taken.length < needed) {
        let best = -1;
        let bestRow: MergeEmailRow | null = null;
        for (let i = 0; i < k; i++) {
            const row = pages[i][index[i]];
            if (!row) continue;
            if (best < 0 || compareEmailOrder(row, bestRow as MergeEmailRow) < 0) {
                best = i;
                bestRow = row;
            }
        }
        if (best < 0 || !bestRow) break;
        index[best] += 1;
        taken.push(bestRow);
    }
    return taken.slice(skip, skip + outLimit);
};

export const mergeCounts = (counts: readonly (number | null | undefined)[]): number | null => {
    let sum = 0;
    let sawNumber = false;
    for (const count of counts) {
        if (count == null) continue;
        const n = Number(count);
        if (!Number.isFinite(n) || n < 0) continue;
        sum += n;
        sawNumber = true;
    }
    return sawNumber ? sum : null;
};

export const mergeStringSets = (
    groups: readonly (readonly string[] | undefined)[],
    cap: number,
): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const group of groups) {
        if (!group) continue;
        for (const item of group) {
            if (!item || seen.has(item)) continue;
            seen.add(item);
            out.push(item);
            if (out.length >= cap) return out;
        }
    }
    return out;
};

export const chunkValues = <T>(values: readonly T[], size: number): T[][] => {
    if (size <= 0) return [Array.from(values)];
    const out: T[][] = [];
    for (let i = 0; i < values.length; i += size) {
        out.push(Array.from(values.slice(i, i + size)));
    }
    return out;
};

export const uniqueStrings = (values: readonly string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
};
