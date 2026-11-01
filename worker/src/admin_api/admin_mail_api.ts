import { Context } from "hono";
import { handleMailListQuery } from "../common.ts";
import { wantsLegacyCount } from "../core/count_opt_in.ts";
import { resolveRawEmailRow } from "../gzip.ts";
import { escapeSqlLike } from "../unified/verifcode.ts";
import type { RawMailRow } from "../models";

export default {
    getMails: async (c: Context<HonoCustomType>) => {
        const { address, limit, offset, with_count } = c.req.query();
        const domain = c.req.query("domain");
        const filterQuerys: string[] = [];
        const filterParams: string[] = [];

        // 1. domain 参数过滤（支持 domain=dengyie.tech 或 @dengyie.tech）
        if (typeof domain === "string" && domain.trim()) {
            const cleanDomain = domain.trim().toLowerCase().replace(/^@/, "");
            if (cleanDomain) {
                filterQuerys.push("address LIKE ? ESCAPE '\\'");
                filterParams.push(`%@${escapeSqlLike(cleanDomain)}`);
            }
        }

        // 2. address 参数过滤（支持精确匹配、@domain 后缀、带 * 的通配符、裸域名）
        if (typeof address === "string" && address.trim()) {
            const trimmedAddr = address.trim().toLowerCase();
            if (trimmedAddr.startsWith("@")) {
                const domainPart = trimmedAddr.slice(1);
                filterQuerys.push("address LIKE ? ESCAPE '\\'");
                filterParams.push(`%@${escapeSqlLike(domainPart)}`);
            } else if (trimmedAddr.includes("*")) {
                const escaped = escapeSqlLike(trimmedAddr).replace(/\*/g, "%");
                filterQuerys.push("address LIKE ? ESCAPE '\\'");
                filterParams.push(escaped);
            } else if (!trimmedAddr.includes("@") && trimmedAddr.includes(".")) {
                filterQuerys.push("(address = ? OR address LIKE ? ESCAPE '\\')");
                filterParams.push(trimmedAddr, `%@${escapeSqlLike(trimmedAddr)}`);
            } else {
                filterQuerys.push("address = ?");
                filterParams.push(trimmedAddr);
            }
        }

        const finalQuery = filterQuerys.length > 0 ? `where ${filterQuerys.join(" and ")}` : "";
        return await handleMailListQuery(c,
            `SELECT * FROM raw_mails ${finalQuery}`,
            `SELECT count(*) as count FROM raw_mails ${finalQuery}`,
            filterParams, limit, offset, undefined, { skipCount: !wantsLegacyCount(with_count) }
        );
    },
    getUnknowMails: async (c: Context<HonoCustomType>) => {
        const { limit, offset, with_count } = c.req.query();
        return await handleMailListQuery(c,
            `SELECT * FROM raw_mails where address NOT IN (select name from address) `,
            `SELECT count(*) as count FROM raw_mails`
            + ` where address NOT IN (select name from address) `,
            [], limit, offset, undefined, { skipCount: !wantsLegacyCount(with_count) }
        );
    },
    getMail: async (c: Context<HonoCustomType>) => {
        const { id } = c.req.param();
        const result = await c.env.DB.prepare(
            `SELECT * FROM raw_mails WHERE id = ?`
        ).bind(id).first<RawMailRow>();
        if (!result) return c.json(null);
        return c.json(await resolveRawEmailRow(result));
    },
    deleteMail: async (c: Context<HonoCustomType>) => {
        const { id } = c.req.param();
        const { success } = await c.env.DB.prepare(
            `DELETE FROM raw_mails WHERE id = ? `
        ).bind(id).run();
        return c.json({
            success: success
        })
    }
}
