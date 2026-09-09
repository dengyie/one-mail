<!-- markdownlint-disable-file MD033 MD045 -->
# one-mail — Unified Inbox

<p align="center">
  <a href="README.md"><img alt="中文" src="https://img.shields.io/badge/README-中文-blue"></a>
  <a href="README_EN.md"><img alt="English" src="https://img.shields.io/badge/README-English-blue"></a>
  <a href="README_JA.md"><img alt="日本語" src="https://img.shields.io/badge/README-日本語-blue"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

> **Unified Inbox**: aggregates mail from multiple accounts (QQ / 163 / Gmail / Outlook …) into a single API on Cloudflare Workers — a VPS-based `aggregator/` polls the providers (IMAP first, POP3 fallback) and uploads into a unified D1-backed API, so verification codes and login confirmations from every mailbox land in one place.

Forked from [dreamhunter2333/cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email), keeping its temp-mail base (Cloudflare Email Routing + Worker receive + Vue frontend) and adding the **one-mail unified inbox** on top.

> External-mail support is currently primarily **one-way receiving aggregation**. Source read-state write-back, delete/archive/move, sending as external identities, threads, and complete attachment handling are still evolving. See the [Unified Mailbox Development Design](vitepress-docs/docs/en/guide/feature/unified-mailbox-development.md) for the target architecture, phased plan, and acceptance criteria.

---

## Architecture

```
Mailbox providers (IMAP/POP3)
   QQ / 163 / Gmail / Outlook ...
        │  (VPS aggregator polls)
        ▼
VPS Python aggregator  aggregator/
   │  IMAP preferred, automatic POP3 fallback
   │  BATCH_SIZE / BATCH_BYTES windowed convergence, skip oversized (anti-OOM)
   ▼
Cloudflare Worker ──mail-api.mangoqwq.cc.cd──> API (worker/)
   │  ├─ /api/unified/*        unified inbox queries (API-key auth)
   │  ├─ /admin/unified/*     management / ingest (admin auth)
   │  └─ /api/* ·/user_api/* ·/admin/*  temp-mail base (upstream)
   ▼
frontend/  —  VITE_API_BASE direct to Worker (separated frontend/backend)
```

## Components

| Component | Stack | Role |
|---|---|---|
| `worker/` | TS + Hono · Workers · D1 | Unified inbox API + temp-mail base |
| `aggregator/` | Python 3, stdlib | Polls IMAP/POP3, idempotent upload |
| `frontend/` | Vue 3 + Naive UI | UI, connects the Worker directly |
| `pages/` | static shell | optional static hosting (no Functions) |
| `db/` | D1 SQLite | unified schema + migrations |
| `mail-parser-wasm/` | Rust WASM | mail parsing (upstream base) |
| `smtp_proxy_server/` | Python | SMTP/IMAP proxy for local dev (upstream base) |

## Unified inbox

Auth — separate from the temp-mail JWT base:

| Scope | Header | Source |
|---|---|---|
| `/api/unified/*` (query) | `Authorization: Bearer <api-key>` | `POST /admin/unified/keys` |
| `/admin/unified/*` (management) | `x-admin-auth` | `ADMIN_PASSWORDS[0]` |

API keys are `readonly` or `admin`, optionally scoped by `allowed_sources` / `allowed_accounts`.

Key endpoints: `GET /api/unified/emails` (list + `q=` keyword search) · `/count` · `/verifcodes` · `/:id` · `POST /:id/read` · `POST /admin/unified/ingest` · `POST /admin/unified/keys` · `GET /admin/unified/mail_accounts` (aggregator fetches enabled user mailboxes with decrypted credentials, `x-admin-auth`) · `POST /admin/unified/mail_accounts/:id/status` (aggregator writes back sync status / `last_error`, `x-admin-auth`).

Aggregator notes:
- **`protocol: auto`** — try IMAP, fall back to POP3 on `Unsafe Login` (verified on 163), then **pin** the account so no imap:/pop3: duplicates.
- **Batched sync** — windowed by `BATCH_SIZE` (200) / `BATCH_BYTES` (64 MiB), advancing `last_uid`; oversized singles skipped above `MAX_SINGLE_BYTES` (30 MiB).
- **Idempotent** — `(uidvalidity, imap_uid)` unique index on the Worker side.

### Retention (D1)

Each `scheduled` run paginates and deletes `is_read=1` emails whose `received_at` is older than 90 days (D1 rows). R2 attachment cleanup is reserved logic (`retention.ts` only fires it when an `ATTACHMENTS` bucket is bound **and** rows carry an `r2_key`); production has no R2 binding and the aggregator never writes `r2_key`, so in practice only D1 cleanup runs.

---

## Quick start

```bash
# 1. Worker
cd worker && cp wrangler.toml.template wrangler.toml && pnpm install && pnpm deploy

# 2. Aggregator (VPS)
cd aggregator && cp config.example.json config.json   # accounts: protocol auto/imap/pop3
pip install -e .                                      # supervisord runs a 5-min loop (see deploy/README.md)

# 3. Frontend
cd frontend && cp .env.example .env.local   # VITE_API_BASE=https://<worker-domain>
pnpm install && pnpm dev
```

See `worker/wrangler.toml.template` and `aggregator/config.example.json` for all vars.

### Send-mail idempotency and unknown delivery state

`POST /api/send_mail`, `POST /external/api/send_mail`, and `POST /admin/send_mail` accept `x-idempotency-key`. When a request returns 503 (the provider may have accepted the message before the Worker timed out), retry with the same key. The same request is replay-safe; a different request with that key returns 409. Unknown deliveries keep quota and sender balance reserved until an administrator resolves them:

- List: `GET /admin/send_mail/unknown`
- Resolve: `POST /admin/send_mail/unknown/:id/resolve` with body `{"outcome":"sent"}` or `{"outcome":"rejected"}`

Back up an existing D1 database before upgrading, then run `db/2026-09-09-send-mail-delivery-state.sql` once (for example, `cd worker && wrangler d1 execute <database> --remote --file=../db/2026-09-09-send-mail-delivery-state.sql`).

## What's in this repo

A fork of [cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email) with the one-mail unified inbox layered on top. The temp-mail base (Email Routing receive, Rust-WASM parsing, SMTP proxy) is preserved; the unified inbox (D1 schema, Worker API, VPS aggregator) is this repo's addition.

## Docs & changelog

- `CHANGELOG.md` (中文) / `CHANGELOG_EN.md` (English) — version history
- `docs/` — one-mail design & acceptance notes (frontend/backend separation, aggregator)
- `vitepress-docs/` — upstream temp-mail feature docs (appendix)

## License

[MIT](LICENSE)