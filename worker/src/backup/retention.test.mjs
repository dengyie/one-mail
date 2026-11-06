import assert from "node:assert/strict";
import test from "node:test";
import {
    RETENTION_MAX_DELETES,
    expiredBackupKeys,
    pruneBackups,
    retentionCutoff,
} from "./retention.ts";

test("retentionCutoff subtracts whole days in milliseconds", () => {
    const cutoff = retentionCutoff("daily", new Date("2026-11-07T06:00:00Z"), 30);
    assert.equal(cutoff.toISOString(), "2026-10-08T06:00:00.000Z");
});

test("expiredBackupKeys compares whole UTC days, not clock time", () => {
    const cutoff = new Date("2026-10-08T23:59:00Z");
    // Cutoff day is 2026-10-08, so a backup ON that day is kept.
    assert.deepEqual(
        expiredBackupKeys(
            ["d1/daily/2026-10-08.sql", "d1/daily/2026-10-07.sql"],
            cutoff,
        ),
        ["d1/daily/2026-10-07.sql"],
    );
});

test("expiredBackupKeys ignores keys that are not ours", () => {
    assert.deepEqual(
        expiredBackupKeys(["attachments/x.sql", "d1/daily/latest.sql", "garbage"], new Date("2030-01-01T00:00:00Z")),
        [],
    );
});

function fakeBucket(pages, deleted) {
    return {
        list: async ({ prefix, cursor }) => {
            const matching = paged(prefix, pages, cursor);
            return matching;
        },
        delete: async (keys) => {
            deleted.push(...keys);
        },
    };
}

function paged(prefix, pages, cursor) {
    const pageIndex = cursor ? Number(cursor) : 0;
    const page = (pages[prefix] ?? [])[pageIndex] ?? [];
    const next = pageIndex + 1;
    const hasNext = Boolean((pages[prefix] ?? [])[next]);
    return {
        objects: page.map((key) => ({ key })),
        truncated: hasNext,
        cursor: hasNext ? String(next) : undefined,
    };
}

test("pruneBackups walks pages per kind and deletes only expired keys", async () => {
    const deleted = [];
    const bucket = fakeBucket({
        "d1/daily/": [
            ["d1/daily/2026-11-07.sql", "d1/daily/2026-01-01.sql"],
            ["d1/daily/2026-01-02.sql"],
        ],
        "d1/weekly/": [["d1/weekly/2026-01-05.sql"]],
        "d1/monthly/": [["d1/monthly/2020-01-01.sql"]],
    }, deleted);

    const result = await pruneBackups(
        bucket,
        { daily: 30, weekly: 84, monthly: 365 },
        new Date("2026-11-07T03:00:00Z"),
    );
    assert.deepEqual(deleted.sort(), [
        "d1/daily/2026-01-01.sql",
        "d1/daily/2026-01-02.sql",
        "d1/monthly/2020-01-01.sql",
        "d1/weekly/2026-01-05.sql",
    ].sort());
    assert.equal(result.deleted, 4);
    assert.equal(result.scanned, 5);
});

test("pruneBackups caps deletes per run", async () => {
    const keys = Array.from({ length: 300 }, (_, index) => {
        const day = String((index % 28) + 1).padStart(2, "0");
        return `d1/daily/2020-01-${day}.sql`;
    });
    const deleted = [];
    const bucket = fakeBucket({ "d1/daily/": [keys] }, deleted);
    const result = await pruneBackups(
        bucket,
        { daily: 30, weekly: 84, monthly: 365 },
        new Date("2026-11-07T03:00:00Z"),
    );
    assert.equal(deleted.length, RETENTION_MAX_DELETES);
    assert.equal(result.deleted, RETENTION_MAX_DELETES);
});

test("pruneBackups stops at the list page cap even when the bucket says truncated", async () => {
    const pages = {};
    // Ten pages, each still truncated: the loop must stop at RETENTION_MAX_LIST_PAGES.
    pages["d1/daily/"] = Array.from({ length: 20 }, () => ["d1/daily/2026-11-07.sql"]);
    const bucket = {
        list: async ({ cursor }) => {
            const index = cursor ? Number(cursor) : 0;
            return {
                objects: pages["d1/daily/"][index].map((key) => ({ key })),
                truncated: true,
                cursor: String(index + 1),
            };
        },
        delete: async () => {
            throw new Error("must not delete fresh keys");
        },
    };
    const result = await pruneBackups(
        bucket,
        { daily: 30, weekly: 84, monthly: 365 },
        new Date("2026-11-07T03:00:00Z"),
    );
    assert.equal(result.deleted, 0);
    // Three kinds, ten pages each: the cap is per kind, not global.
    assert.equal(result.scanned, 30);
});