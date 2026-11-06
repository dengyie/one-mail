import { Context } from 'hono'

import { resolveAuditActor, resolveAuditIp, writeAudit } from '../core/audit_log.ts'
import { querySendboxList } from '../mails_api/send_mail_api'

const list = async (c: Context<HonoCustomType>) => {
    const { address, limit, offset, source, q, from, to, channel, with_count } = c.req.query();
    return querySendboxList(c, {
        address: address || undefined,
        source,
        channel,
        q,
        from,
        to,
        limit,
        offset,
        withCount: with_count !== "0",
    });
};

const remove = async (c: Context<HonoCustomType>) => {
    const { id } = c.req.param();
    const { success } = await c.env.DB.prepare(
        `DELETE FROM sendbox WHERE id = ? `
    ).bind(id).run();
    if (success) {
        await writeAudit(c.env, {
            actor: resolveAuditActor(c),
            action: "sendbox.delete",
            targetType: "sendbox",
            targetId: id,
            ip: resolveAuditIp(c),
        });
    }
    return c.json({ success });
};

export default { list, remove };
