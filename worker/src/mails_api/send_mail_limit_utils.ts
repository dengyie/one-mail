import type { Context } from "hono";
import i18n from "../i18n/index.ts";
import type { SendMailLimitConfig } from "../models/index.ts";
import { CONSTANTS } from "../constants.ts";
import { getJsonObjectValue, getSetting } from "../utils.ts";

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
        "expires_at INTEGER NOT NULL, " +
        "dispatch_state TEXT NOT NULL DEFAULT 'pending' CHECK (dispatch_state IN ('pending', 'unknown', 'sent')), " +
        "idempotency_key TEXT, " +
        "request_hash TEXT, " +
        "sender_address TEXT, " +
        "sender_address_id TEXT, " +
        "balance_reserved INTEGER NOT NULL DEFAULT 0, " +
        "balance_refunded INTEGER NOT NULL DEFAULT 0" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_send_mail_limit_reservations_expiry " +
        "ON send_mail_limit_reservations(status, dispatch_state, expires_at)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_send_mail_limit_reservations_idempotency " +
        "ON send_mail_limit_reservations(idempotency_key) WHERE idempotency_key IS NOT NULL",
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
        "WHEN OLD.status = 'active' AND NEW.status = 'released' AND OLD.dispatch_state = 'pending' BEGIN " +
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

type ExistingReservation = {
    id: string;
    request_hash: string | null;
    status: "active" | "committed" | "released";
    dispatch_state: "pending" | "unknown" | "sent";
    sender_address?: string | null;
    sender_address_id?: string | number | null;
    balance_reserved?: number;
    balance_refunded?: number;
};

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
            "WHERE status = 'active' AND dispatch_state = 'pending' AND expires_at <= ? " +
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
    let committed = 0;
    try {
        const committedResult = await env.DB.prepare(
            "UPDATE send_mail_limit_reservations SET status = 'committed', updated_at = ? " +
            "WHERE status = 'active' AND dispatch_state = 'sent'"
        ).bind(now).run();
        committed = resultChanges(committedResult);
    } catch (error) {
        // Promotion is safe to retry; retaining an active sent row preserves quota.
        console.error("Failed to promote sent reservation", error);
    }
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

export type UnknownSendMailReservation = {
    id: string;
    sender_address: string | null;
    sender_address_id: string | number | null;
    balance_reserved: number;
    balance_refunded: number;
    idempotency_key: string | null;
    created_at: number;
    updated_at: number;
    expires_at: number;
};

export const listUnknownSendMailReservations = async (
    db: D1Database,
    limit = 100,
): Promise<UnknownSendMailReservation[]> => {
    await ensureSendMailLimitReservationSchema(db);
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), 100);
    const result = await db.prepare(
        "SELECT id, sender_address, sender_address_id, balance_reserved, balance_refunded, idempotency_key, created_at, updated_at, expires_at " +
        "FROM send_mail_limit_reservations WHERE status = 'active' AND dispatch_state = 'unknown' " +
        "ORDER BY updated_at ASC, id ASC LIMIT ?"
    ).bind(safeLimit).all<UnknownSendMailReservation>();
    return result.results ?? [];
};

export const countUnknownSendMailReservations = async (db: D1Database): Promise<number> => {
    await ensureSendMailLimitReservationSchema(db);
    const row = await db.prepare(
        "SELECT COUNT(*) AS count FROM send_mail_limit_reservations WHERE status = 'active' AND dispatch_state = 'unknown'"
    ).first<{ count: number }>();
    return Number(row?.count ?? 0);
};

