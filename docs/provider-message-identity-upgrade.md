# Provider message identity production upgrade

This runbook applies when upgrading an **existing** one-mail D1 database to the provider/folder/message identity schema introduced by `db/2026-09-12-provider-message-identity.sql`.

## Required deployment order

Do not deploy the new Worker against an old D1 schema. The Worker email insert contract now includes the provider identity columns, so the safe order is:

1. stop or pause the Aggregator/scheduled external-mail sync;
2. back up the production D1 database;
3. apply `db/2026-09-12-provider-message-identity.sql` to that database;
4. verify the new columns, indexes, and `mail_account_folders` table;
5. deploy the new Worker;
6. deploy/restart the new Aggregator;
7. run one account sync and verify ingest/list/detail behavior before restoring the normal schedule.

Example migration command from `worker/`:

```bash
wrangler d1 execute <database> --remote --file=../db/2026-09-12-provider-message-identity.sql
```

The admin DB migration path (`/admin/db/migrate`) also repairs the schema by inspecting the real table shape rather than trusting `db_version`, but an explicit pre-deploy migration is preferred for production because it prevents any new Worker request from racing an unmodified database.

## What the migration backfills

The migration only fills identity that is already provable from existing data:

- legacy unique `imap_uid` becomes `source_key`;
- `graph:` / `pop3:` legacy key namespaces become provider `graph` / `pop3`;
- other non-null legacy IMAP keys become provider `imap`;
- `cf_routing` rows become provider `native` with canonical folder `INBOX`.

It does **not** derive `provider_message_id` from subject, timestamp, sender, RFC `Message-ID`, or other mutable/non-provider metadata. False merging is treated as a data-loss risk.

## Graph rollout compatibility

Existing Microsoft Graph seen-watermarks remain in their legacy default-ID form so the rollout does not intentionally re-download the mailbox history window. New Graph observations resolve a Microsoft Graph **ImmutableId** and store it as `provider_message_id` / stable `source_key`.

Historical Graph rows that existed before this migration do not magically gain an ImmutableId from SQL. A later online backfill can use Microsoft Graph ID translation while authenticated to the mailbox; until then those rows retain their legacy `source_key` and null `provider_message_id`.

## Verification

After migration, verify at minimum:

```sql
PRAGMA table_info(emails);
PRAGMA index_list(emails);
PRAGMA table_info(mail_account_folders);
PRAGMA index_list(mail_account_folders);
```

Expected key indexes include:

- `idx_emails_source_key_uq`
- `idx_emails_provider_message_uq`
- `idx_emails_account_order_cursor`
- `idx_emails_account_folder_order_cursor`
- `idx_mail_account_folders_provider_id_uq`
- `idx_mail_account_folders_canonical_uq`

Then ingest the same provider message twice. The first request must report one insert; the replay must be skipped rather than creating a duplicate. For provider-stable identities (for example Graph ImmutableId), a folder move/replay must update folder metadata on the existing row rather than insert another email.

## Rollback boundary

Before the new Worker writes provider identity data, rollback is simply restoring the pre-upgrade application version (and, if desired, the D1 backup).

After the new Worker/Aggregator have written new identity rows, do not attempt to reconstruct the previous database by guessing or deleting identity columns in place. Pause writers and restore the pre-migration D1 backup if a full database rollback is required. The legacy `imap_uid` column is intentionally retained so application rollback remains possible while the upgraded database is kept.
