import { Context } from 'hono'

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
    return c.json({ success });
};

export default { list, remove };
