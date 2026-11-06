/**
 * Deployment self-check: a read-only report an operator can hit after a deploy.
 *
 * Every check is boolean plus a short reason — never a secret value, never a
 * query result. The report is advisory: `missing` means the Worker cannot do
 * its job, `warning` means a feature degrades fail-open, `manual` means the
 * signal lives outside the Worker (VPS aggregator, optional bindings).
 *
 * Import-free at runtime except the backup config resolver, so it stays
 * loadable by `node --test`.
 */

import { resolveBackupConfig, validateBackupTarget } from "../backup/config.ts";

export type DeploymentCheckState = "ready" | "missing" | "warning" | "manual";

export type DeploymentCheck = {
    name: string;
    state: DeploymentCheckState;
    detail?: string;
};

export type DeploymentCheckReport = {
    status: "ready" | "warning" | "missing";
    checks: DeploymentCheck[];
};

/** Without these the Worker cannot store or clean mail at all. */
const CORE_TABLES = ["emails", "scheduled_locks"];

/** These degrade fail-open; their absence is worth a warning, not an outage. */
const FEATURE_TABLES = ["audit_logs", "backup_runs"];

async function tableNames(env: Bindings): Promise<Set<string> | null> {
    if (!env.DB) return null;
    try {
        const { results } = await env.DB.prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table'`,
        ).all<{ name: string }>();
        return new Set((results ?? []).map((row) => row.name));
    } catch (error) {
        console.error("deployment check: schema query failed", error);
        return null;
    }
}

export async function collectDeploymentChecks(env: Bindings): Promise<DeploymentCheckReport> {
    const checks: DeploymentCheck[] = [];

    checks.push(env.DB
        ? { name: "d1", state: "ready" }
        : { name: "d1", state: "missing", detail: "DB binding absent" });
    checks.push(env.KV
        ? { name: "kv", state: "ready" }
        : { name: "kv", state: "missing", detail: "KV binding absent" });

    const tables = await tableNames(env);
    if (!tables) {
        checks.push({ name: "tables", state: "warning", detail: "schema query failed" });
    } else {
        const missingCore = CORE_TABLES.filter((table) => !tables.has(table));
        checks.push(missingCore.length > 0
            ? { name: "tables", state: "missing", detail: `missing: ${missingCore.join(", ")}` }
            : { name: "tables", state: "ready", detail: `${tables.size} tables` });

        const missingFeature = FEATURE_TABLES.filter((table) => !tables.has(table));
        checks.push(missingFeature.length > 0
            ? {
                name: "feature_tables",
                state: "warning",
                detail: `missing: ${missingFeature.join(", ")} (those features stay disabled)`,
            }
            : { name: "feature_tables", state: "ready" });
    }

    const backup = resolveBackupConfig(env);
    if (!backup.ok) {
        checks.push({ name: "backup", state: "manual", detail: `disabled: ${backup.error}` });
    } else {
        const target = validateBackupTarget(backup.config);
        checks.push(target.ok
            ? { name: "backup", state: "ready", detail: `configured; shard=${backup.config.shardId}` }
            : { name: "backup", state: "warning", detail: target.reason });
    }

    checks.push(env.AI
        ? { name: "ai", state: "ready" }
        : { name: "ai", state: "manual", detail: "AI binding absent; extraction disabled" });

    checks.push({
        name: "aggregator",
        state: "manual",
        detail: "external VPS process; confirm via report_sync_status",
    });

    const status = checks.some((check) => check.state === "missing")
        ? "missing"
        : checks.some((check) => check.state === "warning")
            ? "warning"
            : "ready";
    return { status, checks };
}