/**
 * `backup_runs` ledger. Every write is fail-open: the backup itself must not
 * fail because the ledger row could not be written. A null run id means the
 * table is unavailable (migration not applied) or the insert failed.
 */

import type { BackupKind } from "./keys.ts";

export type BackupRunStatus = "running" | "success" | "failed";

export type BackupRunRow = {
    id: number;
    kind: string;
    status: string;
    object_key: string | null;
    bytes: number | null;
    started_at: number;
    finished_at: number | null;
    error: string | null;
};

type D1Binding = Pick<D1Database, "prepare">;
type LedgerEnv = { DB: D1Binding };

export async function startBackupRun(
    env: LedgerEnv,
    kind: BackupKind,
    nowMs: number = Date.now(),
): Promise<number | null> {
    try {
        const result = await env.DB.prepare(
            `INSERT INTO backup_runs (kind, status, started_at) VALUES (?, 'running', ?)`,
        ).bind(kind, nowMs).run();
        const lastRowId = (result.meta as { last_row_id?: unknown } | undefined)?.last_row_id;
        return Number.isSafeInteger(lastRowId) ? Number(lastRowId) : null;
    } catch (error) {
        console.error("backup run ledger insert failed", error);
        return null;
    }
}

export async function finishBackupRun(
    env: LedgerEnv,
    id: number,
    outcome: {
        status: Exclude<BackupRunStatus, "running">;
        objectKey?: string | null;
        bytes?: number | null;
        error?: string | null;
        nowMs?: number;
    },
): Promise<void> {
    try {
        await env.DB.prepare(
            `UPDATE backup_runs
                SET status = ?, object_key = ?, bytes = ?, error = ?, finished_at = ?
              WHERE id = ?`,
        ).bind(
            outcome.status,
            outcome.objectKey ?? null,
            outcome.bytes ?? null,
            outcome.error ? outcome.error.slice(0, 500) : null,
            outcome.nowMs ?? Date.now(),
            id,
        ).run();
    } catch (error) {
        console.error("backup run ledger update failed", error);
    }
}

/**
 * Returns 0 when there is no successful run, and null when the ledger table is
 * unavailable. The distinction matters: a missing table must not make the cron
 * retry an expensive export every ten minutes.
 */
export async function lastSuccessfulBackupAt(env: LedgerEnv): Promise<number | null> {
    try {
        const value = await env.DB.prepare(
            `SELECT MAX(finished_at) AS at FROM backup_runs WHERE status = 'success'`,
        ).first<number | null>("at");
        return Number(value) || 0;
    } catch (error) {
        console.error("backup run ledger unavailable", error);
        return null;
    }
}

export async function listRecentBackupRuns(env: LedgerEnv, limit = 20): Promise<BackupRunRow[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
    try {
        const { results } = await env.DB.prepare(
            `SELECT id, kind, status, object_key, bytes, started_at, finished_at, error
               FROM backup_runs ORDER BY id DESC LIMIT ?`,
        ).bind(bounded).all<BackupRunRow>();
        return results ?? [];
    } catch (error) {
        console.error("backup run ledger list failed", error);
        return [];
    }
}
