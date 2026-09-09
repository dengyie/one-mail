import { Context } from "hono";
import i18n from "../i18n";
import { SendMailLimitConfig } from "../models";
import { CONSTANTS } from "../constants";
import { getJsonObjectValue, getSetting } from "../utils";

class SendMailLimitError extends Error {
    constructor(message: string) {
        super(message);
    }
}

const parseLimitValue = (value: unknown): number | null => {
    if (value === null || typeof value === "undefined") {
        return null;
    }
    if (!Number.isInteger(value) || (value as number) < -1) {
        return null;
    }
    return value as number;
}

const isValidLimitValue = (value: number | null): boolean => {
    return value === -1 || (value !== null && value >= 0);
}

const parseSendMailLimitConfig = (value: unknown): SendMailLimitConfig | null => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const config = value as Record<string, unknown>;
    if (typeof config.dailyEnabled !== "boolean" || typeof config.monthlyEnabled !== "boolean") {
        return null;
    }
    const dailyLimit = parseLimitValue(config.dailyLimit);
    const monthlyLimit = parseLimitValue(config.monthlyLimit);
    const monthlyValid = config.monthlyEnabled
        ? isValidLimitValue(monthlyLimit)
        : (config.monthlyLimit === null || typeof config.monthlyLimit === "undefined" || monthlyLimit !== null);
    const dailyValid = config.dailyEnabled
        ? isValidLimitValue(dailyLimit)
        : (config.dailyLimit === null || typeof config.dailyLimit === "undefined" || dailyLimit !== null);
    if (!dailyValid || !monthlyValid) {
        return null;
    }
    return {
        dailyEnabled: config.dailyEnabled,
        monthlyEnabled: config.monthlyEnabled,
        dailyLimit,
        monthlyLimit,
    };
}

export const validateSendMailLimitConfig = (value: unknown): boolean => {
    return !!parseSendMailLimitConfig(value);
}

export const getSendMailLimitConfigToSave = (
    value: unknown
): SendMailLimitConfig | null => {
    const sendMailLimitConfig = parseSendMailLimitConfig(value);
    if (!sendMailLimitConfig) {
        return null;
    }
    return {
        dailyEnabled: sendMailLimitConfig.dailyEnabled,
        monthlyEnabled: sendMailLimitConfig.monthlyEnabled,
        dailyLimit: sendMailLimitConfig.dailyEnabled ? sendMailLimitConfig.dailyLimit : null,
        monthlyLimit: sendMailLimitConfig.monthlyEnabled ? sendMailLimitConfig.monthlyLimit : null,
    };
}

export const getSendMailLimitConfig = async (
    c: Context<HonoCustomType>
): Promise<SendMailLimitConfig | null> => {
    return getSendMailLimitConfigToSave(getJsonObjectValue<SendMailLimitConfig>(
        await getSetting(c, CONSTANTS.SEND_MAIL_LIMIT_CONFIG_KEY)
    ));
}

/**
 * Read the quota configuration for a send decision without conflating an
 * unavailable database with an intentionally absent setting. The send path
 * must fail closed: a D1 error or malformed stored value never disables the
 * quota guard.
 */
const getStrictSendMailLimitConfig = async (
    c: Context<HonoCustomType>
): Promise<SendMailLimitConfig | null> => {
    let storedValue: string | null;
    try {
        storedValue = await c.env.DB.prepare(
            "SELECT value FROM settings WHERE key = ?"
        ).bind(CONSTANTS.SEND_MAIL_LIMIT_CONFIG_KEY).first<string>("value");
    } catch (error) {
        console.error("Failed to read send mail limit config", error);
        throw error;
    }
    if (storedValue === null) {
        return null;
    }
    const config = getSendMailLimitConfigToSave(
        getJsonObjectValue<SendMailLimitConfig>(storedValue)
    );
    if (!config) {
        throw new Error("Invalid stored send mail limit configuration");
    }
    return config;
}

const getDailyCountKey = (date: Date = new Date()): string => {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    return CONSTANTS.SEND_MAIL_LIMIT_COUNT_KEY_PREFIX + "daily:" +
        yyyy + "-" + mm + "-" + dd;
}

const getMonthlyCountKey = (date: Date = new Date()): string => {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    return CONSTANTS.SEND_MAIL_LIMIT_COUNT_KEY_PREFIX + "monthly:" +
        yyyy + "-" + mm;
}

