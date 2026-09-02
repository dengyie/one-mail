import { Context } from "hono";

import i18n from "../i18n";
import { checkRegistrationRateLimit, getMaxMailAccountCount } from "../utils";
import { commonGetUserRole } from "../common";
import { encryptCredCtx as encryptCred, decryptCredCtx as decryptCred } from "./cred_crypto";
import { unsupportedMailAccountAction } from "../unified/mail_account_actions";

// 每用户最多可接入的外部邮箱数（全局默认）。外部邮箱不消耗 mangoqwq 域名地址配额
// （maxAddressCount 已在 utils.ts isAddressCountLimitReached 排除 source_meta='external'
// 行），独立计数，防止滥用归集资源。上限可按角色配（role_address_config.maxMailAccountCount），
// 见 utils.ts getMaxMailAccountCount；缺失/负数回退此默认值。

// source 白名单：前端下拉的预设 + 自定义。host/port 由用户填，这里只校验 source 枚举。
const ALLOWED_SOURCES = new Set([
    "imap_gmail", "imap_outlook", "imap_qq", "imap_163", "imap_custom",
]);
const ALLOWED_PROTOCOLS = new Set(["auto", "imap", "pop3"]);

// OAuth provider 白名单（review W1-3）。唯一依据 = aggregator
// `aggregator/src/one_mail_agg/oauth.py` 的 `_TOKEN_FN` 支持集：目前 gmail / outlook
// 两个 provider（其它 provider 在 `oauth_client_factory` 里 `_TOKEN_FN[provider]`
// 会直接 KeyError，冻结整轮聚合器同步）。未知 provider 一律 400 拒绝落库。
// config 侧 provider 字符串由聚合器定义，不属 shared 契约，故内联于此。
const OAUTH_PROVIDERS = new Set(["gmail", "outlook"]);

const parseOptionalBoolean = (value: unknown, fallback: boolean | null): boolean | null | undefined => {
    if (value == null || value === "") return fallback;
    if (typeof value !== "boolean") return undefined;
    return value;
};

const parseOptionalPort = (value: unknown): number | null | undefined => {
    if (value == null || value === "") return null;
    const port = typeof value === "number" ? value : Number(value);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
};

/** Validate the POP3 transport tuple without silently weakening its meaning.
 * SSL and STLS are alternatives: STLS starts on plaintext and upgrades, while
 * SSL starts with TLS.  Plain POP3 remains representable for legacy accounts;
 * callers can distinguish that deliberate configuration as both flags false.
 */
export const validatePop3Settings = (ssl: boolean | null, useStls: boolean, fallbackSsl = true): boolean =>
    !((ssl ?? fallbackSsl) && useStls);

const boundedError = (error: unknown, prefix: string): string => {
    const detail = error instanceof Error ? error.message : String(error);
    return `${prefix}: ${detail}`.slice(0, 200);
};

interface MailAccountRow {
    id: string;
    user_id: number;
    label: string | null;
    source: string;
    host: string;
    port: number;
    username: string;
    cred_enc: string;
    protocol: string;
    folders_json: string | null;
    oauth_enc: string | null;
    // POP3 settings are nullable for compatibility with rows created before
    // the POP3 configuration migration. Null pop3_ssl means inherit use_ssl.
    use_ssl: number | null;
    pop3_host: string | null;
    pop3_port: number | null;
    pop3_ssl: number | null;
    pop3_use_stls: number | null;
    enabled: number;
    last_sync_at: number | null;
    last_error: string | null;
    created_at: number;
}

/** 解析 folders_json，畸形值兜底为 ["INBOX"]——绝不让单条坏数据 500 掉整列。 */
export const safeFolders = (raw: string | null): string[] => {
    if (typeof raw !== "string" || !raw.trim()) return ["INBOX"];
    try {
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value)) return ["INBOX"];
        const folders = value
            .filter((folder): folder is string => typeof folder === "string")
            .map((folder) => folder.trim())
            .filter(Boolean);
        return folders.length ? folders : ["INBOX"];
    } catch {
        return ["INBOX"];
    }
};

