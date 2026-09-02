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
