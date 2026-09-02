# Unified Mailbox Development Design

> This document defines how one-mail evolves from one-way external-mail aggregation into a unified mailbox that can manage multiple providers. It records the current boundary, target architecture, phased plan, and acceptance criteria.
>
> Baseline: the current `main` branch. The target capabilities below are **not** all implemented today.

## 1. Product goal and current boundary

The goal is not merely to display a combined list. Users should be able to work with Gmail, Outlook, QQ, 163, custom IMAP mailboxes, and one-mail addresses from one workspace:

- view all accounts in one inbox;
- filter by account, provider, folder, and state;
- mark read, archive, delete, move, and flag with write-back to the source;
- reply, forward, and compose using a connected account identity;
- view and download attachments;
- search complete cross-account history;
- handle ordinary mail without returning to the provider's web UI.

The current pipeline is:

```text
Source mailbox --IMAP/POP3 polling--> VPS aggregator --HTTP ingest--> Worker/D1 --query--> UnifiedInbox
```

It already supports self-service mailbox connections, IMAP-first/POP3 fallback, cursor-based idempotent ingestion, D1 isolation, unified list/detail/code views, sync status reporting, and the original one-mail real-time receive/send base.

However, external mail is still copied in one direction:

```text
source → one-mail
```

rather than:

```text
source ⇄ one-mail
```

The accurate current product description is therefore “unified inbox aggregator,” not a complete replacement for every third-party mailbox client.

## 2. Capability matrix

| Capability | Current state | Boundary |
|---|---|---|
| IMAP fetch | Available | Periodic aggregator sync |
| POP3 fetch | Available | Fallback; inherently weak read-only semantics |
| User mailbox connection | Available | `user_mail_accounts`, AES-GCM credentials |
| Gmail/Outlook OAuth | Partial backend support | Complete frontend consent flow remains |
| Multi-account inbox | Available | Isolated primarily by `to_addr` |
| Mark read | Local only | Does not write back to IMAP/Gmail/Graph |
| Delete/archive/move/flag | Missing | No unified provider write command |
| Reply/forward/compose | Missing for external accounts | Existing send mainly serves one-mail/SMTP configuration |
| Folders/labels | Incomplete | INBOX is the practical default; row lacks folder semantics |
| Threads/conversations | Missing | No thread/message-reference model |
| Attachment download | Missing | Mostly attachment metadata is stored |
| Full HTML rendering | Degraded | Unified detail primarily displays text |
| Full-text search | Basic | `LIKE` over a small set of fields |
| Real-time receive | Missing | Aggregator runs approximately every 300 seconds |
| Immediate sync/connection test | Missing | User waits for the next cycle |
| Unified native/external operations | Missing | Separate data models, pages, and flows |

## 3. Non-goals and constraints

- Do not rewrite the existing temporary-mail base.
- Use dedicated provider APIs where available; use IMAP/SMTP adapters where they are not.
- Do not maintain long-lived IMAP/POP3 connections inside a Cloudflare Worker; the VPS aggregator/provider workers own long connections and slow operations.
- Do not build AI automation before basic mail operations are complete.
- Do not describe POP3 as supporting complete bidirectional synchronization.
- Keep existing `emails`, `user_mail_accounts`, `/api/unified/*`, `x-user-token`, and Bearer API-key compatibility through additive migrations.
- Keep the current `MAIL_CRED_ENCRYPTION_KEY` deployment choice in this plan; key rotation is a separate operational project.
- Preserve user scope isolation for every query, mutation, attachment download, and send operation.
- Every provider write must be idempotent, retryable, and isolated per account.

## 4. Target architecture

```text
Vue unified workspace
        │
        ▼
Worker Unified API (auth, scope, commands, job status)
        │
        ├── D1: unified index, threads, mutation logs, cursors
        ├── R2: attachments and optional raw MIME
        └── Queue/tasks: asynchronous writes and retries
                │
                ▼
VPS aggregator / provider workers
        ├── Gmail API adapter (OAuth)
        ├── Microsoft Graph adapter (OAuth)
        ├── IMAP/SMTP adapter (QQ, 163, custom)
        └── one-mail native adapter
```

The Worker handles short requests, authorization, and state. Provider workers handle external connections, long operations, and vendor differences.

### Provider adapter contract

Do not scatter Gmail, Outlook, QQ, and 163 branches through Worker routes and the Python sync loop. Define one capability-aware adapter contract:

