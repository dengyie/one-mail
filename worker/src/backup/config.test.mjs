import assert from "node:assert/strict";
import test from "node:test";
import { resolveBackupConfig, validateBackupTarget, DEFAULT_RETENTION_DAYS } from "./config.ts";

const BUCKET = { put: async () => ({ size: 0 }) };

function configured(overrides = {}) {
    return {
        BACKUP_BUCKET: BUCKET,
        CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        D1_DATABASE_ID: "5f3e1c0a-9b2d-4e7a-8c61-1d2e3f4a5b6c",
        D1_REST_API_TOKEN: "token",
        ...overrides,
    };
}

test("absent bucket is a disabled result, not an error", () => {
    assert.deepEqual(resolveBackupConfig({}), { ok: false, error: "missing_bucket" });
});

test("each missing credential is reported by name", () => {
    assert.deepEqual(
        resolveBackupConfig({ BACKUP_BUCKET: BUCKET }),
        { ok: false, error: "missing_account_id" },
    );
    assert.deepEqual(
        resolveBackupConfig({ BACKUP_BUCKET: BUCKET, CLOUDFLARE_ACCOUNT_ID: "a" }),
        { ok: false, error: "missing_database_id" },
    );
    assert.deepEqual(
        resolveBackupConfig({ BACKUP_BUCKET: BUCKET, CLOUDFLARE_ACCOUNT_ID: "a", D1_DATABASE_ID: "b" }),
        { ok: false, error: "missing_token" },
    );
});

test("retention defaults to the three-class policy and shard defaults to primary", () => {
    const resolved = resolveBackupConfig(configured());
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.config.retentionDays, DEFAULT_RETENTION_DAYS);
    assert.equal(resolved.config.shardId, "primary");
});

test("retention overrides accept numeric strings and ignore junk", () => {
    const resolved = resolveBackupConfig(configured({
        BACKUP_RETENTION_DAILY_DAYS: "7",
        BACKUP_RETENTION_WEEKLY_DAYS: "not-a-number",
        BACKUP_RETENTION_MONTHLY_DAYS: 0,
        SHARD_ID: "shard-2",
    }));
    assert.equal(resolved.ok, true);
    assert.equal(resolved.config.retentionDays.daily, 7);
    assert.equal(resolved.config.retentionDays.weekly, DEFAULT_RETENTION_DAYS.weekly);
    assert.equal(resolved.config.retentionDays.monthly, DEFAULT_RETENTION_DAYS.monthly);
    assert.equal(resolved.config.shardId, "shard-2");
});

test("validateBackupTarget accepts the real pair and rejects copy-paste mistakes", () => {
    assert.deepEqual(
        validateBackupTarget({ databaseId: "5f3e1c0a-9b2d-4e7a-8c61-1d2e3f4a5b6c", accountId: "0123456789abcdef0123456789abcdef" }),
        { ok: true },
    );
    assert.deepEqual(
        validateBackupTarget({ databaseId: "one-mail-db", accountId: "0123456789abcdef0123456789abcdef" }),
        { ok: false, reason: "invalid_database_id" },
    );
    assert.deepEqual(
        validateBackupTarget({ databaseId: "5f3e1c0a-9b2d-4e7a-8c61-1d2e3f4a5b6c", accountId: "deadbeef" }),
        { ok: false, reason: "invalid_account_id" },
    );
});
