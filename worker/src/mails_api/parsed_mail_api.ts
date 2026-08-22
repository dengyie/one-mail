import { Context } from 'hono'

import i18n from '../i18n';
import { commonParseMail, updateAddressUpdatedAt } from '../common'
import { resolveRawEmailList, resolveRawEmailRow } from '../gzip'
import { listRawMails, countRawMails, getRawMail } from '../core/mail-list.ts'

const toParsedMailRow = async (row: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const raw = typeof row.raw === 'string' ? row.raw : '';
    const parsed = raw ? await commonParseMail({ rawEmail: raw }) : undefined;
    const { raw: _raw, ...rest } = row;
    return {
        ...rest,
        sender: parsed?.sender?.trim() ?? '',
        subject: parsed?.subject ?? '',
        text: parsed?.text ?? '',
        html: parsed?.html ?? '',
        attachments: (parsed?.attachments ?? []).map(a => ({
            filename: a.filename,
            mimeType: a.mimeType,
            disposition: a.disposition,
            size: a.content?.length ?? 0,
        })),
    };
};

const listParsedMails = async (c: Context<HonoCustomType>) => {
    const { address } = c.get("jwtPayload");
    if (!address) return c.json({ "error": "No address" }, 400);
    const { limit, offset } = c.req.query();
    if (Number.parseInt(offset) <= 0) updateAddressUpdatedAt(c, address);
    // limit/offset 校验与 common.handleMailListQuery 原逻辑逐字等价
    const msgs = i18n.getMessagesbyContext(c);
    const lim = typeof limit === "string" ? parseInt(limit) : limit;
    const off = typeof offset === "string" ? parseInt(offset) : offset;
    if (!lim || lim < 0 || lim > 100) return c.text(msgs.InvalidLimitMsg, 400);
    if (off == null || off == undefined || off < 0) return c.text(msgs.InvalidOffsetMsg, 400);
    const resolved = await resolveRawEmailList(await listRawMails(c, address, { limit: lim, offset: off }));
    const count = off === 0 ? await countRawMails(c, address) : 0;
    const parsed = await Promise.all(resolved.map(toParsedMailRow));
    return c.json({ results: parsed, count });
};

const getParsedMail = async (c: Context<HonoCustomType>) => {
    const { address } = c.get("jwtPayload");
    const { mail_id } = c.req.param();
    const row = await getRawMail(c, mail_id, address);
    if (!row) return c.json(null);
    const resolved = await resolveRawEmailRow(row);
    return c.json(await toParsedMailRow(resolved as Record<string, unknown>));
};

export default { listParsedMails, getParsedMail };
