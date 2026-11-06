import assert from "node:assert/strict";
import test from "node:test";
import {
    BACKUP_OBJECT_PREFIX,
    backupKeyDate,
    backupObjectKey,
    isBackupKind,
    selectBackupKind,
} from "./keys.ts";

test("isBackupKind accepts only the three retention classes", () => {
    assert.equal(isBackupKind("daily"), true);
    assert.equal(isBackupKind("weekly"), true);
    assert.equal(isBackupKind("monthly"), true);
    assert.equal(isBackupKind("hourly"), false);
    assert.equal(isBackupKind(undefined), false);
    assert.equal(isBackupKind(1), false);
});

test("backupObjectKey uses a UTC date and never a local-clock date", () => {
    // 2026-11-07T23:30Z is 2026-11-08 in CST(+8): the key must stay on 11-07.
    const key = backupObjectKey("daily", new Date("2026-11-07T23:30:00Z"));
    assert.equal(key, `${BACKUP_OBJECT_PREFIX}/daily/2026-11-07.sql`);
});

test("backupKeyDate round-trips and rejects foreign or malformed keys", () => {
    const key = backupObjectKey("weekly", new Date("2026-11-02T00:00:00Z"));
    assert.equal(backupKeyDate(key)?.toISOString(), "2026-11-02T00:00:00.000Z");
    assert.equal(backupKeyDate("attachments/a.sql"), null);
    assert.equal(backupKeyDate("d1/daily/latest.sql"), null);
    assert.equal(backupKeyDate("d1/hourly/2026-11-07.sql"), null);
});

test("selectBackupKind prefers monthly, then weekly, else daily", () => {
    assert.equal(selectBackupKind(new Date("2026-11-01T03:00:00Z")), "monthly");
    // 2026-11-02 is a Monday (and not the 1st).
    assert.equal(selectBackupKind(new Date("2026-11-02T03:00:00Z")), "weekly");
    assert.equal(selectBackupKind(new Date("2026-11-07T03:00:00Z")), "daily");
});
