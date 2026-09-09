import { Context } from 'hono'
import i18n from '../i18n'
import { getBooleanValue, checkUserPassword } from '../utils'
import { hashPasswordForStorage } from '../core/password.ts'
import { newAddress, handleListQuery } from '../common'
import { signAddressJwt } from '../core/auth'

const listAddresses = async (c: Context<HonoCustomType>) => {
    const { limit, offset, query, sort_by, sort_order } = c.req.query();
    const allowedSortColumns: Record<string, string> = {
        'id': 'a.id',
        'name': 'a.name',
        'created_at': 'a.created_at',
        'updated_at': 'a.updated_at',
        'source_meta': 'a.source_meta',
        'mail_count': 'mail_count',
        'send_count': 'send_count',
    };
    const sortColumn = Object.hasOwn(allowedSortColumns, sort_by) ? allowedSortColumns[sort_by] : 'a.id';
    const sortDirection = sort_order === 'ascend' ? 'asc' : 'desc';
    const orderBy = `${sortColumn} ${sortDirection}`;
    // 排除外部邮箱引用行（Part 2：source_meta='external' 是用户自助接入外部邮箱时
    // 写入 address 表的「引用占位」，仅作 users_address join 用，不属于本站域名地址。
    // admin 地址管理页不应把它们当成可建址/可收信的本站地址展示，否则管理员看到一堆
    // gmail/qq 外部地址且点删除会误删用户接入引用 → 隔离作用域被破坏。）
    const NOT_EXTERNAL = `(source_meta IS NULL OR source_meta != 'external')`;
    if (query) {
        // D1 caps LIKE pattern length at 50 bytes; fall back to instr() for
        // longer queries to avoid "LIKE or GLOB pattern too complex" (#956).
        const useInstr = new TextEncoder().encode(query).length + 2 > 50;
        const whereClause = useInstr ? `instr(name, ?) > 0` : `name like ?`;
        const param = useInstr ? query : `%${query}%`;
        return await handleListQuery(c,
            `SELECT a.*,`
            + ` (SELECT COUNT(*) FROM raw_mails WHERE address = a.name) AS mail_count,`
            + ` (SELECT COUNT(*) FROM sendbox WHERE address = a.name) AS send_count`
            + ` FROM address a`
            + ` where ${whereClause} AND ${NOT_EXTERNAL}`,
            `SELECT count(*) as count FROM address where ${whereClause} AND ${NOT_EXTERNAL}`,
            [param], limit, offset, orderBy, ['password']
        );
    }
    return await handleListQuery(c,
        `SELECT a.*,`
        + ` (SELECT COUNT(*) FROM raw_mails WHERE address = a.name) AS mail_count,`
        + ` (SELECT COUNT(*) FROM sendbox WHERE address = a.name) AS send_count`
        + ` FROM address a`
        + ` where ${NOT_EXTERNAL}`,
        `SELECT count(*) as count FROM address where ${NOT_EXTERNAL}`,
        [], limit, offset, orderBy, ['password']
    );
};

const createNewAddress = async (c: Context<HonoCustomType>) => {
    const { name, domain, enablePrefix, enableRandomSubdomain } = await c.req.json();
    const msgs = i18n.getMessagesbyContext(c);
    if (!name) {
        return c.text(msgs.RequiredFieldMsg, 400)
    }
    try {
        const res = await newAddress(c, {
            name, domain, enablePrefix,
            enableRandomSubdomain: getBooleanValue(enableRandomSubdomain),
            checkLengthByConfig: false,
            addressPrefix: null,
            checkAllowDomains: false,
            enableCheckNameRegex: false,
            sourceMeta: 'admin'
        });
        return c.json(res);
    } catch (e) {
        return c.text(`${msgs.FailedCreateAddressMsg}: ${(e as Error).message}`, 400)
    }
};

const deleteAddress = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { id } = c.req.param();
    // 拒删外部邮箱引用行（Part 2）：source_meta='external' 的 address 行是用户自助
    // 接入外部邮箱时写入的归属引用占位，删了会破坏该用户的 to_addr 隔离作用域。
    // 这类行只能由用户在「我的邮箱」页删 mailbox 时连带解绑，管理员不得从地址页误删。
    const target = await c.env.DB.prepare(
        `SELECT source_meta FROM address WHERE id = ?`
    ).bind(id).first<{ source_meta: string | null }>();
    if (target && target.source_meta === 'external') {
        return c.text(msgs.AddressNotFoundMsg, 404);
    }
    // single batch runs as one transaction: rows keyed by address name are
    // deleted first and the address row last, so the name subqueries still
    // resolve and a failed statement rolls back the whole deletion
    const results = await c.env.DB.batch([
        c.env.DB.prepare(
            `DELETE FROM raw_mails WHERE address IN`
            + ` (select name from address where id = ?) `
        ).bind(id),
        c.env.DB.prepare(
            `DELETE FROM address_sender WHERE address IN`
            + ` (select name from address where id = ?) `
        ).bind(id),
        c.env.DB.prepare(
            `DELETE FROM sendbox WHERE address IN`
            + ` (select name from address where id = ?) `
        ).bind(id),
        c.env.DB.prepare(
            `DELETE FROM auto_reply_mails WHERE address IN`
            + ` (select name from address where id = ?) `
        ).bind(id),
        c.env.DB.prepare(
            `DELETE FROM users_address WHERE address_id = ?`
        ).bind(id),
        c.env.DB.prepare(
            `DELETE FROM address WHERE id = ? `
        ).bind(id),
    ]);
    const success = results.every((result) => result.success);
    if (!success) {
        return c.text(msgs.OperationFailedMsg, 500)
    }
    return c.json({ success })
};

const clearInbox = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { id } = c.req.param();
    const { success: mailSuccess } = await c.env.DB.prepare(
        `DELETE FROM raw_mails WHERE address IN`
        + ` (select name from address where id = ?) `
    ).bind(id).run();
    if (!mailSuccess) {
        return c.text(msgs.OperationFailedMsg, 500)
    }
    return c.json({ success: mailSuccess });
};

const clearSentItems = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { id } = c.req.param();
    const { success: sendboxSuccess } = await c.env.DB.prepare(
        `DELETE FROM sendbox WHERE address IN`
        + ` (select name from address where id = ?) `
    ).bind(id).run();
    if (!sendboxSuccess) {
        return c.text(msgs.OperationFailedMsg, 500)
    }
    return c.json({ success: sendboxSuccess });
};

const showPassword = async (c: Context<HonoCustomType>) => {
    const { id } = c.req.param();
    const name = await c.env.DB.prepare(
        `SELECT name FROM address WHERE id = ? `
    ).bind(id).first("name");
    const jwt = await signAddressJwt(c, {
        address: name,
        address_id: id,
    })
    return c.json({ jwt });
};

const resetPassword = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { id } = c.req.param();
    const { password } = await c.req.json();
    if (!getBooleanValue(c.env.ENABLE_ADDRESS_PASSWORD)) {
        return c.text(msgs.PasswordChangeDisabledMsg, 403);
    }
    try {
        checkUserPassword(password);
    } catch {
        return c.text(msgs.NewPasswordRequiredMsg, 400);
    }
    const storedPassword = await hashPasswordForStorage(password);
    const { success } = await c.env.DB.prepare(
        `UPDATE address SET password = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(storedPassword, id).run();
    if (!success) {
        return c.text(msgs.FailedUpdatePasswordMsg, 500);
    }
    return c.json({ success: true });
};

export default {
    listAddresses, createNewAddress, deleteAddress, clearInbox, clearSentItems,
    showPassword, resetPassword
};
