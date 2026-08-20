export function cutoffMs(days: number, nowMs: number): number {
    return nowMs - days * 24 * 60 * 60 * 1000;
}

const RETENTION_DAYS = 90;

export async function cleanupReadEmails(env: Bindings, days: number = RETENTION_DAYS): Promise<{ deleted: number }> {
    const cutoff = cutoffMs(days, Date.now());
    // 先取要删的附件 R2 键
    const { results } = await env.DB.prepare(
        `SELECT id, attachments_json FROM emails WHERE is_read = 1 AND received_at < ? LIMIT 1000`
    ).bind(cutoff).all();
    // 删 R2 附件（若有 ATTACHMENTS bucket）
    const bucket = (env as { ATTACHMENTS?: R2Bucket }).ATTACHMENTS;
    if (bucket) {
        for (const r of results as { id: string; attachments_json: string }[]) {
            try {
                const atts = JSON.parse(r.attachments_json || "[]") as { r2_key?: string }[];
                for (const a of atts) {
                    if (a.r2_key) await bucket.delete(a.r2_key);
                }
            } catch (e) { console.error("r2 delete error", e); }
        }
    }
    const { meta } = await env.DB.prepare(
        `DELETE FROM emails WHERE is_read = 1 AND received_at < ?`
    ).bind(cutoff).run();
    return { deleted: (meta as { changes?: number })?.changes ?? 0 };
}