/**
 * Backup orchestration: config gate, ledger, export, retention and the restore
 * drill. Every entry point returns a result object instead of throwing so the
 * cron path and the admin endpoints can report a precise state.
 */

import { lastSuccessfulBackupAt, lastBackupAttemptAt, startBackupRun, finishBackupRun, listRecentBackupRuns } from "./backup_runs.ts";
import { resolveBackupConfig, validateBackupTarget, type BackupConfig } from "./config.ts";
import { exportD1ToBucket, type D1ExportDeps } from "./d1_export.ts";
import { backupObjectKey, selectBackupKind, type BackupKind } from "./keys.ts";
import { pruneBackups } from "./retention.ts";

export const BACKUP_COOLDOWN_MS = 20 * 60 * 60 * 1000;
// The scheduled trigger fires every ten minutes. Without a separate retry gate a
// persistently failing export (bad token, wrong target, D1 API outage) would run
// ~144 times a day; one hour between attempts caps it at ~24.
export const BACKUP_RETRY_COOLDOWN_MS = 60 * 60 * 1000;
const VERIFY_HEAD_BYTES = 4096;

export type BackupRunResult = {
    enabled: boolean;
    ok: boolean;
    kind?: BackupKind;
    key?: string;
    bytes?: number;
    pruned?: number;
    skipped?: "disabled" | "cooldown" | "retry_cooldown" | "ledger_unavailable";
    error?: string;
};

export type BackupVerifyResult = {
    enabled: boolean;
    ok: boolean;
    key?: string;
    bytes?: number;
    checkedBytes?: number;
    error?: string;
};

export function shouldRunScheduledBackup(lastSuccessAt: number, nowMs: number): boolean {
    if (!Number.isFinite(lastSuccessAt) || lastSuccessAt <= 0) return true;
    return nowMs - lastSuccessAt >= BACKUP_COOLDOWN_MS;
}

export function shouldRetryScheduledBackup(lastAttemptAt: number, nowMs: number): boolean {
    if (!Number.isFinite(lastAttemptAt) || lastAttemptAt <= 0) return true;
    return nowMs - lastAttemptAt >= BACKUP_RETRY_COOLDOWN_MS;
}

export async function runD1Backup(
    env: Bindings,
    options: {
        kind?: BackupKind;
        now?: Date;
        fetchImpl?: typeof fetch;
        sleep?: D1ExportDeps["sleep"];
    } = {},
): Promise<BackupRunResult> {
    const resolved = resolveBackupConfig(env);
    if (!resolved.ok) {
        return { enabled: false, ok: false, skipped: "disabled", error: resolved.error };
    }
    const config = resolved.config;
    const target = validateBackupTarget(config);
    if (!target.ok) {
        return { enabled: true, ok: false, error: target.reason };
    }

    const now = options.now ?? new Date();
    const kind = options.kind ?? selectBackupKind(now);
    const key = backupObjectKey(kind, now);
    const exportDeps: D1ExportDeps = {
        fetch: options.fetchImpl ?? fetch,
        sleep: options.sleep,
    };

    const runId = await startBackupRun(env, kind, now.getTime());
    let bytes: number;
    try {
        bytes = await exportD1ToBucket(config, key, exportDeps);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("one-mail d1 backup failed", message);
        if (runId !== null) {
            await finishBackupRun(env, runId, { status: "failed", objectKey: key, error: message });
        }
        return { enabled: true, ok: false, kind, key, error: message };
    }

    if (runId !== null) {
        await finishBackupRun(env, runId, { status: "success", objectKey: key, bytes });
    }

    let pruned = 0;
    try {
        const result = await pruneBackups(config.bucket, config.retentionDays, now);
        pruned = result.deleted;
    } catch (error) {
        // Retention is best-effort; the snapshot itself already succeeded.
        console.error("one-mail backup retention failed", error);
    }

    return { enabled: true, ok: true, kind, key, bytes, pruned };
}

export async function maybeRunScheduledBackup(
    env: Bindings,
    options: {
        now?: Date;
        fetchImpl?: typeof fetch;
        sleep?: D1ExportDeps["sleep"];
    } = {},
): Promise<BackupRunResult> {
    const resolved = resolveBackupConfig(env);
    if (!resolved.ok) {
        return { enabled: false, ok: false, skipped: "disabled", error: resolved.error };
    }
    const now = options.now ?? new Date();
    const lastSuccess = await lastSuccessfulBackupAt(env);
    if (lastSuccess === null) {
        return { enabled: true, ok: false, skipped: "ledger_unavailable" };
    }
    if (!shouldRunScheduledBackup(lastSuccess, now.getTime())) {
        return { enabled: true, ok: true, skipped: "cooldown" };
    }
    // Success is old (or there is none): gate the retry on the newest attempt of
    // any status so a failing export cannot burn the D1 export API on every tick.
    // An explicit admin-triggered run bypasses this by calling runD1Backup.
    const lastAttempt = await lastBackupAttemptAt(env);
    if (lastAttempt === null) {
        return { enabled: true, ok: false, skipped: "ledger_unavailable" };
    }
    if (!shouldRetryScheduledBackup(lastAttempt, now.getTime())) {
        return { enabled: true, ok: true, skipped: "retry_cooldown" };
    }
    return runD1Backup(env, options);
}

/**
 * Restore drill: read the newest successful object and prove it is a SQL dump
 * rather than an empty or truncated file. Reads only the header range.
 */
export async function verifyLatestBackup(env: Bindings): Promise<BackupVerifyResult> {
    const resolved = resolveBackupConfig(env);
    if (!resolved.ok) {
        return { enabled: false, ok: false, error: resolved.error };
    }
    const runs = await listRecentBackupRuns(env, 20);
    const latest = runs.find((run) => run.status === "success" && run.object_key);
    if (!latest || !latest.object_key) {
        return { enabled: true, ok: false, error: "no_successful_backup" };
    }
    try {
        const object = await resolved.config.bucket.get(latest.object_key, {
            range: { offset: 0, length: VERIFY_HEAD_BYTES },
        });
        if (!object) {
            return { enabled: true, ok: false, key: latest.object_key, error: "object_missing" };
        }
        const head = new TextDecoder().decode(await object.arrayBuffer());
        const looksLikeSqlDump = /CREATE TABLE|BEGIN TRANSACTION|PRAGMA/i.test(head);
        return {
            enabled: true,
            ok: looksLikeSqlDump,
            key: latest.object_key,
            bytes: object.size,
            checkedBytes: head.length,
            error: looksLikeSqlDump ? undefined : "not_sql_dump",
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("one-mail backup verify failed", message);
        return { enabled: true, ok: false, key: latest.object_key, error: message };
    }
}

export type { BackupConfig };
