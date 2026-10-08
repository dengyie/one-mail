import { Context } from 'hono';
import { cleanup } from './common'
import { CONSTANTS } from './constants'
import { getJsonSettingStrict } from './utils';
import { CleanupSettings } from './models';
import { executeCustomSqlCleanup } from './admin_api/cleanup_api';
import { cleanupReadEmails, purgeOldEmailBodies } from './unified/retention';
import { pruneTerminalJobs } from './unified/job_pruning';
import { reconcileSendMailLimitReservations, countUnknownSendMailReservations } from './mails_api/send_mail_limit_utils';
import { isShardMode, resolveShardId } from './core/d1_quota.ts';

const RETENTION_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RETENTION_KEY = "one-mail:retention:last-success";
const RETENTION_ATTEMPT_KEY = "one-mail:retention:last-attempt";
const RETENTION_LOCK_NAME = "one-mail:retention";
const RETENTION_LOCK_TTL_MS = 30 * 60 * 1000;
const RETENTION_BATCH_LIMIT = 500;
const RETENTION_MAX_BATCHES = 4;

function retentionNames(env: Bindings): { success: string; attempt: string; lock: string } {
    const suffix = isShardMode(env) ? `:${resolveShardId(env)}` : "";
    return {
        success: `${RETENTION_KEY}${suffix}`,
        attempt: `${RETENTION_ATTEMPT_KEY}${suffix}`,
        lock: `${RETENTION_LOCK_NAME}${suffix}`,
    };
}

function resultChanges(result: D1Result<unknown>): number {
    return Number((result.meta as { changes?: number } | undefined)?.changes ?? 0);
}

async function acquireRetentionLock(env: Bindings, lockName: string): Promise<string | null> {
    const owner = crypto.randomUUID();
    const now = Date.now();
    try {
        const result = await env.DB.prepare(`INSERT INTO scheduled_locks (name, owner, locked_until)
             VALUES (?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
                 owner = excluded.owner,
                 locked_until = excluded.locked_until
             WHERE scheduled_locks.locked_until <= ?`)
            .bind(lockName, owner, now + RETENTION_LOCK_TTL_MS, now).run();
        return resultChanges(result) === 1 ? owner : null;
    } catch (error) {
        console.error("retention lock unavailable; skipping scheduled cleanup", error);
        return null;
    }
}

async function releaseRetentionLock(env: Bindings, lockName: string, owner: string): Promise<void> {
    try {
        await env.DB.prepare(`DELETE FROM scheduled_locks WHERE name = ? AND owner = ?`)
            .bind(lockName, owner).run();
    } catch (error) {
        console.error("retention lock release failed", error);
    }
}

