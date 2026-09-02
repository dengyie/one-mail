# ADR: Phase 1 Unified Message Index Migration

- **Status: Proposed (not implemented)**
- **Date:** 2025-02-22
- **Scope:** D1/SQLite data model and incremental migration

> This ADR is a Phase 1 migration proposal, not a description of a completed feature. It does not change business code, switch read/write paths, or claim that the target tables already exist. A separate implementation decision is required only after migration scripts, backfill checks, and real-entry acceptance all pass.

## 1. Decision summary

Keeping the existing `emails`, `user_mail_accounts`, and legacy APIs, add a traceable provider identity to each external copy and add `mail_account_folders` for the stable relationship between an account and its source folders. Phase 1 covers schema, deduplication, historical backfill, and compatibility indexes only. It does not remove old fields, alter API responses, or treat `imap_uid` as a global ID.

The target identity is:

```text
(mail_account_id, folder_identity, provider_message_id)
```

For IMAP, `folder_identity` includes `UIDVALIDITY + folder` at minimum; POP3 uses UIDL; API providers use their stable message ID. If no stable ID exists, retain a traceable composite source key and expose the record for later handling. Never silently guess uniqueness.

## 2. Current state, goals, and non-goals

### 2.1 Current state

`emails` currently serves both native mail and external copies. Historical rows primarily depend on legacy `imap_uid`, address, and time semantics. Folder configuration may be present as JSON, but it does not reliably identify a source folder. An `imap_uid` is meaningful only within one IMAP folder and UIDVALIDITY.

### 2.2 Phase 1 goals

- Backfill account, provider, source-folder, and stable-message identity for external copies;
- make duplicate delivery deterministic at the database layer;
- provide a batched, safe, rerunnable historical backfill;
- preserve existing queries, details, deletion behavior, and IMAP proxy use of legacy fields;
- establish an indexable base for later unified listing, threading, and provider writes.

### 2.3 Non-goals

- No provider API/IMAP synchronizer or bidirectional write operation in this phase;
- no thread reconstruction, attachment migration, or removal of `imap_uid`;
- no forced merge based only on subject, sender, or time;
- no change to business routes, authentication, or existing response contracts.

## 3. Data model decisions

### 3.1 New `emails` fields

The following are explicit SQLite/D1 types. SQLite has no native boolean or JSON types: booleans use `INTEGER` (`0/1`), and JSON uses valid JSON text.

| Field | D1 type and constraint | NULL semantics |
|---|---|---|
| `provider` | `TEXT` | `NULL` means native/legacy provider is unknown; known values are `gmail`, `graph`, `imap`, `pop3`, or `native` |
| `mail_account_id` | `INTEGER` (foreign-key semantics; an actual FK depends on existing migration support) | `NULL` for native mail or an account that cannot be mapped; never use 0 or a fake account |
| `source_folder_id` | `TEXT` | `NULL` when the provider has no stable folder ID or it has not been synchronized |
| `source_folder` | `TEXT` | `NULL` when unknown/unmapped, not an empty string; normalized names include `INBOX` |
| `provider_message_id` | `TEXT` | `NULL` when the provider has no stable ID or history lacks it |
| `provider_thread_id` | `TEXT` | `NULL` when no native thread ID is supplied; an empty string does not mean “no thread” |
| `message_id_header` | `TEXT` | `NULL` when the RFC Message-ID header is absent |
| `in_reply_to` | `TEXT` | `NULL` when the header is absent |
| `references_json` | `TEXT` | `NULL` when absent or parsing failed; when present, it must be JSON array text |
| `source_flags_json` | `TEXT` | `NULL` when source flags were not read; a known empty set is `[]` |
| `has_attachments` | `INTEGER` | `NULL` when parsing/history is unknown; confirmed absent/present are `0/1` |
| `sync_version` | `INTEGER` | `NULL` before this normalization; successful backfill writes the migration version (for example `1`) |
| `source_key` | `TEXT` | `NULL` unless a stable, explainable composite identity can be reconstructed |

`NULL` means unknown, not synchronized, or not applicable. It is not an empty value and is not equivalent to `0`. Backfill must not turn unknown values into empty strings, zero, or `native`.

### 3.2 `mail_account_folders`

```sql
CREATE TABLE mail_account_folders (
  id INTEGER PRIMARY KEY,
  mail_account_id INTEGER NOT NULL,
  provider_folder_id TEXT,
  canonical_name TEXT NOT NULL,
  display_name TEXT,
  folder_type TEXT NOT NULL,
  last_cursor TEXT,
  last_sync_at INTEGER,
  last_error TEXT
);
```

`mail_account_id` scopes the row to `user_mail_accounts.id`; `provider_folder_id` may be NULL because an IMAP folder identity can be the name plus UIDVALIDITY. `canonical_name` is stable, while `display_name` may change with provider or locale. `folder_type` is one of `inbox`, `sent`, `drafts`, `archive`, `trash`, `spam`, or `custom`. Cursor, sync time, and error are NULL before the first sync; a successfully synchronized empty cursor follows the provider definition and is not replaced with “unknown.”

Folder uniqueness: prefer `UNIQUE(mail_account_id, provider_folder_id)` for non-NULL IDs, plus `UNIQUE(mail_account_id, canonical_name)`. Duplicate canonical names in one account must be merged or reviewed explicitly; migration must not silently overwrite them.

### 3.3 Provider identity, unique keys, and deduplication

- Provider identity is always bound to `mail_account_id`; the same message ID in two accounts means two messages.
- IMAP identity is provider `imap`, account, folder, UIDVALIDITY, and UID in `source_key`; `imap_uid` remains a legacy compatibility field.
- POP3 identity uses account + folder (usually inbox) + UIDL; a POP3 sequence number is not an identity.
- Gmail/Graph use account + provider + stable `provider_message_id`; changing folders must not create a second message.
- Native mail retains its existing identity/primary key and is not forced into an external provider key.

