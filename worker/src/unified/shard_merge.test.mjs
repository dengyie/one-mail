import assert from "node:assert/strict";
import test from "node:test";
import {
    chunkValues,
    compareEmailOrder,
    MAX_UNIFIED_OFFSET,
    mergeCounts,
    mergeSortedEmailPages,
    mergeStringSets,
    uniqueStrings,
} from "./shard_merge.ts";

const row = (id, received_at) => ({ id, received_at });

test("compareEmailOrder is received_at DESC then id DESC", () => {
    assert.ok(compareEmailOrder(row("a", 2), row("b", 1)) < 0);
    assert.ok(compareEmailOrder(row("a", 1), row("b", 2)) > 0);
    assert.ok(compareEmailOrder(row("aaa", 1), row("bbb", 1)) > 0);
    assert.equal(compareEmailOrder(row("same", 1), row("same", 1)), 0);
});

test("mergeSortedEmailPages k-way merge keeps global order across equal timestamps", () => {
    const a = [row("z", 100), row("m", 90), row("a", 80)];
    const b = [row("y", 100), row("n", 90), row("b", 70)];
    const merged = mergeSortedEmailPages([a, b], 6);
    assert.deepEqual(merged.map((item) => item.id), ["z", "y", "n", "m", "a", "b"]);
});

test("mergeSortedEmailPages offset slices after the merged stream", () => {
    const a = [row("c", 3), row("a", 1)];
    const b = [row("b", 2)];
    assert.deepEqual(mergeSortedEmailPages([a, b], 2, 1).map((item) => item.id), ["b", "a"]);
    assert.deepEqual(mergeSortedEmailPages([a, b], 10, 3), []);
    assert.deepEqual(mergeSortedEmailPages([], 5), []);
});

test("12-shard heap merge matches the complete order with ties and offset without touching every head per row", () => {
    let timestampReads = 0;
    const pages = Array.from({ length: 12 }, (_, page) => Array.from({ length: 80 }, (_, item) => ({
        id: `${String(80 - item).padStart(3, "0")}-${String(page).padStart(2, "0")}`,
        get received_at() { timestampReads++; return 100 - item; },
    })));
    const expected = pages.flat().sort(compareEmailOrder).slice(300, 350);
    timestampReads = 0;
    const actual = mergeSortedEmailPages(pages, 50, 300);
    assert.deepEqual(actual, expected);
    assert.ok(timestampReads < 6_000, `merge read timestamp ${timestampReads} times`);
});

test("identical sort keys retain page order and input pages are unchanged", () => {
    const pages = [[{ ...row("a", 100), source: "first" }], [], [{ ...row("a", 100), source: "third" }]];
    const original = structuredClone(pages);
    assert.deepEqual(mergeSortedEmailPages(pages, 10).map((item) => item.source), ["first", "third"]);
    assert.deepEqual(pages, original);
});

test("mergeCounts sums finite numbers and stays null when every shard skipped count", () => {
    assert.equal(mergeCounts([1, 2, 3]), 6);
    assert.equal(mergeCounts([null, 4, undefined]), 4);
    assert.equal(mergeCounts([null, undefined]), null);
    assert.equal(mergeCounts([]), null);
});

test("mergeStringSets de-duplicates in first-seen order and respects cap", () => {
    assert.deepEqual(mergeStringSets([["imap", "cf"], ["imap", "graph"]], 10), ["imap", "cf", "graph"]);
    assert.deepEqual(mergeStringSets([["a", "b"], ["c"]], 2), ["a", "b"]);
});

test("chunkValues and uniqueStrings keep order and drop blanks", () => {
    assert.deepEqual(chunkValues(["a", "b", "c", "d"], 2), [["a", "b"], ["c", "d"]]);
    assert.deepEqual(uniqueStrings([" a ", "a", "", "b", " a"]), ["a", "b"]);
    assert.equal(MAX_UNIFIED_OFFSET, 500);
});
