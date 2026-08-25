import { Context } from "hono";

import i18n from "../i18n";
import { checkRegistrationRateLimit, getMaxMailAccountCount } from "../utils";
import { commonGetUserRole } from "../common";
import { encryptCredCtx as encryptCred, decryptCredCtx as decryptCred } from "./cred_crypto";

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
    enabled: number;
    last_sync_at: number | null;
    last_error: string | null;
    created_at: number;
}

/** 解析 folders_json，畸形值兜底为 ["INBOX"]——绝不让单条坏数据 500 掉整列。 */
const safeFolders = (raw: string | null): string[] => {
    if (!raw) return ["INBOX"];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((s) => typeof s === "string") : ["INBOX"];
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
    // address.name UNIQUE：已存在则忽略，避免重复接入同一邮箱时报错
    await c.env.DB.prepare(
        `INSERT OR IGNORE INTO address(name, source_meta) VALUES(?, 'external')`
    ).bind(username).run();
    // .first("id") 返回该列的标量值（number），不是 row 对象
    const addrId = await c.env.DB.prepare(`SELECT id FROM address WHERE name = ?`)
        .bind(username).first<number>("id");
    if (!addrId) {
        throw new Error(msgs.FailedCreateAddressMsg);
    }
    await c.env.DB.prepare(
        `INSERT OR IGNORE INTO users_address(user_id, address_id) VALUES(?, ?)`
    ).bind(userId, addrId).run();
    return addrId;
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
            oauth?: string;
        };

        const username = (body.username || "").trim().toLowerCase();
        const host = (body.host || "").trim();
        const source = (body.source || "").trim();
        const cred = body.cred || "";
        const port = Number(body.port);
        const protocol = (body.protocol || "auto").trim();
        // label 防非 string 类型崩溃（Minor）：先 String() 再 trim/slice
        const label = String(body.label ?? "").trim().slice(0, 60);
        // folders 校验为数组（I3）：非数组/空 → 兜底 ["INBOX"]，避免 safeRow 读取时
        // JSON.parse 出字符串导致前端 v-for 类型混乱。
        const foldersRaw = Array.isArray(body.folders)
            ? body.folders.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim())
            : [];

        if (!username || !host || !source || !cred || !Number.isInteger(port) || port <= 0 || port > 65535) {
            return c.text(msgs.RequiredFieldMsg, 400);
        }
        if (!ALLOWED_SOURCES.has(source)) return c.text(msgs.InvalidInputMsg, 400);
        if (!ALLOWED_PROTOCOLS.has(protocol)) return c.text(msgs.InvalidInputMsg, 400);

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
                  folders_json, oauth_enc, enabled, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`
            ).bind(id, user_id, label || null, source, host, port, username, credEnc,
                protocol, foldersJson, oauthEnc, now).run();
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

        // 自动绑定：把 to_addr=username 纳入该用户的归属作用域
        await ensureExternalBinding(c, user_id, username);

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
     * 聚合器专用凭据拉取端点（/admin/unified/mail_accounts，x-admin-auth 保护）。
     * 返回所有 enabled=1 的外部邮箱账号，**含解密后的明文凭据**——仅供聚合器
     * 在内存中短时使用，绝不通过任何 user_api 端点返回。
     */
    exportForAggregator: async (c: Context<HonoCustomType>) => {
        const { results } = await c.env.DB.prepare(
            `SELECT id, user_id, source, host, port, username, cred_enc, protocol,
                    folders_json, oauth_enc FROM user_mail_accounts WHERE enabled = 1`
        ).all<MailAccountRow>();
        const out = [];
        for (const r of results || []) {
            try {
                const password = await decryptCred(c, r.cred_enc);
                const oauth = r.oauth_enc ? await decryptCred(c, r.oauth_enc) : null;
                out.push({
                    id: r.id,
                    source: r.source,
                    host: r.host,
                    port: r.port,
                    username: r.username,
                    password,
                    protocol: r.protocol,
                    folders: r.folders_json ? JSON.parse(r.folders_json) : ["INBOX"],
                    oauth: oauth ? JSON.parse(oauth) : null,
                });
            } catch (e) {
                console.error(`decrypt cred failed for account ${r.id}`, e);
                // 单条解密失败不阻塞其他账号；聚合器会跳过；这里顺带把错误回写，
                // 用户在「我的邮箱」页能看到「凭据损坏，请重新填写」。
                await c.env.DB.prepare(
                    `UPDATE user_mail_accounts SET last_error = ?, last_sync_at = ? WHERE id = ?`
                ).bind(`cred decrypt failed: ${(e as Error).message}`, Date.now(), r.id).run();
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
