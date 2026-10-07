/**
 * Cross-shard merge helpers. Pure functions, no I/O.
 *
 * Sort identity is (received_at DESC, id DESC), where received_at is the
 * effective-date projection supplied by unified_list. Duplicate identities
 * retain page order; callers must exclude copies outside the active owner.
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
 * Heap merge of already-sorted pages. O(k + (skip + out) log k) comparisons,
 * O(k + out) memory; skipped rows are not buffered and inputs are not mutated.
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
    type Head = { page: number; index: number; row: MergeEmailRow };
    const heap = new Array<Head>(k);
    let size = 0;
    for (let page = 0; page < k; page++) {
        if (pages[page].length) heap[size++] = { page, index: 0, row: pages[page][0] };
    }
    heap.length = size;
    const compare = (a: Head, b: Head): number => compareEmailOrder(a.row, b.row) || a.page - b.page;
    const siftDown = (start: number): void => {
        const head = heap[start];
        let parent = start;
        while (parent * 2 + 1 < size) {
            let child = parent * 2 + 1;
            if (child + 1 < size && compare(heap[child + 1], heap[child]) < 0) child++;
            if (compare(head, heap[child]) <= 0) break;
            heap[parent] = heap[child];
            parent = child;
        }
        heap[parent] = head;
    };
    for (let parent = Math.floor(size / 2) - 1; parent >= 0; parent--) siftDown(parent);
    const needed = skip + outLimit;
    const taken: MergeEmailRow[] = [];
    for (let consumed = 0; consumed < needed && size > 0; consumed++) {
        const head = heap[0];
        if (consumed >= skip) taken.push(head.row);
        head.index++;
        const next = pages[head.page][head.index];
        if (next) {
            head.row = next;
        } else {
            size--;
            heap[0] = heap[size];
            heap.length = size;
        }
        if (size > 0) siftDown(0);
    }
    return taken;
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
