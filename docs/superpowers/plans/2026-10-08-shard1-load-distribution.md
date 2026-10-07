# First D1 Shard Cutover Implementation Plan

> For agentic workers: use executing-plans to execute inline with fresh verification at every production boundary. Do not infer operator quiescence from this plan.

**Goal:** Activate the existing account-B shard for a bounded first group of external mailboxes without losing email content or state.

**Architecture:** Keep authentication, users, mail account metadata, native Email Routing, raw_mails and sendbox on the primary. Route selected complete external account IDs to shard1 through the existing federation protocol. This is static mailbox placement, not random request balancing.

**Tech Stack:** Existing Hono Workers, Cloudflare D1/KV, Python aggregator and Node migration CLI; no new dependencies.

## Global constraints

- Follow `docs/unified-inbox-sharding.md` section 6, P3: copy → map cutover → full delta → exact verification → budgeted source cleanup.
- Keep both accounts on the existing free tier. Migration writes include index writes.
- Never pass `--source-quiesced` until provider refresh, retention and user/API mutations on both stores have actually stopped for the selected mailboxes.
- Existing credentials stay in private storage; never commit the map token or production config.
- Never migrate cf_routing, user metadata, raw_mails or sendbox.
- Preserve exact email IDs, all 29 email columns, and folder identities; conflicts stop migration.
- Preserve checkpoints and the shared daily deletion-budget ledger across retries.
- Do not reset routing to the primary after target writes resume without reverse reconciliation.

## Observed allocation, 2026-10-08 Asia/Shanghai

The primary database is 190,537,728 bytes. Its email table has approximately 24,569 rows. The largest static QQ mailbox contains 20,317 rows; it must not be copied in one unbudgeted operation. The target was empty before preparation.

The private operator manifest is `/Users/mango/.config/onemail/shard-cutover-20261008/pilot.json`. It identifies the three proposed accounts: bound QQ (2,100 messages), bound Gmail (1,265), and static 163 (282). Observed total: 3,647 messages, approximately 26.1 MB of body/header characters (SQL length, not encoded or on-disk byte size).

With the observed indexes, conservative email-only estimates are 72,940 target writes and 54,705 source cleanup writes. Folder writes, normal application usage and any schema changes require additional headroom. These estimates are not current Cloudflare billing counters or a prediction of query-load reduction.

## Task 1: Prepare the inactive target

- [x] Check production D1 and KV bindings in both accounts; map and aggregator shard list are empty.
- [x] Check both queues: no unresolved provider mutation jobs at preflight time.
- [x] Run `node --test db/backfill_shard.test.mjs`: 31 pass (including the indexed verification regression).
- [x] Run `pnpm --dir worker test`: 400 pass after reusing installed workspace dependencies.
- [x] Run Worker TypeScript check and shard-specific dry-run bundle successfully.
- [x] Deploy current main source to the inactive shard only. Version: `ed1b06ee-3c13-47d3-b685-07b7b6948f5f`; previous version: `6533aadb-1893-46a3-a8da-8741e81ab090`.
- [x] Initialize current shard schema using authenticated `POST /shard/schema/initialize`; confirm `attachment_gc` and `mail_account_lifecycle` exist.
- [x] Verify unauthenticated health 401, authenticated health 200 with shard1 identity; empty archive and incomplete archive rows return 400 before writes. Target email count remains zero.

### Read-budget correction

Live D1 EXPLAIN showed UUID-ordered verification sorting the complete mailbox on each page. `db/backfill_shard.mjs` now uses the existing `(account_id, received_at)` index through a composite `(received_at, id)` cursor, then verifies all columns with bounded target primary-key lookups. A live read-only 15-row comparison scanned 1,445 rows before versus 32 after; SQLite execution-plan and exact-projection regressions pass. No source/target email data was changed by the checks.

Cloudflare account-wide analytics for UTC 2026-10-07 at preflight reported primary 3,055,780 rows read / 20,621 rows written; shard1 298 read / 330 written. These are observations subject to ingestion delay and must be rechecked at the maintenance window.

## Task 2: Establish the maintenance window

- [ ] Obtain the operator's maintenance window, including stopping external mailbox synchronization and preventing existing-row changes from the UI/API and retention. Read-only inspection alone does not satisfy this condition.
- [ ] Recheck selected account counts, unresolved jobs, current routing and actual daily write headroom. Abort if either account cannot accommodate its stage plus normal traffic.
- [ ] Preserve the current primary KV map, aggregator config and a protected export of selected source rows/folders. Keep secrets and email contents out of the repository and logs.
- [ ] Stop `one-mail-agg` through the existing pxed Supervisor configuration and verify STOPPED. Establish and verify source/target write guards and retention locks before declaring quiescence.

## Task 3: Copy and verify

Run the existing CLI for each exact account ID in the private manifest, using one persistent state file per account and credentials injected through the documented environment variables. Start with the 282-message 163 account and verify its complete results before the larger accounts.

The CLI entry points are `copy`, `delta`, `verify`, `count` and `delete`, documented by:

```sh
node db/backfill_shard.mjs --help
```

- [ ] Execute `copy` with explicit matching `--confirm-copy`, `--source-quiesced`, chunk size 15 and delay 1000ms. Retain the exact state file on failure.
- [ ] Verify source/target columns, IDs, folder identities and complete projections; a count match alone is insufficient.
- [ ] Enforce remaining target write budget between accounts. Stop at account boundaries instead of exhausting production quota.

## Task 4: Cut over and clean up

- [ ] Add only verified accounts to `one-mail:shard-map` with schema v1 and shard1 endpoint/token.
- [ ] Atomically add matching `shards` entries to the private aggregator config while it remains stopped; validate through the existing Python `Config` model.
- [ ] Wait for the 60-second gateway cache to converge and verify the real gateway resolves selected account data through shard1.
- [ ] Run full `delta` and exact `verify` again under the same write freeze.
- [ ] Delete source email rows only after matching account-specific `--confirm-delete` and live cutover proof. Use the existing daily ledger, index-inclusive budget and 65-second stability checks. Do not remove source folders or historical mutation jobs as part of this operation.
- [ ] Allow adequate maintenance time for cleanup: the current CLI deletes at most three full-projection rows per statement and repeats remote proof checks. No fixed short completion time has been measured.
- [ ] Remove maintenance guards, restart the aggregator, and verify destination-aware ingest/claim/result while status and token updates still use the primary.
- [ ] Verify list/detail/count/folders and provider mutation behavior in the mixed topology, then record production versions, counts, quota observations and rollback boundaries in the canonical Obsidian manual and indexes.

## Rollback boundary

Before cutover: leave routing untouched, keep target copies/checkpoints for inspection, release guards and resume the primary pipeline.

After cutover but before target writes resume: verify exact equality, restore the previous map and aggregator config, allow gateway cache convergence, then resume the primary.

After target writes resume or source deletion starts: no blind map rollback. Stop writers and reconcile target changes back to the primary first. The retained source snapshot is not a current replica.

## Current state

Target preparation is complete. No production email has been copied or deleted; no shard map or aggregator account allocation has changed. Data migration is awaiting an explicit maintenance window and fresh quota-headroom verification.
