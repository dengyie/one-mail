export function cutoffMs(days: number, nowMs: number): number {
    return nowMs - days * 24 * 60 * 60 * 1000;
}

const RETENTION_DAYS = 90;

export async function cleanupReadEmails(env: Bindings, days: number = RETENTION_DAYS): Promise<{ deleted: number }> {
    const cutoff = cutoffMs(days, Date.now());
    const bucket = (env as { ATTACHMENTS?: R2Bucket }).ATTACHMENTS;
    // 分页删除：R2 键产商目前不写 r2_key（normalize.py/unified_store.ts），
    // 保护性处理 + 每批最多 1000 行，避免大库一次 DELETE 过大。
    let deleted = 0;
    let total = 0;
    do {
        const { results } = await env.DB.prepare(
            `SELECT id, attachments_json FROM emails WHERE is_read = 1 AND received_at < ? LIMIT 1000`
        ).bind(cutoff).all();
        const rows = (results ?? []) as { id: string; attachments_json: string }[];
        if (!rows.length) break;
        // R2 附件清理（若有 bucket，且为未来 r2_key 生产者预留）
        if (bucket) {
            for (const r of rows) {
                try {
                    const atts = JSON.parse(r.attachments_json || "[]") as { r2_key?: string }[];
                    for (const a of atts) {
                        if (a.r2_key) await bucket.delete(a.r2_key);
                    }
                } catch (e) { console.error("r2 delete error", e); }
            }
        }
        const ids = rows.map((r) => r.id);
        const placeholders = ids.map(() => "?").join(",");
        const { meta } = await env.DB.prepare(
            `DELETE FROM emails WHERE is_read = 1 AND received_at < ? AND id IN (${placeholders})`
        ).bind(cutoff, ...ids).run();
        deleted = (meta as { changes?: number })?.changes ?? 0;
        total += deleted;
    } while (deleted > 0);
    return { deleted: total };
}