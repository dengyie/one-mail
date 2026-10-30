/**
 * Schema owner for `gmail_reroute_idempotency`.
 *
 * The table is what stops the same x-idempotency-key from sending a Gmail reply
 * twice without touching the domain send quota, so both the send path (which
 * inserts/reads rows) and the cron pruner (which reclaims abandoned rows) have
 * to know it exists. It is a leaf module with no imports so either side can load
 * it without dragging in the other.
 */

const GMAIL_REROUTE_IDEMPOTENCY_SCHEMA =
    "CREATE TABLE IF NOT EXISTS gmail_reroute_idempotency (" +
        "idempotency_key TEXT PRIMARY KEY, " +
        "request_hash TEXT NOT NULL, " +
        "job_id TEXT NOT NULL, " +
        "created_at INTEGER NOT NULL" +
    ")";

/**
 * The table also ships as a migration, but a Worker isolate can reach a database
 * where it has not been applied yet, so the send path ensures it. The promise is
 * memoized per database: without that every send would pay for two DDL round
 * trips, and a concurrent burst would issue them in parallel. A failed attempt is
 * evicted so the next send retries instead of inheriting the rejection.
 */
const GMAIL_REROUTE_IDEMPOTENCY_READY = new WeakMap<D1Database, Promise<void>>();

export const ensureGmailRerouteIdempotencyTable = (db: D1Database): Promise<void> => {
    const ready = GMAIL_REROUTE_IDEMPOTENCY_READY.get(db);
    if (ready) return ready;
    const pending = db.prepare(GMAIL_REROUTE_IDEMPOTENCY_SCHEMA).run()
        .then(() => undefined)
        .catch((error) => {
            GMAIL_REROUTE_IDEMPOTENCY_READY.delete(db);
            throw error;
        });
    GMAIL_REROUTE_IDEMPOTENCY_READY.set(db, pending);
    return pending;
};