/** 对外返回时剔除一切凭据字段（cred_enc / oauth_enc / 解密值）。 */
const safeRow = (r: MailAccountRow) => ({
    id: r.id,
    label: r.label,
    source: r.source,
    host: r.host,
    port: r.port,
    username: r.username,
    protocol: r.protocol,
    folders: safeFolders(r.folders_json),
    use_ssl: r.use_ssl == null ? true : r.use_ssl === 1,
    pop3_host: r.pop3_host || null,
    pop3_port: r.pop3_port ?? null,
    pop3_ssl: r.pop3_ssl == null ? null : r.pop3_ssl === 1,
    pop3_use_stls: r.pop3_use_stls == null ? false : r.pop3_use_stls === 1,
    enabled: r.enabled === 1,
    last_sync_at: r.last_sync_at,
    last_error: r.last_error,
    created_at: r.created_at,
});

/**
 * 创建外部邮箱账号时，在 address 表写入一条「外部引用」记录并绑定到用户。
 * address.name = username（归集后邮件的 to_addr），source_meta='external'，
 * password=NULL（不参与本站建址/收信，仅作 users_address join 用）。
 * 这样 userAddressScope 自动纳入该 to_addr，resolveScope 立即隔离生效。
 * 复用 common.ts 既有的 source_meta 列（db/2025-12-27-source-meta.sql），零 schema 改动。
 * 一址一户（C1）：同一外部地址只能被一个用户接入——create 前置跨用户查重拒绝 + DB
 * 部分唯一索引兜底，跨用户共享同名 address 行的场景已不可能出现。这里 address.name
 * 仍需 INSERT OR IGNORE，因为 address.name UNIQUE 是表级全局唯一（与 user_mail_accounts
 * 的 enabled=1 行一一对应，同一用户名只会有本条外部引用行）。
 */
const ensureExternalBinding = async (c: Context<HonoCustomType>, userId: number, username: string) => {
    const msgs = i18n.getMessagesbyContext(c);
    let addrId: number | null = null;
    let addressCreated = false;
    let bindingCreated = false;
    try {
        const existingAddress = await c.env.DB.prepare(`SELECT id FROM address WHERE name = ?`)
            .bind(username).first<number>("id");
        // address.name UNIQUE：已存在则忽略，避免重复接入同一邮箱时报错
        const insertedAddress = await c.env.DB.prepare(
            `INSERT OR IGNORE INTO address(name, source_meta) VALUES(?, 'external')`
        ).bind(username).run();
        addrId = existingAddress ?? await c.env.DB.prepare(`SELECT id FROM address WHERE name = ?`)
            .bind(username).first<number>("id");
        addressCreated = !existingAddress && ((insertedAddress.meta as { changes?: number })?.changes ?? 0) > 0;
        if (!addrId) throw new Error(msgs.FailedCreateAddressMsg);
        const existingBinding = await c.env.DB.prepare(
            `SELECT 1 FROM users_address WHERE user_id = ? AND address_id = ?`
        ).bind(userId, addrId).first();
        const bindingResult = await c.env.DB.prepare(
            `INSERT OR IGNORE INTO users_address(user_id, address_id) VALUES(?, ?)`
        ).bind(userId, addrId).run();
        bindingCreated = !existingBinding && ((bindingResult.meta as { changes?: number })?.changes ?? 0) > 0;
        return { addrId, bindingCreated, addressCreated };
    } catch (error) {
        // Binding is a multi-statement operation; undo partial ownership changes
        // here, while the caller removes the account row itself.
        if (bindingCreated && addrId != null) {
            await c.env.DB.prepare(`DELETE FROM users_address WHERE user_id = ? AND address_id = ?`)
                .bind(userId, addrId).run();
        }
        if (addressCreated && addrId != null) {
            await c.env.DB.prepare(`DELETE FROM address WHERE id = ? AND name = ? AND source_meta = 'external'`)
                .bind(addrId, username).run();
        }
        throw error;
    }
};

