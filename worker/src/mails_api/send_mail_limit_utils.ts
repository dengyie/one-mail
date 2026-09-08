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

const getDailyCountKey = (date: Date = new Date()): string => {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    return `${CONSTANTS.SEND_MAIL_LIMIT_COUNT_KEY_PREFIX}daily:${yyyy}-${mm}-${dd}`;
}

const getMonthlyCountKey = (date: Date = new Date()): string => {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${CONSTANTS.SEND_MAIL_LIMIT_COUNT_KEY_PREFIX}monthly:${yyyy}-${mm}`;
}

const releaseCount = async (
    c: Context<HonoCustomType>,
    key: string,
): Promise<void> => {
    await c.env.DB.prepare(
        "UPDATE settings SET " +
        "value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) - 1 AS TEXT), " +
        "updated_at = datetime('now') " +
        "WHERE key = ? " +
        "AND MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) > 0"
    ).bind(key).run();
};

const releaseReservedCounts = async (
    c: Context<HonoCustomType>,
    keys: string[],
): Promise<void> => {
    for (const key of keys.reverse()) {
        try {
            await releaseCount(c, key);
        } catch (error) {
            // The provider error remains the primary failure. A release failure is
            // logged so operators can repair a leaked reservation without hiding it.
            console.error(`Failed to release send mail limit reservation for ${key}`, error);
        }
    }
};

export type SendMailLimitReservation = () => Promise<void>;

/**
 * Atomically reserve one daily/monthly quota slot before dispatching mail.
 *
 * The conditional UPSERT serializes competing requests on each counter row, so
 * concurrent sends cannot all pass a read-then-increment check. A reservation is
 * released only when the downstream provider rejects the dispatch; on success it
 * remains as the committed send count.
 */
export const reserveSendMailLimit = async (
    c: Context<HonoCustomType>
): Promise<SendMailLimitReservation | null> => {
    const msgs = i18n.getMessagesbyContext(c);
    const config = await getSendMailLimitConfig(c);
    if (!config || (!config.dailyEnabled && !config.monthlyEnabled)) {
        return null;
    }

    const dailyKey = getDailyCountKey();
    const monthlyKey = getMonthlyCountKey();
    const reservedKeys: string[] = [];
    try {
        if (config.dailyEnabled && config.dailyLimit !== null && config.dailyLimit !== -1) {
            const limit = config.dailyLimit;
            if (limit === 0 || !(await reserveCount(c, dailyKey, limit))) {
                throw new SendMailLimitError(msgs.ServerSendMailDailyLimitMsg);
            }
            reservedKeys.push(dailyKey);
        }
        if (config.monthlyEnabled && config.monthlyLimit !== null && config.monthlyLimit !== -1) {
            const limit = config.monthlyLimit;
            if (limit === 0 || !(await reserveCount(c, monthlyKey, limit))) {
                throw new SendMailLimitError(msgs.ServerSendMailMonthlyLimitMsg);
            }
            reservedKeys.push(monthlyKey);
        }

        let released = false;
        return async () => {
            if (released) return;
            released = true;
            await releaseReservedCounts(c, reservedKeys);
        };
    } catch (error) {
        await releaseReservedCounts(c, reservedKeys);
        if (error instanceof SendMailLimitError) {
            throw error;
        }
        console.error("Failed to reserve send mail limit", error);
        // Fail closed when the quota reservation itself cannot be evaluated.
        throw new Error(msgs.OperationFailedMsg);
    }
};

const reserveCount = async (
    c: Context<HonoCustomType>,
    key: string,
    limit: number,
): Promise<boolean> => {
    const result = await c.env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES (?, '1') " +
        "ON CONFLICT(key) DO UPDATE SET " +
        "value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) + 1 AS TEXT), " +
        "updated_at = datetime('now') " +
        "WHERE MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) < ?"
    ).bind(key, limit).run();
    return Number(result.meta?.changes ?? 0) > 0;
};