export async function scheduled(event: ScheduledEvent, env: Bindings, ctx: any) {
    console.log("Scheduled event: ", event);
    const names = retentionNames(env);
    const shardMode = isShardMode(env);
    const owner = await acquireRetentionLock(env, names.lock);
    if (!owner) {
        console.log("one-mail retention skipped (lock held or migration pending)");
        return;
    }
    try {
        if (!shardMode) {
            try {
                const quota = await reconcileSendMailLimitReservations(env);
                const unknown = await countUnknownSendMailReservations(env.DB);
                if (quota.released > 0 || quota.purged > 0 || unknown > 0) {
                    console.log("one-mail send quota reconciliation:", JSON.stringify({ ...quota, unknown }));
                }
                if (unknown > 0) {
                    console.warn("one-mail has provider delivery outcomes requiring confirmation", { unknown });
                }
            } catch (error) {
                console.error("one-mail send quota reconciliation failed", error);
            }
        }

        // Without a durable success marker, fail closed instead of running an
        // expensive retention scan on every ten-minute cron invocation.
        if (!env.KV) {
            console.error("one-mail retention skipped (KV binding is required)");
            return;
        }
        const now = Date.now();
        const lastSuccess = Number(await env.KV.get(names.success) || 0);
        const lastAttempt = Number(await env.KV.get(names.attempt) || 0);
        const lastRun = Math.max(
            Number.isFinite(lastSuccess) && lastSuccess > 0 ? lastSuccess : 0,
            Number.isFinite(lastAttempt) && lastAttempt > 0 ? lastAttempt : 0,
        );
        if (lastRun > 0 && now - lastRun < RETENTION_COOLDOWN_MS) {
            console.log("one-mail retention skipped (cooldown)");
            return;
        }
        // Record the attempt before any expensive work. If a cleanup path
        // fails, the marker remains and prevents a ten-minute cron from
        // repeatedly consuming D1 quota until the next retry window.
        await env.KV.put(names.attempt, String(now), { expirationTtl: 24 * 60 * 60 });

        const p = await purgeOldEmailBodies(env, 30, RETENTION_BATCH_LIMIT, RETENTION_MAX_BATCHES);
        console.log("one-mail body retention purge:", JSON.stringify(p));
        const r = await cleanupReadEmails(env, 90, RETENTION_BATCH_LIMIT, RETENTION_MAX_BATCHES);
        console.log("one-mail retention cleanup:", JSON.stringify(r));

        // Terminal job rows used to accumulate forever. Same bounded six-hour
        // window as the mail retention above, so a cron tick can never turn into
        // an unbounded delete pass.
        try {
            const pruned = await pruneTerminalJobs(env);
            if (pruned.mutation > 0 || pruned.outbound > 0) {
                console.log("one-mail terminal job pruning:", JSON.stringify(pruned));
            }
        } catch (error) {
            console.error("one-mail terminal job pruning failed", error);
        }

        // Legacy cleanup is intentionally in the same bounded six-hour window;
        // otherwise auto_cleanup would bypass the retention quota guard.
        // SHARD_MODE D1 has no sendbox/address/raw_mails/settings; skip those paths.
        if (!shardMode) {
            const autoCleanupSetting = await getJsonSettingStrict<CleanupSettings>(
                { env: env, } as Context<HonoCustomType>,
                CONSTANTS.AUTO_CLEANUP_KEY
            );
            if (autoCleanupSetting) {
                console.log("autoCleanupSetting:", JSON.stringify(autoCleanupSetting));
                if (autoCleanupSetting.enableMailsAutoCleanup) {
                    await cleanup({ env: env, } as Context<HonoCustomType>, "mails", autoCleanupSetting.cleanMailsDays);
                }
                if (autoCleanupSetting.enableUnknowMailsAutoCleanup) {
                    await cleanup({ env: env, } as Context<HonoCustomType>, "mails_unknow", autoCleanupSetting.cleanUnknowMailsDays);
                }
                if (autoCleanupSetting.enableSendBoxAutoCleanup) {
                    await cleanup({ env: env, } as Context<HonoCustomType>, "sendbox", autoCleanupSetting.cleanSendBoxDays);
                }
                if (autoCleanupSetting.enableInactiveAddressAutoCleanup) {
                    await cleanup({ env: env, } as Context<HonoCustomType>, "inactiveAddress", autoCleanupSetting.cleanInactiveAddressDays);
                }
                if (autoCleanupSetting.enableAddressAutoCleanup) {
                    await cleanup({ env: env, } as Context<HonoCustomType>, "addressCreated", autoCleanupSetting.cleanAddressDays);
                }
                if (autoCleanupSetting.enableUnboundAddressAutoCleanup) {
                    await cleanup({ env: env, } as Context<HonoCustomType>, "unboundAddress", autoCleanupSetting.cleanUnboundAddressDays);
                }
                if (autoCleanupSetting.enableEmptyAddressAutoCleanup) {
                    await cleanup({ env: env, } as Context<HonoCustomType>, "emptyAddress", autoCleanupSetting.cleanEmptyAddressDays);
                }
                if (autoCleanupSetting.customSqlCleanupList && autoCleanupSetting.customSqlCleanupList.length > 0) {
                    for (const customSql of autoCleanupSetting.customSqlCleanupList) {
                        if (customSql.enabled && customSql.sql) {
                            const result = await executeCustomSqlCleanup(
                                { env: env, } as Context<HonoCustomType>,
                                customSql
                            );
                            if (!result.success) {
                                throw new Error(`Custom SQL cleanup [${customSql.name}] failed: ${result.error}`);
                            }
                        }
                    }
                }
            } else {
                console.log("No auto cleanup settings found, skipping cleanup.");
            }
        }

        // Record success only after every bounded cleanup path completed.
        await env.KV.put(names.success, String(Date.now()), { expirationTtl: 24 * 60 * 60 });
    } catch (error) {
        console.error("one-mail scheduled cleanup failed; next run may retry", error);
    } finally {
        await releaseRetentionLock(env, names.lock, owner);
    }
}