```ts
interface MailProviderAdapter {
  listFolders(ctx: ProviderContext): Promise<Folder[]>;
  listMessages(ctx: ProviderContext, cursor: SyncCursor): Promise<MessagePage>;
  getMessage(ctx: ProviderContext, id: ProviderMessageId): Promise<UnifiedMessage>;
  setRead(ctx: ProviderContext, id: ProviderMessageId, read: boolean): Promise<void>;
  move(ctx: ProviderContext, id: ProviderMessageId, destination: string): Promise<void>;
  delete(ctx: ProviderContext, id: ProviderMessageId): Promise<void>;
  setFlag(ctx: ProviderContext, id: ProviderMessageId, flag: string, value: boolean): Promise<void>;
  send(ctx: ProviderContext, message: OutgoingMessage): Promise<SendResult>;
  createDraft?(ctx: ProviderContext, message: DraftMessage): Promise<DraftResult>;
}
```

Adapters must expose capabilities such as `writeState`, `send`, `drafts`, `folders`, `threads`, and `attachments`. The UI must disable unsupported actions and explain why; it must never present an unsupported action as successful.

## 5. Data-model evolution

The current `emails` table is closer to a message-copy table. The target is a unified index that retains a traceable source object.

### Recommended `emails` additions

```text
provider
mail_account_id
source_folder
source_folder_id
provider_message_id
provider_thread_id
message_id_header
in_reply_to
references_json
source_flags_json
has_attachments
sync_version
```

Migration rules:

- retain `imap_uid` for compatibility;
- prefer uniqueness on `mail_account_id + provider_message_id`;
- for IMAP use `uidvalidity + folder + uid`; for POP3 use UIDL;
- never use only host + UID as a global identity;
- historical rows lacking source identity must not be silently guessed into threads.

### Folder and thread tables

Add a `mail_account_folders` table with provider folder ID, canonical/display names, folder type, cursor, sync time, and error state.

Add `mail_threads` and `mail_thread_messages` tables. Thread merge priority should be:

1. native provider thread/conversation ID;
2. RFC `Message-ID`, `In-Reply-To`, and `References`;
3. constrained subject/participant/time-window heuristic;
4. if uncertain, keep messages separate rather than incorrectly merging them.

### Mutation jobs

External writes should use a `mail_mutation_jobs` table containing account, email, operation, payload, idempotency key, status, attempts, retry time, and last error. This handles timeouts, expired OAuth tokens, retries, and duplicate clicks without holding an HTTP request open.

## 6. API design

Keep these query APIs compatible:

```text
GET /api/unified/emails
GET /api/unified/emails/:id
GET /api/unified/count
GET /api/unified/verifcodes
```

Extend filters with `folder`, `thread_id`, `has_attachments`, `from`, `to`, `after`, and `before` while retaining `source`, `account_id`, `unread`, and `q`.

### Unified state actions

```text
POST /api/unified/emails/:id/read
POST /api/unified/emails/:id/unread
POST /api/unified/emails/:id/archive
POST /api/unified/emails/:id/trash
POST /api/unified/emails/:id/spam
POST /api/unified/emails/:id/star
POST /api/unified/emails/:id/move
```

Return `queued` plus a `job_id` when the source has not completed. Do not report completion prematurely.

### Compose, reply, forward, drafts

```text
POST /api/unified/send
POST /api/unified/emails/:id/reply
POST /api/unified/emails/:id/forward
POST /api/unified/drafts
PATCH /api/unified/drafts/:id
POST /api/unified/drafts/:id/send
```

Requests select `mail_account_id`, not an arbitrary From address. The account must belong to the caller; From is derived and validated server-side. Send limits, recipient limits, attachment limits, MIME safety, Sent indexing, and provider errors are mandatory concerns.

## 7. Synchronization and real-time delivery

First make polling reliable: independent account/folder cursors, explicit full rebuild versus incremental sync, per-account failure isolation, dropped-message metrics, visible sync duration/count/error, and a user-triggered “sync now” operation.

Then improve latency by provider:

1. Gmail Pub/Sub;
2. Microsoft Graph webhooks;
3. IMAP IDLE on VPS with connection limits and reconnect handling;
4. polling for remaining providers.

Push events should trigger a real provider fetch; they should not be treated as complete message payloads. Deduplication remains mandatory.