const RESERVATION_TTL_MS = 15 * 60 * 1000;
const RESERVATION_RECONCILE_BATCH_SIZE = 100;
const RESERVATION_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const RESERVATION_SCHEMA_STATEMENTS = [
    "CREATE TABLE IF NOT EXISTS send_mail_limit_reservations (" +
        "id TEXT PRIMARY KEY, " +
        "daily_key TEXT, " +
        "monthly_key TEXT, " +
        "daily_limit INTEGER, " +
        "monthly_limit INTEGER, " +
        "status TEXT NOT NULL CHECK (status IN ('active', 'committed', 'released')), " +
        "created_at INTEGER NOT NULL, " +
        "updated_at INTEGER NOT NULL, " +
        "expires_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_send_mail_limit_reservations_expiry " +
        "ON send_mail_limit_reservations(status, expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_send_mail_limit_reservations_terminal " +
        "ON send_mail_limit_reservations(status, updated_at)",
    "CREATE TRIGGER IF NOT EXISTS one_mail_send_limit_reservation_increment " +
        "AFTER INSERT ON send_mail_limit_reservations " +
        "WHEN NEW.status = 'active' BEGIN " +
        "INSERT OR IGNORE INTO settings(key, value) " +
            "SELECT NEW.daily_key, '0' WHERE NEW.daily_key IS NOT NULL; " +
        "UPDATE settings SET " +
            "value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) + 1 AS TEXT), " +
            "updated_at = datetime('now') " +
            "WHERE key = NEW.daily_key AND NEW.daily_key IS NOT NULL; " +
        "INSERT OR IGNORE INTO settings(key, value) " +
            "SELECT NEW.monthly_key, '0' WHERE NEW.monthly_key IS NOT NULL; " +
        "UPDATE settings SET " +
            "value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) + 1 AS TEXT), " +
            "updated_at = datetime('now') " +
            "WHERE key = NEW.monthly_key AND NEW.monthly_key IS NOT NULL; " +
        "END",
    "CREATE TRIGGER IF NOT EXISTS one_mail_send_limit_reservation_release " +
        "AFTER UPDATE OF status ON send_mail_limit_reservations " +
        "WHEN OLD.status = 'active' AND NEW.status = 'released' BEGIN " +
        "UPDATE settings SET " +
            "value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) - 1 AS TEXT), " +
            "updated_at = datetime('now') " +
            "WHERE key = OLD.daily_key AND OLD.daily_key IS NOT NULL " +
            "AND MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) > 0; " +
        "UPDATE settings SET " +
            "value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) - 1 AS TEXT), " +
            "updated_at = datetime('now') " +
            "WHERE key = OLD.monthly_key AND OLD.monthly_key IS NOT NULL " +
            "AND MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) > 0; " +
        "END",
];

const schemaReady = new WeakMap<object, Promise<void>>();

export const ensureSendMailLimitReservationSchema = async (
    db: D1Database
): Promise<void> => {
    const dbObject = db as unknown as object;
    const existing = schemaReady.get(dbObject);
    if (existing) {
        return existing;
    }
    const setup = (async () => {
        for (const statement of RESERVATION_SCHEMA_STATEMENTS) {
            await db.prepare(statement).run();
        }
    })();
    schemaReady.set(dbObject, setup);
    try {
        await setup;
    } catch (error) {
        schemaReady.delete(dbObject);
        throw error;
    }
};

const resultChanges = (
    result: { meta?: { changes?: number } } | null | undefined
): number => Number(result?.meta?.changes ?? 0);