const UserMailAccountsModule = {
    list: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const { results } = await c.env.DB.prepare(
            `SELECT * FROM user_mail_accounts WHERE user_id = ? ORDER BY created_at DESC`
        ).bind(user_id).all<MailAccountRow>();
        return c.json({ results: (results || []).map(safeRow) });
    },

    create: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { user_id } = c.get("userPayload");
        const body = await c.req.json().catch(() => ({})) as {
            label?: string; source?: string; host?: string; port?: number;
            username?: string; cred?: string; protocol?: string; folders?: string[];
            oauth?: string; use_ssl?: unknown;
            pop3_host?: unknown; pop3_port?: unknown;
            pop3_ssl?: unknown; pop3_use_stls?: unknown;
        };

        const username = (typeof body.username === "string" ? body.username : "").trim().toLowerCase();
        const source = (typeof body.source === "string" ? body.source : "").trim();
        const cred = typeof body.cred === "string" ? body.cred : "";
        const protocol = (typeof body.protocol === "string" ? body.protocol : "auto").trim();
        const useSsl = parseOptionalBoolean(body.use_ssl, true);
        const requestedPop3Host = body.pop3_host == null ? null
            : typeof body.pop3_host === "string" ? body.pop3_host.trim() : undefined;
        const requestedPop3Port = parseOptionalPort(body.pop3_port);
        // POP3 requests may omit the IMAP-shaped host/port entirely. For old
        // requests, the top-level values remain the POP3 compatibility fields.
        const host = (typeof body.host === "string" ? body.host.trim() : "")
            || (protocol === "pop3" ? requestedPop3Host || "" : "");
        const port = parseOptionalPort(body.port)
            ?? (protocol === "pop3" ? requestedPop3Port : undefined);
        // Older clients used host/port for POP3 and did not send the POP3
        // fields. Normalize that shape before validating/storing it.
        const pop3Host = requestedPop3Host ?? (protocol === "pop3" ? host : null);
        const pop3Port = requestedPop3Port ?? (protocol === "pop3" ? port : null);
        // POP3's well-known ports are useful compatibility defaults: an omitted
        // SSL flag on 110 means plaintext, while 995 means POP3S. Other ports
        // remain nullable and are resolved by the aggregator's historical rules.
        const parsedPop3Ssl = parseOptionalBoolean(body.pop3_ssl,
            pop3Port === 110 ? false : pop3Port === 995 ? true : null);
        const pop3UseStls = parseOptionalBoolean(body.pop3_use_stls, false);
        // STLS is plaintext-first. Persist an explicit false rather than null
        // (which the aggregator interprets as inheriting IMAP use_ssl).
        const pop3Ssl = pop3UseStls === true ? false : parsedPop3Ssl;
        // label 防非 string 类型崩溃（Minor）：先 String() 再 trim/slice
        const label = String(body.label ?? "").trim().slice(0, 60);
        // folders 校验为数组（I3）：非数组/空 → 兜底 ["INBOX"]，避免 safeRow 读取时
        // JSON.parse 出字符串导致前端 v-for 类型混乱。
        const foldersRaw = Array.isArray(body.folders)
            ? body.folders.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim())
            : [];

        if (!username || !host || !source || !cred || !Number.isInteger(port) || port <= 0 || port > 65535
            || useSsl === undefined || pop3Host === undefined || pop3Port === undefined
            || parsedPop3Ssl === undefined || pop3UseStls === undefined) {
            return c.text(msgs.RequiredFieldMsg, 400);
        }
        if (!ALLOWED_SOURCES.has(source)) return c.text(msgs.InvalidInputMsg, 400);
        if (!ALLOWED_PROTOCOLS.has(protocol)) return c.text(msgs.InvalidInputMsg, 400);
        if (protocol === "pop3" && (!pop3Host || pop3Port == null
            || !validatePop3Settings(parsedPop3Ssl, pop3UseStls, useSsl === true))) {
            return c.text(msgs.InvalidInputMsg, 400);
        }

        // review W1-3：oauth 是可选的 provider 白名单校验。body.oauth 是 JSON 字符串
        // （聚合器 oauth_client_factory 直接 `account.oauth.get("provider")`）。
        // 未知 provider 让聚合器 `_TOKEN_FN[provider]` KeyError 冻结整轮同步，故这里
        // 在落库前先拒绝。带 oauth 但非字符串 / 畸形 JSON / 缺 provider / 未知
        // provider 一律 400（fail-closed）。
        if (body.oauth != null && (typeof body.oauth !== "string" || body.oauth.trim() !== "")) {
            let oauthObj: { provider?: unknown } | null;
            try {
                oauthObj = JSON.parse(body.oauth) as { provider?: unknown };
            } catch {
                oauthObj = null;
            }
            if (!oauthObj || typeof oauthObj.provider !== "string"
                || !OAUTH_PROVIDERS.has(oauthObj.provider)) {
                return c.text(msgs.InvalidInputMsg, 400);
            }
        }

        // 接入操作限流，防止刷凭据/占资源（与注册同源 KV 限流器）
        if (!(await checkRegistrationRateLimit(c, "mail_account_create", 5, 60))) {
            return c.text(msgs.RateLimitExceededMsg, 429);
        }

        // 每用户上限（按角色可配 role_address_config.maxMailAccountCount，缺失回退默认 5；
        // 返回 0 = 不限，与 maxAddressCount 同口径）
        const user_role = await commonGetUserRole(c, user_id);
        const maxMailAccounts = await getMaxMailAccountCount(c, user_role?.role);
        const { count } = await c.env.DB.prepare(
            `SELECT COUNT(*) as count FROM user_mail_accounts WHERE user_id = ?`
        ).bind(user_id).first<{ count: number }>() || { count: 0 };
        if (maxMailAccounts > 0 && count >= maxMailAccounts) {
            return c.text(msgs.MaxAddressCountReachedMsg, 400);
        }

        // C1 一址一户：跨用户接入同名外部邮箱直接拒绝。同一用户重连/同名合法（user_id != ?）。
        // DB 部分唯一索引 idx_user_mail_accounts_username_uq 是最终兜底；此处前置给出明确 400。
        const { c: dupCount } = await c.env.DB.prepare(
            `SELECT COUNT(*) AS c FROM user_mail_accounts WHERE username = ? AND user_id != ? AND enabled = 1`
        ).bind(username, user_id).first<{ c: number }>() || { c: 0 };
        if (dupCount > 0) {
            return c.text(msgs.AddressAlreadyExistsMsg, 400);
        }

        const credEnc = await encryptCred(c, cred);
        const oauthEnc = body.oauth ? await encryptCred(c, body.oauth) : null;
        const foldersJson = JSON.stringify(foldersRaw.length ? foldersRaw : ["INBOX"]);
        const id = crypto.randomUUID();
        const now = Date.now();

        try {
            await c.env.DB.prepare(
                `INSERT INTO user_mail_accounts
                 (id, user_id, label, source, host, port, username, cred_enc, protocol,
                  folders_json, oauth_enc, use_ssl, pop3_host, pop3_port, pop3_ssl,
                  pop3_use_stls, enabled, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`
            ).bind(id, user_id, label || null, source, host, port, username, credEnc,
                protocol, foldersJson, oauthEnc, useSsl ? 1 : 0, pop3Host, pop3Port,
                pop3Ssl == null ? null : pop3Ssl ? 1 : 0, pop3UseStls ? 1 : 0, now).run();
        } catch (e) {
            const error = e as Error;
            if (error.message && error.message.includes("UNIQUE")) {
                return c.text(msgs.AddressAlreadyExistsMsg, 400);
            }
            throw e;
        }

        // I7e TOCTOU 补偿：前置配额检查（SELECT COUNT）与 INSERT 是两条独立 D1 语句，
        // 并发下两个请求可能都过检查都插入，超限 1 条。这里在 INSERT 成功、副作用
        // （ensureExternalBinding）之前重数——若超 max（max>0 非无限）则删除刚插的行并
        // 返回上限错误，使超限瞬态自纠。放在 ensureExternalBinding 之前，删除后不产生
        // 归属作用域副作用。
        if (maxMailAccounts > 0) {
            const { count: afterCount } = await c.env.DB.prepare(
                `SELECT COUNT(*) as count FROM user_mail_accounts WHERE user_id = ?`
            ).bind(user_id).first<{ count: number }>() || { count: 0 };
            if (afterCount > maxMailAccounts) {
                await c.env.DB.prepare(`DELETE FROM user_mail_accounts WHERE id = ?`).bind(id).run();
                return c.text(msgs.MaxAddressCountReachedMsg, 400);
            }
        }

        // 自动绑定：把 to_addr=username 纳入该用户的归属作用域。绑定失败时必须
        // 删除刚写入的 enabled account，否则聚合器会看到一个永远无法归属的孤儿账号。
        try {
            await ensureExternalBinding(c, user_id, username);
        } catch (error) {
            try {
                await c.env.DB.prepare(`DELETE FROM user_mail_accounts WHERE id = ? AND user_id = ?`)
                    .bind(id, user_id).run();
            } catch (cleanupError) {
                console.error(`failed to compensate mail account ${id}`, cleanupError);
            }
            throw error;
        }

        return c.json({ id, success: true });
    },

    remove: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { user_id } = c.get("userPayload");
        const { id } = c.req.param();
        // WHERE user_id 防越权删除他人账号
        const row = await c.env.DB.prepare(
            `SELECT username FROM user_mail_accounts WHERE id = ? AND user_id = ?`
        ).bind(id, user_id).first<{ username: string }>();
        if (!row) return c.text(msgs.AddressNotFoundMsg, 404);

        await c.env.DB.prepare(
            `DELETE FROM user_mail_accounts WHERE id = ? AND user_id = ?`
        ).bind(id, user_id).run();

        // 仅解绑 users_address，不删 address 行——历史归集邮件仍按 to_addr 归属该用户
        // （已删账号但邮件记录留痕），删掉 address 行会让这些邮件孤儿化。
        // 一址一户后不存在「其他人在用同名引用」的情形，address 行留着无害
        // （source_meta='external' 不参与建址）。
        await c.env.DB.prepare(
            `DELETE FROM users_address WHERE user_id = ? AND address_id IN
             (SELECT id FROM address WHERE name = ?)`
        ).bind(user_id, row.username).run();

        return c.json({ success: true });
    },

    toggle: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { user_id } = c.get("userPayload");
        const { id } = c.req.param();
        const row = await c.env.DB.prepare(
            `SELECT enabled FROM user_mail_accounts WHERE id = ? AND user_id = ?`
        ).bind(id, user_id).first<{ enabled: number }>();
        if (!row) return c.text(msgs.AddressNotFoundMsg, 404);
        await c.env.DB.prepare(
            `UPDATE user_mail_accounts SET enabled = ? WHERE id = ? AND user_id = ?`
        ).bind(row.enabled === 1 ? 0 : 1, id, user_id).run();
        return c.json({ success: true, enabled: row.enabled !== 1 });
    },

    /**
     * Validate that an account belongs to the current user before attempting a
     * connection test. The Worker has no IMAP/POP3 client (and must not pretend
     * that a test succeeded), so this is an explicit unsupported contract for
     * now. Keeping the ownership lookup here also makes a future async
     * implementation safe by construction.
     */
    testConnection: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const { id } = c.req.param();
        const row = await c.env.DB.prepare(
            `SELECT id FROM user_mail_accounts WHERE id = ? AND user_id = ?`
        ).bind(id, user_id).first<{ id: string }>();
        if (!row) return c.json({ error: "mail account not found" }, 404);
        return c.json(unsupportedMailAccountAction("connection_test", row.id), 501);
    },

    /**
     * Request an immediate sync. There is currently no queue/VPS dispatch
     * binding in the Worker, therefore never return queued/success falsely.
     * The account is still ownership-checked so this endpoint cannot be used
     * to probe or enqueue another user's account.
     */
    syncNow: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const { id } = c.req.param();
        const row = await c.env.DB.prepare(
            `SELECT id FROM user_mail_accounts WHERE id = ? AND user_id = ?`
        ).bind(id, user_id).first<{ id: string }>();
        if (!row) return c.json({ error: "mail account not found" }, 404);
        return c.json(unsupportedMailAccountAction("sync", row.id), 501);
    },

    /**
     * 聚合器专用凭据拉取端点（/admin/unified/mail_accounts，x-admin-auth 保护）。
     * 返回所有 enabled=1 的外部邮箱账号，**含解密后的明文凭据**——仅供聚合器
     * 在内存中短时使用，绝不通过任何 user_api 端点返回。
     */
    exportForAggregator: async (c: Context<HonoCustomType>) => {
        const { results } = await c.env.DB.prepare(
            `SELECT id, user_id, source, host, port, username, cred_enc, protocol,
                    folders_json, oauth_enc, use_ssl, pop3_host, pop3_port, pop3_ssl,
                    pop3_use_stls FROM user_mail_accounts WHERE enabled = 1`
        ).all<MailAccountRow>();
        const out = [];
        for (const r of results || []) {
            let password: string;
            let oauth: string | null = null;
            try {
                password = await decryptCred(c, r.cred_enc);
            } catch (e) {
                const message = boundedError(e, "cred decrypt failed");
                console.error(`decrypt cred failed for account ${r.id}`, e);
                try {
                    await c.env.DB.prepare(
                        `UPDATE user_mail_accounts SET last_error = ?, last_sync_at = ? WHERE id = ?`
                    ).bind(message, Date.now(), r.id).run();
                } catch (recordError) {
                    console.error(`failed to record export error for account ${r.id}`, recordError);
                }
                continue;
            }
            if (r.oauth_enc) {
                try {
                    oauth = await decryptCred(c, r.oauth_enc);
                } catch (e) {
                    const message = boundedError(e, "oauth decrypt failed");
                    console.error(`decrypt oauth failed for account ${r.id}`, e);
                    try {
                        await c.env.DB.prepare(
                            `UPDATE user_mail_accounts SET last_error = ?, last_sync_at = ? WHERE id = ?`
                        ).bind(message, Date.now(), r.id).run();
                    } catch (recordError) {
                        console.error(`failed to record export error for account ${r.id}`, recordError);
                    }
                    continue;
                }
            }
            try {
                out.push({
                    id: r.id,
                    source: r.source,
                    host: r.host,
                    port: r.port,
                    username: r.username,
                    password,
                    protocol: r.protocol,
                    // Export must use the same defensive parser as the user-facing
                    // listing. A corrupt row must not make the whole batch 500.
                    folders: safeFolders(r.folders_json),
                    use_ssl: r.use_ssl == null ? true : r.use_ssl === 1,
                    pop3_host: r.pop3_host || null,
                    pop3_port: r.pop3_port ?? null,
                    pop3_ssl: r.pop3_ssl == null ? null : r.pop3_ssl === 1,
                    pop3_use_stls: r.pop3_use_stls == null ? false : r.pop3_use_stls === 1,
                    oauth: oauth == null ? null : JSON.parse(oauth),
                });
            } catch (e) {
                const message = boundedError(e, "oauth parse failed");
                console.error(`parse oauth failed for account ${r.id}`, e);
                try {
                    await c.env.DB.prepare(
                        `UPDATE user_mail_accounts SET last_error = ?, last_sync_at = ? WHERE id = ?`
                    ).bind(message, Date.now(), r.id).run();
                } catch (recordError) {
                    console.error(`failed to record export error for account ${r.id}`, recordError);
                }
            }
        }
        return c.json({ accounts: out });
    },

    /**
     * 聚合器 sync 回写端点（POST /admin/unified/mail_accounts/:id/status，x-admin-auth 保护）。
     * 聚合器每轮 sync 后把 { synced, error } 回写：成功清空 last_error 并刷新 last_sync_at，
     * 失败写入 last_error（如「IMAP 登录失败：-ERR Login fail」）。这是用户自助排障的闭环——
     * 填错 app-password 时 UI 能直接看到原因，而不是邮件默默不出现。
     */
    reportStatus: async (c: Context<HonoCustomType>) => {
        const { id } = c.req.param();
        const body = await c.req.json().catch(() => ({})) as { error?: string };
        const error = body.error ? String(body.error).slice(0, 200) : null;
        // WHERE id = ? 即可：id 是 user_mail_accounts 的 PK（UUID，不可枚举），
        // 且此端点已在 x-admin-auth 后。只更新 last_sync_at/last_error。
        const { meta } = await c.env.DB.prepare(
            `UPDATE user_mail_accounts SET last_sync_at = ?, last_error = ? WHERE id = ?`
        ).bind(Date.now(), error, id).run();
        const changes = (meta as { changes?: number })?.changes ?? 0;
        if (changes === 0) return c.json({ error: "not found" }, 404);
        return c.json({ success: true });
    },
};

export default UserMailAccountsModule;