export const resolveUnknownSendMailReservation = async (
    c: Context<HonoCustomType>,
    id: string,
    outcome: "sent" | "rejected",
): Promise<{ status: "sent" | "released" | "already_resolved" | "not_found"; refundAddress?: string; refundAddressId?: string | number }> => {
    await ensureSendMailLimitReservationSchema(c.env.DB);
    const row = await c.env.DB.prepare(
        "SELECT status, dispatch_state, sender_address, sender_address_id, balance_reserved, balance_refunded FROM send_mail_limit_reservations WHERE id = ?"
    ).bind(id).first<{ status: string; dispatch_state: string; sender_address: string | null; sender_address_id: string | number | null; balance_reserved: number; balance_refunded: number }>();
    if (!row) return { status: "not_found" };
    if (row.status === "released" && row.balance_reserved === 1 && row.balance_refunded === 0 && outcome === "rejected") {
        return { status: "released", refundAddress: row.sender_address ?? undefined, refundAddressId: row.sender_address_id ?? undefined };
    }
    if (row.status !== "active" || row.dispatch_state !== "unknown") return { status: "already_resolved" };
    if (outcome === "sent") {
        const result = await c.env.DB.prepare(
            "UPDATE send_mail_limit_reservations SET dispatch_state = 'sent', status = 'committed', updated_at = ? " +
            "WHERE id = ? AND status = 'active' AND dispatch_state = 'unknown'"
        ).bind(Date.now(), id).run();
        return resultChanges(result) === 1 ? { status: "sent" } : { status: "already_resolved" };
    }
    // The release trigger only decrements counters for pending rows. Reset the
    // state and release in one D1 batch so an unknown delivery is refunded only
    // after an operator explicitly confirms that it was rejected.
    const results = await c.env.DB.batch([
        c.env.DB.prepare(
            "UPDATE send_mail_limit_reservations SET dispatch_state = 'pending', updated_at = ? " +
            "WHERE id = ? AND status = 'active' AND dispatch_state = 'unknown'"
        ).bind(Date.now(), id),
        c.env.DB.prepare(
            "UPDATE send_mail_limit_reservations SET status = 'released', updated_at = ? " +
            "WHERE id = ? AND status = 'active' AND dispatch_state = 'pending'"
        ).bind(Date.now(), id),
    ]);
    const released = resultChanges(results[1]);
    return released === 1
        ? { status: "released", refundAddress: row.balance_reserved === 1 && row.balance_refunded === 0 ? (row.sender_address ?? undefined) : undefined, refundAddressId: row.balance_reserved === 1 && row.balance_refunded === 0 ? (row.sender_address_id ?? undefined) : undefined }
        : { status: "already_resolved" };
};

export const refundResolvedSendMailBalance = async (
    c: Context<HonoCustomType>,
    id: string,
    address: string,
    addressId: string | number,
): Promise<boolean> => {
    await ensureSendMailLimitReservationSchema(c.env.DB);
    const results = await c.env.DB.batch([
        c.env.DB.prepare(
            "UPDATE address_sender SET balance = balance + 1 WHERE address = ? AND EXISTS (" +
            "SELECT 1 FROM send_mail_limit_reservations r JOIN address a ON a.id = r.sender_address_id AND a.name = r.sender_address " +
            "WHERE r.id = ? AND r.sender_address_id = ? AND r.status = 'released' AND r.balance_reserved = 1 AND r.balance_refunded = 0)"
        ).bind(address, id, addressId),
        c.env.DB.prepare(
            "UPDATE send_mail_limit_reservations SET balance_refunded = 1, updated_at = ? " +
            "WHERE id = ? AND status = 'released' AND balance_reserved = 1 AND balance_refunded = 0 " +
            "AND EXISTS (SELECT 1 FROM address_sender WHERE address = ?) " +
            "AND EXISTS (SELECT 1 FROM address a WHERE a.id = ? AND a.name = ?)"
        ).bind(Date.now(), id, address, addressId),
    ]);
    return resultChanges(results[1]) === 1;
};

export class SendMailDeliveryUnknownError extends Error {
    readonly status = 503;
    readonly code = "delivery_unknown";
    constructor() {
        super("Mail delivery status is unknown; reuse the same idempotency key to query the result.");
        this.name = "SendMailDeliveryUnknownError";
    }
}

export class SendMailIdempotencyConflictError extends Error {
    readonly status = 409;
    readonly code = "idempotency_conflict";
    constructor() {
        super("The idempotency key was already used for a different request.");
        this.name = "SendMailIdempotencyConflictError";
    }
}

export const hashSendMailRequest = async (value: unknown): Promise<string> => {
    const encoded = new TextEncoder().encode(JSON.stringify(value) ?? "");
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export type SendMailLimitReservation = {
    replay?: "sent" | "unknown";
    markDispatchStarted: () => Promise<void>;
    markDispatchSucceeded: () => Promise<void>;
    markBalanceReserved: (address: string, addressId: string | number) => Promise<void>;
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
        "WHERE id = ? AND status = 'active' AND " +
        "(dispatch_state = CASE WHEN ? = 'committed' THEN 'sent' ELSE 'pending' END)"
    ).bind(status, Date.now(), id, status).run();
};

const updateDispatchState = async (c: Context<HonoCustomType>, id: string, state: "unknown" | "sent", expected: "pending" | "unknown") => {
    await c.env.DB.prepare(
        "UPDATE send_mail_limit_reservations SET dispatch_state = ?, updated_at = ? WHERE id = ? AND status = 'active' AND dispatch_state = ?"
    ).bind(state, Date.now(), id, expected).run();
};

const markBalanceReserved = async (c: Context<HonoCustomType>, id: string, address: string, addressId: string | number) => {
    await c.env.DB.prepare(
        "UPDATE send_mail_limit_reservations SET sender_address = ?, sender_address_id = ?, balance_reserved = 1, balance_refunded = 0, updated_at = ? WHERE id = ? AND status = 'active' AND balance_reserved = 0"
    ).bind(address, addressId, Date.now(), id).run();
};