The frontend should offer manual refresh, last-sync time, incremental update notices, and optional SSE/WebSocket or short polling.

## 8. Attachments and message bodies

External attachments should flow through:

```text
provider → aggregator → R2
                    ↘ D1 metadata
```

Store filename, MIME type, size, R2 key, checksum, and email ownership. Downloads must enforce scope, use short-lived URLs or a Worker proxy, and never expose provider credentials.

Unified detail must reuse the existing `sanitizeHtmlMail` and remote-resource policy: sanitize scripts, event attributes, dangerous URLs, and active resources by default; allow only an explicit per-message remote-image action; and keep sanitization inside the renderer rather than relying on every caller.

## 9. Phased implementation plan

### Phase 0: baseline and observability

Complete POP3 host/port/SSL and folder configuration; add connection test, sync-now, sync history, consistent HTML rendering, source/folder identity, metrics, and deployment-version checks.

**Acceptance:** wrong credentials appear on the account page; one account failure does not stop others; repeated syncs do not duplicate rows; users can see the last successful sync.

### Phase 1: unified message index

Add source identity and folder/message headers; build folder mapping; complete Gmail/Outlook OAuth UI; store attachments in R2; implement FTS or equivalent search; converge native and external list/detail views.

**Acceptance:** users can search by account, folder, attachment, sender, and date; attachments open without returning to the provider; expired OAuth clearly requests reauthorization.

### Phase 2: bidirectional state

Implement read/unread, archive, trash/delete, move, star/flag, mutation jobs, idempotency, retries, pending/success/failure state, and provider capability handling.

**Acceptance:** each supported action is verifiable in the source mailbox; failures are not reported as success; repeated clicks are safe; terminal failures are visible and retryable.

### Phase 3: unified sending

Implement Gmail, Graph, and generic IMAP/SMTP adapters; compose, reply-all, forward, drafts, MIME headers, attachments, Sent indexing, account selection, and From validation.

**Acceptance:** a Gmail-identity reply appears in Gmail Sent; QQ/163 failures are explicit; replies join the correct thread.

### Phase 4: threads, rules, and real-time behavior

Add native/RFC thread merging, provider push/IDLE, batch actions, labels/rules, AI automation, export, and disconnect cleanup.

**Acceptance:** conversations remain stable across supported providers; new mail is near-real-time where provider capability permits; batch results are itemized.

## 10. Testing strategy

Unit-test identity/dedup keys, folder mapping, thread merge, capabilities, scope checks, idempotency, retry backoff, and HTML/attachment safety.

Integration-test OAuth refresh, IMAP mutations, POP3 capability restrictions, SMTP sending and Sent indexing, per-account failure isolation, duplicate webhook/poll events, cross-user reads/downloads/mutations, expiring download URLs, and source-success/local-timeout eventual consistency.

Before release:

```bash
pnpm --dir worker lint
pnpm --dir worker build
pnpm --dir frontend test -- --run
pnpm --dir frontend build
git diff --check
```

A new provider or schema migration requires corresponding tests and real-entry verification in a test environment. Compilation alone is not completion evidence.

## 11. Known risks

- The aggregator currently polls about every 300 seconds, which is slow for verification codes.
- POP3 cannot provide complete folder, read-state, or thread semantics.
- Existing D1 rows lack complete source identity and cannot be safely re-threaded without a migration policy.
- Attachment support must not be advertised as complete while R2 is unbound and only metadata is stored.
- Native and external mail still have separate UI/API paths and should converge incrementally.
- Public or multi-user deployment should eventually move credentials to a safer secret-management design and define rotation procedures.
- Production must verify that the live domain, Worker API, aggregator configuration, frontend build, and documentation describe the same version.

## 12. Definition of Done

Only describe one-mail as a unified external-mail manager when all of the following are true:

- Gmail, Outlook, and at least one generic IMAP/SMTP provider have a verified read/write loop;
- read, archive, delete, and move write back to the source;
- reply, forward, and compose can select an external account identity;
- Sent, threads, and attachments have verifiable consistency;
- cross-user isolation has automated regression coverage;
- unsupported provider capabilities are visible in the UI;
- sync, mutations, and sending have retry, idempotency, and observable state;
- live deployment, Worker routes, aggregator configuration, and documentation are aligned.

Until then, use this description:

> one-mail provides unified multi-mailbox receiving and verification-code aggregation, while bidirectional external-mail management is under development.
