/**
 * Aggregator account health: the single data source for the admin status page
 * (/admin/health). The aggregator POSTs a per-account snapshot + daemon
 * heartbeat here (change-driven + 15min heartbeat, throttled aggregator-side);
 * static config.json accounts (qq-main etc., no user_mail_accounts row) are
 * finally visible alongside user-managed ones.
 *
 * Diagnostic endpoint style, aligned with deployment_api: always answers 200
 * with a report so an operator can read the failure instead of a bare 500.
 * x-admin-auth on /admin/* is the only access control; rows carry no secrets
 * beyond usernames already visible in the admin mail-accounts UI.
 */
import type { Context } from "hono";

const MAX_ERROR_LENGTH = 500;

const VALID_ERROR_KINDS = new Set([
    "", "auth", "conn", "proxy", "quota", "ratelimit", "persist", "policy",
    "folder", "unknown",
]);

type AccountHealthRow = {
    account_id: string;
    label: string | null;
    source: string | null;
    username: string | null;
    user_managed: number;
    last_sync_at: number | null;
    last_error: string | null;
    error_kind: string | null;
    fail_count: number;
    skip_until: number | null;
    idle_alive: number | null;
    poll_interval_seconds: number | null;
    updated_at: number;
};

type DaemonHeartbeatRow = {
    started_at: number | null;
    accounts_count: number | null;
    socks5_egress: string | null;
    aggregator_version: string | null;
    updated_at: number;
};

type IncomingAccount = {
    account_id?: unknown;
    label?: unknown;
    source?: unknown;
    username?: unknown;
    user_managed?: unknown;
    last_sync_at?: unknown;
    last_error?: unknown;
    error_kind?: unknown;
    fail_count?: unknown;
    skip_until?: unknown;
    idle_alive?: unknown;
    poll_interval_seconds?: unknown;
};

function asString(value: unknown, max = 200): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

function asInt(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return Math.trunc(Number(value));
    }
    return null;
}

/** 心跳超时阈值：超过它认为聚合器 daemon 失联（上报间隔 15min，两倍余量）。 */
const HEARTBEAT_STALE_MS = 30 * 60 * 1000;

export default {
    upsert,
    list,
};

export async function upsert(c: Context<HonoCustomType>) {
    const env = c.env as Bindings;
    const now = Date.now();
    let written = 0;
    try {
        const body = await c.req.json<Record<string, unknown>>();
        const daemon = (body?.daemon ?? null) as Record<string, unknown> | null;
        const accounts = Array.isArray(body?.accounts) ? body.accounts as IncomingAccount[] : [];

        if (daemon) {
            await env.DB.prepare(
                `INSERT INTO aggregator_daemon_heartbeat
                    (id, started_at, accounts_count, socks5_egress, aggregator_version, updated_at)
                 VALUES (1, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                    started_at = excluded.started_at,
                    accounts_count = excluded.accounts_count,
                    socks5_egress = excluded.socks5_egress,
                    aggregator_version = excluded.aggregator_version,
                    updated_at = excluded.updated_at`,
            ).bind(
                asInt(daemon.started_at) ?? now,
                asInt(daemon.accounts_count),
                asString(daemon.socks5_egress, 100),
                asString(daemon.aggregator_version, 50),
                now,
            ).run();
        }

        if (accounts.length > 0) {
            const stmt = env.DB.prepare(
                `INSERT INTO aggregator_account_health
                    (account_id, label, source, username, user_managed,
                     last_sync_at, last_error, error_kind, fail_count,
                     skip_until, idle_alive, poll_interval_seconds, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(account_id) DO UPDATE SET
                    label = excluded.label,
                    source = excluded.source,
                    username = excluded.username,
                    user_managed = excluded.user_managed,
                    last_sync_at = excluded.last_sync_at,
                    last_error = excluded.last_error,
                    error_kind = excluded.error_kind,
                    fail_count = excluded.fail_count,
                    skip_until = excluded.skip_until,
                    idle_alive = excluded.idle_alive,
                    poll_interval_seconds = excluded.poll_interval_seconds,
                    updated_at = excluded.updated_at`,
            );
            // 批量提交：一次 round-trip 写全部账号行（上报 ≤ 每 15min 一次）
            const statements = [];
            for (const account of accounts) {
                if (!account || typeof account !== "object") continue;
                const accountId = asString(account.account_id, 200);
                if (!accountId) continue;
                const errorKindRaw = asString(account.error_kind, 30) ?? "";
                const errorKind = VALID_ERROR_KINDS.has(errorKindRaw) ? errorKindRaw : "unknown";
                const lastError = asString(account.last_error, MAX_ERROR_LENGTH);
                written += 1;
                statements.push(stmt.bind(
                    accountId,
                    asString(account.label, 200),
                    asString(account.source, 50),
                    asString(account.username, 200),
                    account.user_managed === true ? 1 : 0,
                    asInt(account.last_sync_at),
                    lastError,
                    // 有错误但分类缺失时兜底 unknown；健康时置空
                    lastError && !errorKind ? "unknown" : errorKind,
                    asInt(account.fail_count) ?? 0,
                    asInt(account.skip_until),
                    asInt(account.idle_alive),
                    asInt(account.poll_interval_seconds),
                    now,
                ));
            }
            if (statements.length > 0) {
                await env.DB.batch(statements);
            }
        }

        return c.json({ success: true, accounts: written });
    } catch (error) {
        console.error("account_health upsert failed", error);
        return c.json({ success: false, error: "internal error; see Worker logs" }, 500);
    }
}

export async function list(c: Context<HonoCustomType>) {
    const env = c.env as Bindings;
    const now = Date.now();
    try {
        const { results: health } = await env.DB.prepare(
            `SELECT account_id, label, source, username, user_managed,
                    last_sync_at, last_error, error_kind, fail_count,
                    skip_until, idle_alive, poll_interval_seconds, updated_at
             FROM aggregator_account_health
             ORDER BY user_managed ASC, account_id ASC`,
        ).all<AccountHealthRow>();
        const { results: heartbeatRows } = await env.DB.prepare(
            `SELECT started_at, accounts_count, socks5_egress, aggregator_version, updated_at
             FROM aggregator_daemon_heartbeat WHERE id = 1`,
        ).all<DaemonHeartbeatRow>();
        const heartbeat = heartbeatRows?.[0] ?? null;

        // 派生字段：页面据此分级，不用自己算时间
        const daemon_stale = !heartbeat || (now - heartbeat.updated_at) > HEARTBEAT_STALE_MS;
        const accounts = (health ?? []).map((row) => ({
            ...row,
            // 快照本身比心跳更旧 → 这条数据可能已经不代表现状
            fresh: !daemon_stale && (now - row.updated_at) <= HEARTBEAT_STALE_MS,
            breaker_open: (row.skip_until ?? 0) > now,
        }));

        return c.json({
            accounts,
            daemon: heartbeat
                ? { ...heartbeat, stale: daemon_stale, age_ms: now - heartbeat.updated_at }
                : null,
            generated_at: now,
        });
    } catch (error) {
        console.error("account_health list failed", error);
        return c.json({
            accounts: [],
            daemon: null,
            generated_at: now,
            warning: "health query failed; see Worker logs",
        });
    }
}
