export const UNIFIED_EMAIL_SELECT = `SELECT id,source,account_id,from_addr,to_addr,subject,COALESCE(internal_date, received_at) as received_at,internal_date,is_read,is_starred,attachments_json FROM emails`;
export const UNIFIED_EMAIL_ORDER = `COALESCE(internal_date, received_at) DESC, id DESC`;

/** Compact trusted filter-builder IN lists into one JSON binding per dimension. */
export const boundedEmailFilter = (filter: {
    where: string;
    params: (string | number)[];
}): { where: string; params: (string | number)[] } => {
    let index = 0;
    const params: (string | number)[] = [];
    const where = filter.where.replace(
        /\b(source|account_id|to_addr) IN \((\?(?:,\?)+)\)|\?/g,
        (match: string, column?: string, placeholders?: string) => {
            if (!column || !placeholders) {
                params.push(filter.params[index++]);
                return match;
            }
            const length = placeholders.split(",").length;
            params.push(JSON.stringify(filter.params.slice(index, index + length)));
            index += length;
            return `${column} IN (SELECT value FROM json_each(?))`;
        },
    );
    return { where, params };
};