Where D1 supports partial/expression indexes, use:

```sql
CREATE UNIQUE INDEX emails_provider_identity_uq
ON emails(mail_account_id, provider, provider_message_id)
WHERE mail_account_id IS NOT NULL
  AND provider IS NOT NULL
  AND provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX emails_source_key_uq
ON emails(source_key)
WHERE source_key IS NOT NULL;
```

If the D1 version or existing data prevents immediate unique-index creation, first create an audit/duplicate table, merge according to an approved rule, then create the index. Keep the earliest stable primary row, preserve body/attachment references, migrate references from duplicate primary keys, and record every duplicate and decision. Conflicts must fail migration rather than trigger random deletion.

## 4. Historical backfill and migration order

Migration must be rerunnable and batched (bounded primary-key ranges with a clear per-batch limit), with observable commits after each step:

1. **Backup and baseline:** export a D1 snapshot; record row counts, NULL/duplicate counts, and `PRAGMA`/index metadata.
2. **Extend schema:** add nullable `emails` fields and create `mail_account_folders`; do not add a non-null column that blocks legacy writes.
3. **Import/normalize folders:** derive folders from account configuration and available sync metadata; stop conflicts in the audit output.
4. **Backfill account/provider:** set `mail_account_id` and provider only when an external account maps uniquely; keep native or ambiguous rows NULL.
5. **Backfill source identity:** build `source_key` from account, folder, UIDVALIDITY/UID, UIDL, or provider ID. On rerun, fill missing values or verify the same value.
6. **Dedup audit and merge:** output duplicate groups and affected primary keys first, then migrate references under an approved rule; no unaudited destructive delete.
7. **Backfill derived fields:** parse RFC headers, attachment status, and JSON; retain NULL and count failures when parsing fails.
8. **Create indexes:** only after duplicate count is zero and NULL semantics pass; verify query plans.
9. **Acceptance and observation:** test real API, IMAP proxy, and sync-ingest entries before considering a later read-path switch.

Only successful rows receive `sync_version=1`; failed rows remain retryable and are never presented as complete. During implementation, new writes must populate identity in the same transaction, but this ADR itself does not change business code.

## 5. Query indexes

In addition to unique indexes, create and verify these according to actual query plans:

```sql
CREATE INDEX emails_account_received_idx
  ON emails(mail_account_id, received_at DESC, id DESC);
CREATE INDEX emails_account_folder_received_idx
  ON emails(mail_account_id, source_folder, received_at DESC, id DESC);
CREATE INDEX emails_provider_thread_idx
  ON emails(mail_account_id, provider_thread_id);
CREATE INDEX mail_account_folders_account_type_idx
  ON mail_account_folders(mail_account_id, folder_type, canonical_name);
```

Indexes never replace owner/account scope checks. Every query must retain the existing owner/address authorization filters.

## 6. Compatibility and rollback

- Existing `/api/unified/*` continues to read existing fields and primary keys; NULL new columns leave responses unchanged.
- Legacy API pagination, ordering, detail, and deletion semantics remain unchanged; clients do not need to understand provider identity.
- The IMAP proxy continues using `imap_uid` and existing folder logic; the new identity is for deduplication and future adapters, not a replacement for protocol fields.
- Do not remove, rename, or change the type/meaning of `imap_uid`; maintain a traceable mapping from the legacy field where needed.
- Rollback means stopping backfill, removing new indexes, and restoring the snapshot. If duplicate rows have been merged, restore from the snapshot rather than attempting to guess a reverse merge.
- Before rollback in the implementation phase, stop writes that produce new identities, preserve migration logs, then verify the legacy API, IMAP proxy, and account scope after restoration.

## 7. Tests and real-entry acceptance

### 7.1 Automated tests

- schema: types, nullability, allowed provider/folder types, and index existence;
- identity: same-account same-ID idempotency, same ID across accounts, and folder moves without false copies;
- IMAP: UIDVALIDITY changes never reuse an old UID; POP3 sequence changes do not break UIDL deduplication;
- NULL: distinguish unknown, empty JSON, false, and zero;
- backfill: interrupted batch rerun, no duplicates, auditable conflicts, retryable parse failures;
- compatibility: legacy API response/pagination/deletion and `imap_uid` regressions;
- authorization: cross-user/account list, detail, and deletion are rejected;
- indexes: representative queries use expected indexes without losing NULL rows.

### 7.2 Real-entry acceptance (required before merge)

On a staging D1 matching the production version, do not test only a migration helper:

1. Log in through the real `/user_api` entry and obtain a user token;
2. use the real external-mail sync ingest/aggregator entry to import two messages with the same provider ID under different accounts, then deliver one again and verify exactly one row per account;
3. use real `/api/unified/*` list and detail entries to verify message, account, folder, and legacy fields;
4. log in and read through the real SMTP/IMAP proxy, confirming the legacy `imap_uid` path still works;
5. attempt another account's identity as an unauthorized user and verify rejection with no data leak;
6. intentionally interrupt backfill, rerun it, and verify counts, audit records, and final uniqueness;
7. perform a rollback drill and verify the legacy API, IMAP proxy, and native receiving entry recover.

Acceptance evidence must include migration version, baseline/result counts, duplicate audit, retry records, API/IMAP request logs, and index query plans. Until real-entry acceptance is complete, the status remains Proposed.

## 8. Follow-up decision gate

Only after migration and acceptance pass should a separate review consider unified-index reads, thread tables, provider write tasks, and removal of compatibility fields. Describing this ADR's Proposed content as already supported would be inaccurate.
