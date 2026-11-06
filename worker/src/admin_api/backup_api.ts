import type { Context } from "hono";

import { resolveAuditActor, resolveAuditIp, writeAudit } from "../core/audit_log.ts";
import { isBackupKind } from "../backup/keys.ts";
import { listRecentBackupRuns } from "../backup/backup_runs.ts";
import { runD1Backup, verifyLatestBackup } from "../backup/backup_service.ts";
import { resolveBackupConfig, validateBackupTarget } from "../backup/config.ts";

export default {
    status: async (c: Context<HonoCustomType>) => {
        const env = c.env as Bindings;
        const resolved = resolveBackupConfig(env);
        if (!resolved.ok) {
            return c.json({ enabled: false, reason: resolved.error, runs: [] });
        }
        const target = validateBackupTarget(resolved.config);
        return c.json({
            enabled: true,
            target_valid: target.ok,
            target_error: target.ok ? null : target.reason,
            shard_id: resolved.config.shardId,
            retention_days: resolved.config.retentionDays,
            runs: await listRecentBackupRuns(env, 20),
        });
    },
    run: async (c: Context<HonoCustomType>) => {
        const env = c.env as Bindings;
        let kind: unknown;
        try {
            const body = await c.req.json<{ kind?: unknown }>();
            kind = body?.kind;
        } catch {
            kind = undefined;
        }
        if (kind !== undefined && kind !== null && !isBackupKind(kind)) {
            return c.json({ error: "invalid_kind" }, 400);
        }
        const result = await runD1Backup(env, { kind: kind ?? undefined });
        // Provenance only — the export itself is described by backup_runs.
        await writeAudit(env, {
            actor: resolveAuditActor(c),
            action: result.ok ? "backup.run" : "backup.run.failed",
            targetType: "backup",
            targetId: result.kind ?? null,
            detail: { object_key: result.key ?? null, bytes: result.bytes ?? null, error: result.error ?? null },
            ip: resolveAuditIp(c),
        });
        return c.json(result, result.ok ? 200 : 503);
    },
    verify: async (c: Context<HonoCustomType>) => {
        const env = c.env as Bindings;
        const result = await verifyLatestBackup(env);
        return c.json(result, result.ok || !result.enabled ? 200 : 503);
    },
};