const readCounter = async (
    c: Context<HonoCustomType>,
    key: string
): Promise<number> => {
    const value = await c.env.DB.prepare(
        "SELECT value FROM settings WHERE key = ?"
    ).bind(key).first<string>("value");
    const parsed = Number.parseInt(value ?? "0", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const releaseExpiredReservations = async (
    db: D1Database,
    now: number,
    batchLimit: number
): Promise<number> => {
    const result = await db.prepare(
        "UPDATE send_mail_limit_reservations SET status = 'released', updated_at = ? " +
        "WHERE id IN (" +
            "SELECT id FROM send_mail_limit_reservations " +
            "WHERE status = 'active' AND expires_at <= ? " +
            "ORDER BY expires_at, id LIMIT ?" +
        ")"
    ).bind(now, now, batchLimit).run();
    return resultChanges(result);
};

export const reconcileSendMailLimitReservations = async (
    env: Pick<Bindings, "DB">,
    now: number = Date.now(),
    batchLimit: number = RESERVATION_RECONCILE_BATCH_SIZE
): Promise<{ released: number; purged: number }> => {
    await ensureSendMailLimitReservationSchema(env.DB);
    const released = await releaseExpiredReservations(env.DB, now, batchLimit);
    const purgeBefore = now - RESERVATION_TERMINAL_RETENTION_MS;
    const purgedResult = await env.DB.prepare(
        "DELETE FROM send_mail_limit_reservations " +
        "WHERE id IN (" +
            "SELECT id FROM send_mail_limit_reservations " +
            "WHERE status IN ('released', 'committed') AND updated_at < ? " +
            "ORDER BY updated_at, id LIMIT ?" +
        ")"
    ).bind(purgeBefore, batchLimit).run();
    return { released, purged: resultChanges(purgedResult) };
};

export type SendMailLimitReservation = {
    commit: () => Promise<void>;
    release: () => Promise<void>;
};

const updateReservationStatus = async (
    c: Context<HonoCustomType>,
    id: string,
    status: "committed" | "released"
): Promise<void> => {
    await c.env.DB.prepare(
        "UPDATE send_mail_limit_reservations SET status = ?, updated_at = ? " +
        "WHERE id = ? AND status = 'active'"
    ).bind(status, Date.now(), id).run();
};

/**
 * Atomically reserve the daily/monthly quota slots and persist the reservation
 * before a provider call. The INSERT ... SELECT guard and its triggers execute
 * as one SQLite write. D1 serializes writes to a database, so concurrent sends
 * cannot all pass a read-then-increment check. Failed/abandoned active rows are
 * released by the request path or by the scheduled reconciler.
 */
export const reserveSendMailLimit = async (
    c: Context<HonoCustomType>
): Promise<SendMailLimitReservation | null> => {
    const msgs = i18n.getMessagesbyContext(c);
    const config = await getStrictSendMailLimitConfig(c);
    if (!config || (!config.dailyEnabled && !config.monthlyEnabled)) {
        return null;
    }

    const dailyLimit = config.dailyEnabled &&
        config.dailyLimit !== null && config.dailyLimit !== -1
        ? config.dailyLimit : null;
    const monthlyLimit = config.monthlyEnabled &&
        config.monthlyLimit !== null && config.monthlyLimit !== -1
        ? config.monthlyLimit : null;
    const dailyKey = dailyLimit === null ? null : getDailyCountKey();
    const monthlyKey = monthlyLimit === null ? null : getMonthlyCountKey();

    try {
        await ensureSendMailLimitReservationSchema(c.env.DB);
        // Opportunistically release abandoned rows so a failed request does not
        // consume a slot until the next cron invocation.
        await releaseExpiredReservations(c.env.DB, Date.now(), RESERVATION_RECONCILE_BATCH_SIZE);

        const id = crypto.randomUUID();
        const now = Date.now();
        const result = await c.env.DB.prepare(
            "INSERT INTO send_mail_limit_reservations " +
            "(id, daily_key, monthly_key, daily_limit, monthly_limit, status, created_at, updated_at, expires_at) " +
            "SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ? " +
            "WHERE (? IS NULL OR CAST(COALESCE((" +
                "SELECT value FROM settings WHERE key = ?), '0') AS INTEGER) < ?) " +
            "AND (? IS NULL OR CAST(COALESCE((" +
                "SELECT value FROM settings WHERE key = ?), '0') AS INTEGER) < ?)"
        ).bind(
            id, dailyKey, monthlyKey, dailyLimit, monthlyLimit, now, now,
            now + RESERVATION_TTL_MS,
            dailyKey, dailyKey, dailyLimit,
            monthlyKey, monthlyKey, monthlyLimit
        ).run();

        if (resultChanges(result) !== 1) {
            if (dailyLimit !== null && await readCounter(c, dailyKey!) >= dailyLimit) {
                throw new SendMailLimitError(msgs.ServerSendMailDailyLimitMsg);
            }
            if (monthlyLimit !== null && await readCounter(c, monthlyKey!) >= monthlyLimit) {
                throw new SendMailLimitError(msgs.ServerSendMailMonthlyLimitMsg);
            }
            throw new Error(msgs.OperationFailedMsg);
        }

        let settled = false;
        return {
            commit: async () => {
                if (settled) return;
                await updateReservationStatus(c, id, "committed");
                settled = true;
            },
            release: async () => {
                if (settled) return;
                await updateReservationStatus(c, id, "released");
                settled = true;
            },
        };
    } catch (error) {
        if (error instanceof SendMailLimitError) {
            throw error;
        }
        console.error("Failed to reserve send mail limit", error);
        // Fail closed when the quota reservation cannot be evaluated.
        throw new Error(msgs.OperationFailedMsg);
    }
};
