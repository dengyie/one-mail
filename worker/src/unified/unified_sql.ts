// r2_key is internal storage metadata used for retention and must never be
// returned by list APIs. Build the same JSON array with that property removed.
export const UNIFIED_EMAIL_SELECT = `SELECT id,source,account_id,from_addr,to_addr,subject,COALESCE(internal_date, received_at) as received_at,internal_date,is_read,is_starred,(SELECT json_group_array(CASE WHEN json_type(json_each.value, '$.r2_key') = 'text' AND length(json_extract(json_each.value, '$.r2_key')) = 51 AND substr(json_extract(json_each.value, '$.r2_key'), 1, 8) = 'unified/' AND substr(json_extract(json_each.value, '$.r2_key'), 9) NOT GLOB '*[^A-Za-z0-9_-]*' AND json_type(json_each.value, '$.id') = 'text' AND length(json_extract(json_each.value, '$.id')) BETWEEN 1 AND 160 AND json_extract(json_each.value, '$.id') NOT GLOB '*[^A-Za-z0-9._:-]*' AND json_type(json_each.value, '$.size') = 'integer' AND json_extract(json_each.value, '$.size') BETWEEN 0 AND 31457280 THEN json_set(json_remove(json_each.value, '$.r2_key'), '$.downloadable', json('true')) ELSE json_set(json_remove(json_each.value, '$.r2_key'), '$.downloadable', json('false')) END) FROM json_each(CASE WHEN json_valid(emails.attachments_json) AND json_type(emails.attachments_json) = 'array' THEN emails.attachments_json ELSE '[]' END) WHERE json_each.type = 'object') AS attachments_json FROM emails`;
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
