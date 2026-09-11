/** Stable response contract for operations that need the VPS aggregator.
 * Kept dependency-free so it can be tested in Node and reused by route code.
 */
export type MailAccountAction = "connection_test" | "sync";

export const unsupportedMailAccountAction = (action: MailAccountAction, accountId: string) => ({
    status: "unsupported" as const,
    code: action === "connection_test"
        ? "worker_connection_test_unavailable"
        : "worker_sync_dispatch_unavailable",
    message: action === "connection_test"
        ? "Connection testing is not available on the Worker yet."
        : "Immediate synchronization is not available on the Worker yet.",
    account_id: accountId,
});

/** 聚合器 RT 轮换回写（POST /admin/unified/mail_accounts/:id/refresh_token）的
 * oauth 载荷合并逻辑。依赖无关，可在 Node 单测。
 *
 * MSA/consumers 的 refresh_token 兑换即轮换：聚合器换到新 RT 后必须回写落库，
 * 否则旧 RT 失效 = 账号永久失联（2026-09-11 烧卡事故根因）。
 */
export type MergeRefreshTokenResult =
    | { ok: true; oauthJson: string }
    | { ok: false; reason: "no_oauth" | "corrupt_oauth" | "not_object" };

export const mergeRotatedRefreshToken = (
    oauthJson: string | null,
    newRefreshToken: string
): MergeRefreshTokenResult => {
    if (!oauthJson) return { ok: false, reason: "no_oauth" };
    let oauth: unknown;
    try {
        oauth = JSON.parse(oauthJson);
    } catch {
        return { ok: false, reason: "corrupt_oauth" };
    }
    if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) {
        return { ok: false, reason: "not_object" };
    }
    return { ok: true, oauthJson: JSON.stringify({ ...(oauth as object), refresh_token: newRefreshToken }) };
};
