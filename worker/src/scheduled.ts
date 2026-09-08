import { Context } from 'hono';
import { cleanup } from './common'
import { CONSTANTS } from './constants'
import { getJsonSetting } from './utils';
import { CleanupSettings } from './models';
import { executeCustomSqlCleanup } from './admin_api/cleanup_api';
import { cleanupReadEmails, purgeOldEmailBodies } from './unified/retention';

const RETENTION_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RETENTION_KEY = "one-mail:retention:last-run";

export async function scheduled(event: ScheduledEvent, env: Bindings, ctx: any) {
    console.log("Scheduled event: ", event);
    // Retention scans are expensive on D1. Run at most once per six hours even when
    // the cron trigger fires every ten minutes; KV is already a production binding.
    let runRetention = true;
    if (env.KV) {
        const last = Number(await env.KV.get(RETENTION_KEY) || 0);
        runRetention = !last || Date.now() - last >= RETENTION_COOLDOWN_MS;
        if (runRetention) {
            await env.KV.put(RETENTION_KEY, String(Date.now()), { expirationTtl: 24 * 60 * 60 });
        }
    }
    const autoCleanupSetting = await getJsonSetting<CleanupSettings>(
        { env: env, } as Context<HonoCustomType>,
        CONSTANTS.AUTO_CLEANUP_KEY
    );
    // one-mail: 自动清理 30 天以前非星标邮件的正文，保护 D1 存储配额
    if (!runRetention) {
        console.log("one-mail retention skipped (cooldown)");
    }
    if (runRetention) try {
        const p = await purgeOldEmailBodies(env, 30);
        console.log("one-mail body retention purge:", JSON.stringify(p));
    } catch (e) {
        console.error("one-mail body retention purge error", e);
    }
    // one-mail: 清理 90 天前已读的统一邮件（受同一冷却窗口保护）
    if (runRetention) try {
        const r = await cleanupReadEmails(env, 90);
        console.log("one-mail retention cleanup:", JSON.stringify(r));
    } catch (e) {
        console.error("one-mail retention cleanup error", e);
    }
    if (!autoCleanupSetting) {
        console.log("No auto cleanup settings found, skipping cleanup.");
        return;
    }
    console.log("autoCleanupSetting:", JSON.stringify(autoCleanupSetting));
    if (autoCleanupSetting.enableMailsAutoCleanup) {
        await cleanup(
            { env: env, } as Context<HonoCustomType>,
            "mails",
            autoCleanupSetting.cleanMailsDays
        );
    }
    if (autoCleanupSetting.enableUnknowMailsAutoCleanup) {
        await cleanup(
            { env: env, } as Context<HonoCustomType>,
            "mails_unknow",
            autoCleanupSetting.cleanUnknowMailsDays
        );
    }
    if (autoCleanupSetting.enableSendBoxAutoCleanup) {
        await cleanup(
            { env: env, } as Context<HonoCustomType>,
            "sendbox",
            autoCleanupSetting.cleanSendBoxDays
        );
    }
    if (autoCleanupSetting.enableInactiveAddressAutoCleanup) {
        await cleanup(
            { env: env, } as Context<HonoCustomType>,
            "inactiveAddress",
            autoCleanupSetting.cleanInactiveAddressDays
        );
    }
    if (autoCleanupSetting.enableAddressAutoCleanup) {
        await cleanup(
            { env: env, } as Context<HonoCustomType>,
            "addressCreated",
            autoCleanupSetting.cleanAddressDays
        );
    }
    if (autoCleanupSetting.enableUnboundAddressAutoCleanup) {
        await cleanup(
            { env: env, } as Context<HonoCustomType>,
            "unboundAddress",
            autoCleanupSetting.cleanUnboundAddressDays
        );
    }
    if (autoCleanupSetting.enableEmptyAddressAutoCleanup) {
        await cleanup(
            { env: env, } as Context<HonoCustomType>,
            "emptyAddress",
            autoCleanupSetting.cleanEmptyAddressDays
        );
    }
    // Execute custom SQL cleanup tasks
    if (autoCleanupSetting.customSqlCleanupList && autoCleanupSetting.customSqlCleanupList.length > 0) {
        for (const customSql of autoCleanupSetting.customSqlCleanupList) {
            if (customSql.enabled && customSql.sql) {
                const result = await executeCustomSqlCleanup(
                    { env: env, } as Context<HonoCustomType>,
                    customSql
                );
                if (!result.success) {
                    console.error(`Custom SQL cleanup [${customSql.name}] failed: ${result.error}`);
                }
            }
        }
    }
}
