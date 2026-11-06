/**
 * Deployment target resolution for the D1 backup path.
 *
 * Production runs with FLEET_MODE=legacy-static across several Workers that
 * each own a different D1 database. Before exporting, the backup run must prove
 * that the configured account/database pair is the one this Worker actually
 * serves; otherwise a shard's snapshot lands under another shard's prefix and
 * the restore drill silently restores the wrong mailbox fleet.
 */

import type { BackupKind } from "./keys.ts";

export type BackupConfigError =
    | "missing_bucket"
    | "missing_account_id"
    | "missing_database_id"
    | "missing_token";

export type BackupConfig = {
    bucket: R2Bucket;
    accountId: string;
    databaseId: string;
    token: string;
    retentionDays: Record<BackupKind, number>;
    shardId: string;
};

export type ResolvedBackupConfig =
    | { ok: true; config: BackupConfig }
    | { ok: false; error: BackupConfigError };

export const DEFAULT_RETENTION_DAYS: Record<BackupKind, number> = {
    daily: 30,
    weekly: 84,
    monthly: 365,
};

const DATABASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function positiveInt(value: string | number | undefined | null, fallback: number): number {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Absent configuration is not an error at boot: it means backups are off for
 * this deployment, and the admin endpoints say so instead of returning 500.
 */
export function resolveBackupConfig(env: Bindings): ResolvedBackupConfig {
    if (!env.BACKUP_BUCKET) return { ok: false, error: "missing_bucket" };
    if (!env.CLOUDFLARE_ACCOUNT_ID) return { ok: false, error: "missing_account_id" };
    if (!env.D1_DATABASE_ID) return { ok: false, error: "missing_database_id" };
    if (!env.D1_REST_API_TOKEN) return { ok: false, error: "missing_token" };
    return {
        ok: true,
        config: {
            bucket: env.BACKUP_BUCKET,
            accountId: env.CLOUDFLARE_ACCOUNT_ID,
            databaseId: env.D1_DATABASE_ID,
            token: env.D1_REST_API_TOKEN,
            retentionDays: {
                daily: positiveInt(env.BACKUP_RETENTION_DAILY_DAYS, DEFAULT_RETENTION_DAYS.daily),
                weekly: positiveInt(env.BACKUP_RETENTION_WEEKLY_DAYS, DEFAULT_RETENTION_DAYS.weekly),
                monthly: positiveInt(env.BACKUP_RETENTION_MONTHLY_DAYS, DEFAULT_RETENTION_DAYS.monthly),
            },
            shardId: env.SHARD_ID || "primary",
        },
    };
}

/**
 * `D1_DATABASE_ID` must be the UUID of the database this Worker writes to.
 * Catches the copy-paste class of mistake (another shard's id, a database name).
 */
export function validateBackupTarget(config: Pick<BackupConfig, "databaseId" | "accountId">):
    { ok: true } | { ok: false; reason: "invalid_database_id" | "invalid_account_id" } {
    if (!DATABASE_ID_PATTERN.test(config.databaseId)) return { ok: false, reason: "invalid_database_id" };
    if (!/^[0-9a-f]{32}$/i.test(config.accountId)) return { ok: false, reason: "invalid_account_id" };
    return { ok: true };
}
