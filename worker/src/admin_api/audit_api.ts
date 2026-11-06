import { Context } from 'hono';

import { handleListQuery } from '../common';

// Whitelisted sort keys. `id` is also the tiebreaker under `created_at` because
// created_at only has one-second resolution.
const ORDER_BY: Record<string, string> = {
    id: 'id desc',
    created_at: 'created_at desc, id desc',
};

export function auditOrderBy(orderBy: string | undefined | null): string {
    if (!orderBy) return ORDER_BY.id;
    return ORDER_BY[orderBy] ?? ORDER_BY.id;
}

export default {
    list: async (c: Context<HonoCustomType>) => {
        const { limit, offset, actor, action, target_type, target_id, order_by } = c.req.query();

        let where = '';
        const params: string[] = [];
        const filters: Array<[string | undefined, string]> = [
            [actor, 'actor'],
            [action, 'action'],
            [target_type, 'target_type'],
            [target_id, 'target_id'],
        ];
        for (const [value, column] of filters) {
            if (value === undefined || value === '') continue;
            where += where ? ' AND ' : ' WHERE ';
            where += `${column} = ?`;
            params.push(value);
        }

        return await handleListQuery(
            c,
            `SELECT id, actor, action, target_type, target_id, detail_json, ip, created_at`
            + ` FROM audit_logs${where}`,
            `SELECT count(*) AS count FROM audit_logs${where}`,
            params,
            limit,
            offset,
            auditOrderBy(order_by),
            [],
        );
    },
};