/**
 * Atomically reserve the daily/monthly quota slots and persist the reservation
 * before a provider call. The INSERT ... SELECT guard and its triggers execute
 * as one SQLite write. D1 serializes writes to a database, so concurrent sends
 * cannot all pass a read-then-increment check. Failed/abandoned active rows are
 * released by the request path or by the scheduled reconciler.
 */
export const reserveSendMailLimit = async (
    c: Context<HonoCustomType>,
    options: { idempotencyKey?: string; requestHash?: string } = {}
): Promise<SendMailLimitReservation | null> => {
    const msgs = i18n.getMessagesbyContext(c);
    const config = await getStrictSendMailLimitConfig(c);
    const idempotencyKey = options.idempotencyKey?.trim() || null;
    const requestHash = options.requestHash || null;
    if (idempotencyKey && !requestHash) throw new SendMailIdempotencyConflictError();
    if (!config || (!config.dailyEnabled && !config.monthlyEnabled)) {
        if (!idempotencyKey) return null;
    }

    const dailyLimit = config?.dailyEnabled &&
        config.dailyLimit !== null && config.dailyLimit !== -1
        ? config.dailyLimit : null;
    const monthlyLimit = config?.monthlyEnabled &&
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
        if (idempotencyKey) {
            const existing = await c.env.DB.prepare("SELECT id, request_hash, status, dispatch_state, sender_address, balance_reserved, balance_refunded FROM send_mail_limit_reservations WHERE idempotency_key = ?").bind(idempotencyKey).first<ExistingReservation>();
            if (existing) {
                if (existing.request_hash !== requestHash) throw new SendMailIdempotencyConflictError();
                if (existing.status === "committed" || existing.dispatch_state === "sent") return { replay: "sent", markDispatchStarted: async()=>{}, markDispatchSucceeded: async()=>{}, markBalanceReserved: async()=>{}, commit: async()=>{}, release: async()=>{} };
                if (existing.dispatch_state === "unknown" || existing.status === "active") return { replay: "unknown", markDispatchStarted: async()=>{}, markDispatchSucceeded: async()=>{}, markBalanceReserved: async()=>{}, commit: async()=>{}, release: async()=>{} };
                await c.env.DB.prepare("DELETE FROM send_mail_limit_reservations WHERE id = ? AND status = 'released'").bind(existing.id).run();
            }
        }
        const result = await c.env.DB.prepare(
            "INSERT INTO send_mail_limit_reservations " +
            "(id, daily_key, monthly_key, daily_limit, monthly_limit, status, created_at, updated_at, expires_at, dispatch_state, idempotency_key, request_hash) " +
            "SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ?, 'pending', ?, ? " +
            "WHERE (? IS NULL OR CAST(COALESCE((" +
                "SELECT value FROM settings WHERE key = ?), '0') AS INTEGER) < ?) " +
            "AND (? IS NULL OR CAST(COALESCE((" +
                "SELECT value FROM settings WHERE key = ?), '0') AS INTEGER) < ?)"
        ).bind(
            id, dailyKey, monthlyKey, dailyLimit, monthlyLimit, now, now,
            now + RESERVATION_TTL_MS, idempotencyKey, requestHash,
            dailyKey, dailyKey, dailyLimit,
            monthlyKey, monthlyKey, monthlyLimit
        ).run();

        if (resultChanges(result) <= 0) {
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
            markDispatchStarted: async () => { await updateDispatchState(c, id, "unknown", "pending"); },
            markDispatchSucceeded: async () => { await updateDispatchState(c, id, "sent", "unknown"); },
            markBalanceReserved: async (address: string) => { await markBalanceReserved(c, id, address); },
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
        if (error instanceof SendMailLimitError || error instanceof SendMailIdempotencyConflictError) {
            throw error;
        }
        if (idempotencyKey && error instanceof Error && /unique|constraint/i.test(error.message)) {
            const existing = await c.env.DB.prepare("SELECT id, request_hash, status, dispatch_state FROM send_mail_limit_reservations WHERE idempotency_key = ?").bind(idempotencyKey).first<ExistingReservation>();
            if (existing) {
                if (existing.request_hash !== requestHash) throw new SendMailIdempotencyConflictError();
                if (existing.status === "committed" || existing.dispatch_state === "sent") return { replay: "sent", markDispatchStarted: async()=>{}, markDispatchSucceeded: async()=>{}, markBalanceReserved: async()=>{}, commit: async()=>{}, release: async()=>{} };
                return { replay: "unknown", markDispatchStarted: async()=>{}, markDispatchSucceeded: async()=>{}, markBalanceReserved: async()=>{}, commit: async()=>{}, release: async()=>{} };
            }
        }
        console.error("Failed to reserve send mail limit", error);
        // Fail closed when the quota reservation cannot be evaluated.
        throw new Error(msgs.OperationFailedMsg);
    }
};
