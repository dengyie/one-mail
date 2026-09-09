<!-- markdownlint-disable-file MD004 MD024 MD033 MD034 MD036 -->
# CHANGE LOG

<p align="center">
  <a href="CHANGELOG.md">中文</a> |
  <a href="CHANGELOG_EN.md">English</a>
</p>

## v1.11.0(main)

- fix: |Worker| Delete imported mail for a user in the same D1 transaction, preventing a later same-name mailbox from seeing deleted history; administrator role tokens no longer bypass the x-admin-auth password gate.

- fix: |OAuth| Generate and return a random state from the Worker login-link endpoint, fixing the frontend path that otherwise always failed state validation and preventing callers from predicting or reusing state.

- fix: |Worker| Make user deletion and address transfer atomic in D1: deletion removes roles, passkeys, external-mail credentials, and ownership links together, revoked user JWTs stop working immediately, and transfer no longer has a delete-then-recreate data-loss window.

- fix: |Worker| Store user and address passwords as salted server-side PBKDF2 verifiers: browser login/registration/password changes now send the raw password over HTTPS, while legacy SHA-256 clients remain accepted and migrate after successful authentication; the reusable client digest is no longer used as the database password.

- fix: |Worker| Make send-mail quota reservations durable in D1: slot allocation and the send attempt are persisted atomically, while failed or abandoned reservations are recoverable by the request path and scheduled reconciler instead of permanently exhausting the daily counter.

- feat: |Aggregator| Add OAuth2/XOAUTH2 onboarding for **personal Hotmail / Outlook.com (MSA)** accounts: since Microsoft has disabled IMAP Basic authentication in all tenants (App Passwords also unavailable for many accounts), `aggregator/oauth.py` adds `msa_access_token` using the `/consumers` tenant with a public client (no `client_secret` required, scope `IMAP.AccessAsUser.All offline_access`) while reusing the existing `oauth2_login` XOAUTH2 channel; `normalize_provider` maps `hotmail`/`outlook_personal` to `msa` so all three `provider` spellings work in `config.json`; the Worker `user_api/mail_accounts.ts` `OAUTH_PROVIDERS` whitelist now accepts `msa`/`hotmail`/`outlook_personal`; added `aggregator/scripts/msa_authorize.py` (Device Code Flow) to obtain a long-lived `refresh_token` in one run; `config.example.json` and the deploy README document personal-account onboarding; organizational accounts still use `outlook` + secret, unchanged. Tests: 10 new MSA cases (no-secret public client / optional secret / 400 rejection / provider normalization / factory routing / aliases) — aggregator 126 pass, worker 127 pass, vitepress build green.

- feat: |Worker| Phase 0 external-mail connection test and immediate-sync contracts: added user-ownership-checked `test-connection` / `sync` routes; because the Worker has no VPS/queue dispatch binding yet, they explicitly return `501 unsupported` and never fake connection success or queued state.

### Features

- fix: |Aggregator| Phase 0 external-mail configuration closure: preserve IMAP/POP3 host, port, SSL/STLS, and folders from remote accounts into AccountConfig/sync, with malformed folders safely falling back to `INBOX`
- feat: |Frontend/CI| Deep frontend modernization and awesome-ui-kit integration: fully assembled 14 atomic components including `ThemeToggle`, `StatusIndicator`, `ThinkingBlock`, `StreamMarkdown`, `ChatPromptInput`, `PromptChips`, and `MessageActionToolbar`; added interactive AI email assistant drawer with summary and reply drafting; modernized `AiExtractInfo` with large monospace OTP and 1-click copy; integrated Auto/Light/Dark segmented theme switcher across `Header` and `Appearance`; added GitHub Actions `.github/workflows/deploy.yml` for automated CI test gate and automated pxed frontend deployment on push to main
- feat: |Worker| Add Bearer API-key authentication for the unified mailbox API, including readonly source/account scoping and admin access
- feat: |Worker| Add complete unified inbox query endpoints: `GET /api/unified/emails?source=&account=&unread=&q=` (`q=` full-text search), `GET /api/unified/count?source=&unread=`, `GET /api/unified/verifcodes?addr=&fresh=`, and `POST /api/unified/emails/:id/read` (admin API-key only), plus a verification-code extraction pure function and verifcode mail lookup; add `POST /admin/unified/keys` (x-admin-auth protected) to create API keys with an optional role and source/account whitelists, returning the plaintext key only once at creation (one-mail unified inbox)
- feat: |Worker| Add 90-day read-email retention cleanup to the one-mail unified inbox: each `scheduled` run deletes `is_read=1` emails whose `received_at` is older than 90 days, and deletes their associated R2 attachment keys when an `ATTACHMENTS` bucket is configured (one-mail M5 retention)
- feat: |Frontend| Full frontend/backend separation: the frontend now uses the single form of cross-origin direct connection to the Worker — `VITE_API_BASE` points to the Worker custom domain `mail-api.mangoqwq.cc.cd`, and `vite.config.js` adds a dev `server.proxy` (local `pnpm dev` talks directly to `127.0.0.1:8787` instead of 404ing); the deprecated Pages Functions proxy topology is removed (`pages/functions/_middleware.js` + `[[services]] BACKEND` in `pages/wrangler.toml` + `frontend_pagefunction_deploy.yaml`), and `API_PATHS` converges to a single source in `worker/src/worker.ts`; `pages/wrangler.toml` degrades to pure static hosting (see `docs/superpowers/specs/2026-08-21-frontend-backend-separation.md`)
- feat: |Frontend| Add the unified inbox frontend page (routes `/unified`, `/unified/:id`): assembled with Tailwind + awesome-ui components and four views — ① Mail list (pagination + `source`/`account_id`/`unread` filters + `q` keyword search; row click opens detail) ② Verification-code aggregation (recipient `addr` + `fresh` window; highlighted `code` with one-click copy) ③ Aggregator runtime status cards (totals / unread / sources / accounts derived from `/api/unified/count` plus list rows, with a `StatusIndicator` online badge) ④ API-key settings (saved to localStorage, test connection, admins can create a key whose plaintext is shown only once). Wires Tailwind v4 (`@tailwindcss/vite` + `@custom-variant dark` class strategy so `dark:` utilities follow the site-wide `useDark`); `src/api/index.js` gains `unifiedFetch` (injects only `Authorization: Bearer <unifiedApiKey>`, reuses `safeBearerHeader`, never sends the site JWT) plus `api.unified.*` / `api.admin.createUnifiedKey`; the store gains `unifiedApiKey`; the top nav gains a "Unified" entry; a `unified` i18n namespace (zh/en) and the frontend-dev docs section are added
- feat: |Unified Inbox| Integrate the existing user account system: logged-in users access the inbox with `x-user-token`; users matching `ADMIN_USER_ROLE` can see all mail, while normal users are limited to their bound addresses through `users_address → address.name → emails.to_addr`. Bearer API-key access remains available for scripts, and list, detail, verification-code, count, and mark-read operations enforce the appropriate scope. The frontend shows a login entry when neither a user session nor an API key is available.
- chore: |Unified Inbox| Account-system production config: added `USER_ROLES` (roles `admin`/`user`) and `ADMIN_USER_ROLE=admin` to the Worker `wrangler.toml`; enabled user registration via the D1 `settings.user_settings` row (`enable:true, enableMailVerify:false` — mail verify off because no KV is bound); created the admin account `admin@mangoqwq.com` with `user_roles.role_text=admin`. Rebuilt the frontend with `pnpm build:pages` (`.env.pages` points at `mail-api.mangoqwq.cc.cd`) and uploaded it to pxed nginx `/opt/one-mail-frontend/dist`.
- feat: |Unified Inbox| Registration abuse-prevention hardening before opening to many users: ①bound a KV namespace (`binding=KV`) — the register `verify_code` flow now stores codes in KV and, under `enableMailVerify:true`, gates on "email verification code + Turnstile"; ②`/user_api/register` and `/user_api/verify_code` gain a KV-counter rate limit (`checkRegistrationRateLimit`, 5 req/min/IP, 429 when exceeded, fail-open), replacing the Cloudflare ratelimit binding that does not resolve on this account; ③enabled `CF_TURNSTILE_SITE_KEY`/`CF_TURNSTILE_SECRET_KEY`/`ENABLE_GLOBAL_TURNSTILE_CHECK` so login and registration both verify Turnstile; ④`DISABLE_ANONYMOUS_USER_CREATE_EMAIL=true` disables anonymous address creation so the `maxAddressCount` quota applies to everyone; ⑤D1 `settings.user_settings` sets `verifyMailSender=noreply@mangoqwq.cc.cd`, sending verification codes via `SEND_MAIL`. Added i18n `RateLimitExceededMsg` (zh/en).
- feat: |Unified Inbox| Self-service external mailbox aggregation for normal users (Gmail/QQ/163/Outlook/any IMAP·POP3): on the "My Mailboxes" page the user enters the external mailbox IMAP/POP3 host·port·address·app-password; the Worker encrypts it with AES-GCM (`MAIL_CRED_ENCRYPTION_KEY`, 32-byte base64) into a new D1 table `user_mail_accounts.cred_enc` — plaintext is never persisted. Each aggregator run fetches `enabled=1` user mailboxes via `GET /admin/unified/mail_accounts` (`x-admin-auth` protected), decrypts the credentials, and syncs them merged+deduped with the admin `config.json` accounts (a single account failure does not block others). Added `user_api/cred_crypto.ts` (AES-GCM encrypt/decrypt, fail-closed when no key), `user_api/mail_accounts.ts` (user CRUD + auto-bind by to_addr + 5-per-user cap + 5/min rate limit), and `aggregator/remote_accounts.py` (fetch and map to `AccountConfig`); `userAddressScope` (`api_keys.ts`) now UNIONs `user_mail_accounts.username`, so isolation comes straight from the user's connected records and does not depend on the `users_address.address_id` UNIQUE constraint — two users connecting the same external address are isolated independently. Frontend adds `UserMailAccounts.vue` (tab `user_mail_accounts`, Naive UI form), `api.userMailAccounts.*`, and i18n `views.user.UserMailAccounts`/`views.User.user_mail_accounts` (zh/en). Tests: worker `cred_crypto` 6 (round-trip / random iv / tamper-reject / missing-key fail-closed / wrong-key reject / Unicode), aggregator `remote_accounts` 4, all 32+56+60 pass. Docs add `guide/worker-vars.md` (`MAIL_CRED_ENCRYPTION_KEY`) and `guide/feature/user-external-mail` (zh/en).
- fix: |Unified Inbox| External mail aggregation review hardening (post code review): ①**Reachability** (`normalize.py`) `to_addr` is now always `account.username`, not the `To:` header — alias (`user+tag@`), mailing-list forwarding, bcc, and multi-recipient cases no longer mismatch the ownership scope into orphaned mail; every fetched mail is visible to its mailbox owner (the original `To:` header is still preserved verbatim in `headers_json`). The isolation layer already prevented cross-tenant leakage; this fixes reachability, not leakage. ②**Status write-back** (`mail_accounts.ts` new `reportStatus` + `unified/index.ts` mounts `POST /admin/unified/mail_accounts/:id/status`, `x-admin-auth` protected): after each aggregator sync the `last_sync_at`/`last_error` are written back (including decrypt failures) so a wrong app-password surfaces on the "My Mailboxes" page instead of silently receiving no mail; `main.py` dedups by `(host, username)` (replacing single-username dedup, preventing admin/user credential contention when both configure the same mailbox). ③**Address-page guard** (`admin_api/address_api.ts`): list/count exclude `source_meta='external'` reference rows and the delete endpoint refuses external reference rows — prevents an admin from mistaking a user's connected external mailbox for a site address and deleting it (which would break ownership isolation); `email/index.ts` unknown-address gate also excludes external reference rows (defensive). ④**Robustness** (`mail_accounts.ts`): `safeFolders` wraps `folders_json` parsing in try/catch falling back to `["INBOX"]`, so one malformed row can't 500 the whole list; create validates `folders` is an array, caps `port` at 65535, and coerces `label` via `String()` to avoid a non-string crash. ⑤**Tests**: new `api_keys.test.mjs` isolation regression (3: `userAddressScope` comma list / `__none__` fail-closed sentinel / two users with the same external address isolated), `remote_accounts` `report_sync_status` (4: success / failure / 404 silent / network error does not raise); `aggregator/conftest.py` path shim makes a fresh clone's `pytest` runnable out-of-the-box. All 21+64 pass.
- fix: |Unified Inbox| Narrowed Turnstile enforcement to registration endpoints only (2026-08-22): login shields were too much friction (`site_login`/`address_login`/`credential_login` + 4 frontend login pages), while registration is the real anti-abuse entry point. ①`wrangler.toml` sets `ENABLE_GLOBAL_TURNSTILE_CHECK=false` (was `true`) — the three login checks in `open_api/auth.ts` are gated by `isGlobalTurnstileEnabled` and disable automatically; the 4 frontend login pages' `<Turnstile v-if="openSettings.enableGlobalTurnstileCheck">` vanish too. ②The address-creation shields were hardcoded and removed in code — `new_address.ts` drops the `checkCfTurnstile` check and `cf_token` (production address creation is already guarded by `DISABLE_ANONYMOUS_USER_CREATE_EMAIL` forced login + `maxAddressCount` quota + `checkRegistrationRateLimit` rate limiting, so the shield was redundant); `telegram_api/miniapp.ts` `newTelegramAddress` removes it too (Telegram address creation already authenticates via initData HMAC signature, a strong auth); `Login.vue` removes the unconditional `<Turnstile>` on the anonymous address-creation form. ③**Registration shield fully retained** — `user_api/user.ts` `verifyCode` checks Turnstile unconditionally, `register` checks it when `!enableMailVerify` (when mail verification is on, `verify_code` covers it), and passkey registration was gated by `isGlobalTurnstileEnabled` so it turns off too. Verified live: `/user_api/verify_code` and `/user_api/register` without `cf_token` both return 400 (shield active); `/api/site_login` and `/api/address_login` without `cf_token` return login-failure text (`Invalid address credential` / `Password login is disabled`) instead of `Turnstile check failed` — shield removed. New frontend bundle deployed to pxed `/opt/one-mail-frontend/dist`.
- fix: |Docs/Deploy| Fixed three doc-vs-code-vs-deploy inconsistencies found in a project review: ①**Fictional endpoint `GET /api/unified/search`** — README (zh/en) and CHANGELOG (zh/en) listed this route, but it was never implemented; search is `GET /api/unified/emails?q=` (`unified_query.ts`). Docs updated to the `q=` parameter (README endpoint table folded into the `emails` row; CHANGELOG endpoint list corrected); confirmed no frontend caller depended on it. ②**R2 attachment-cleanup doc overclaim** — README said it "deletes related R2 attachment keys", but neither `wrangler.toml` nor `.template` binds R2, and `normalize.py`/`unified_store.ts` never write `r2_key` (`retention.ts:10` admits this); retention cleanup actually only deletes D1 rows. README (zh/en) corrected to "D1-only, R2 is reserved logic"; `retention.ts`'s `if (bucket)` guard was already safe (no-op with no binding) and is left in place; the historical CHANGELOG entries used conditional wording ("*when an ATTACHMENTS bucket is configured*") and were not fabricated, so they stand. ③**Deploy-topology doc misleading** — `aggregator/deploy/README.md` instructed `cp one-mail-agg.{service,timer} /etc/systemd/system/` + `systemctl enable --now one-mail-agg.timer`, but pxed never ran systemd for this (`disabled`, and pxed isn't booted with systemd as PID 1); the real runner is supervisord `program:one-mail-agg` → `agg-loop.sh` (every 300s). Worse, `agg-loop.sh` and the supervisor conf were **never committed**, so a fresh clone couldn't reproduce the deploy. Fix: deleted the dead `one-mail-agg.service`/`.timer` from the repo and `/etc/systemd/system/one-mail-agg.*` on pxed; added `aggregator/deploy/agg-loop.sh` (+x) and `one-mail-agg.supervisor.conf` to the repo; rewrote `deploy/README.md` to the supervisord flow; README (zh/en) "supervisor/systemd" → "supervisord". Synced to pxed via scp and ran `supervisorctl reread/update` ("No config updates to processes", pid unchanged); the aggregator loop is verified still syncing normally (qq-main IMAP / mail163-main POP3).
- feat: |Unified Inbox| Role-based external-mailbox quota (Part 3 quota tightening): ①**External mailbox cap moved from the hardcoded 5 to `role_address_config.maxMailAccountCount`** — configurable alongside `maxAddressCount`; the admin "Role Address Config" page gains a "Max External Mailboxes (0 = Unlimited)" column (`RoleAddressConfig.vue`). Missing/negative falls back to the global default 5, and 0 means unlimited — same semantics as the address quota. Added `getMaxMailAccountCount` in the new `worker/src/quota.ts` (parallels `getMaxAddressCount`, reads `role_address_config[role].maxMailAccountCount`); `mail_accounts.ts` `create` uses it to replace the hardcoded `MAX_MAIL_ACCOUNTS_PER_USER`; `admin_user_api.ts` `saveRoleAddressConfig` validates the new field is non-negative; `models/index.ts` `RoleConfig` gains `maxMailAccountCount?`. ②**Frontend** `RoleAddressConfig.vue` adds the `NInputNumber` column, i18n `maxMailAccountCount`/`notConfiguredMailAccount` (zh/en), and `roleConfigDesc` notes external mailboxes are counted separately. ③**Testability**: the three quota functions were extracted to `quota.ts` (imports only `hono`, zero relative imports — matching the project convention that modules loaded by `node --test` have no relative paths, since `utils.ts` via `gzip.ts`→`./models` has a type-only value import that `--experimental-strip-types` rejects); `utils.ts` re-exports them so callers keep `import from "../utils"`. New `utils_quota.test.mjs` adds 6 regression tests (2 cross-contamination count + 4 role-based quota), all 52 pass. Docs add `guide/feature/user-external-mail.md` (a "Connection-count quota" section explaining `maxMailAccountCount` role config and separate external-mailbox counting, zh/en).
- fix: |Unified Inbox| Fixed the address-quota cross-contamination bug (Part 3 quota tightening): `isAddressCountLimitReached` (`quota.ts`) counted `SELECT COUNT(*) FROM users_address WHERE user_id=?` **without filtering `source_meta`**, so the `source_meta='external'` placeholder binding rows written by `ensureExternalBinding` when a user connects an external mailbox **silently consumed the `maxAddressCount` quota** — contradicting the `mail_accounts.ts` header comment that "external mailboxes are counted separately and do not consume the address quota" (after connecting 5 external mailboxes, a user with `maxAddressCount=5` was full and could not create any site address). Fix: the count now does `JOIN address a ON a.id=ua.address_id WHERE (a.source_meta IS NULL OR a.source_meta != 'external')`, excluding the external reference rows. This matches the existing "external reference rows don't count as site addresses" convention already used by `admin_api/address_api.ts` list/count and the `email/index.ts` unknown-address gate; `JOIN` (not `LEFT JOIN`) means that if an `address` row is erroneously deleted while `users_address` lingers, the count excludes it rather than penalizing the user. Benefiting callers — `new_address.ts`, `user_api/bind_address.ts` (create/transfer), `mail_accounts.ts` — need no per-site changes. Regression test pins: a user with 3 site addresses + 2 external bindings is allowed at `maxAddressCount=5` (count is 3, not 5).
- docs: |README| I2 fix fictional /admin/unified/accounts endpoint to real /admin/unified/mail_accounts and /status back-write

### Bug Fixes

- fix: |frontend| security (R3/OAuth): callback state round-trip + CSPRNG generation — the `UserOauth2Callback.vue` `POST /user_api/oauth2/callback` body now always carries `state` (preferring `route.query.state`, falling back to the store's `userOauth2SessionState` session value; when neither exists it sends an empty string for the backend to reject fail-closed, so no legacy-session code-exchange path survives); the OAuth state in `UserLogin.vue` switched from `Math.random().toString(36).substring(2)` to a 32-byte `crypto.getRandomValues` hex digest (a weak random state can be guessed for a CSRF code-exchange). Complements the worker-side R3 unconditional state check
- fix: |frontend| security (H4): unified sanitisation of send-mail previews — the raw `v-html="sendMailModel.content"` in `views/index/SendMail.vue` and `views/admin/SendMail.vue` now renders through `safePreviewContent`, which reuses the project-wide `src/utils/sanitize-html.js` `sanitizeHtml` (DOMPurify default allowlist + `ALLOWED_URI_REGEXP` narrowed to `http/https/mailto`, stripping `javascript:`/`data:text/html`/`form action` and event handlers); `SendBox.vue` already used the same import (previously a bare DOMPurify call that now automatically inherits the stricter URI policy). The rich-text editor is a `naive-input` that can accept pasted external HTML (e.g. quotting an original mail when replying), and the backend sends `is_html` verbatim, so this layer is the last defence before sending. Tests: added strict-policy unit cases for `sanitizeHtml` (javascript: href / form action / data:text/html / event attributes stripped, http kept), `sanitize-html.test.js` 69→76
- fix: |frontend| security (R1 CRITICAL): main mail-body XSS channel closed — the `autoLoadRemoteImages` store default flips from `true` to `false`, and `MailContentRenderer.vue` `processedMail` no longer skips sanitization when that switch is set: the body is ALWAYS passed through `sanitizeHtmlMail` (DOMPurify + remote-resource blocking + strict URI regexp) regardless of switch state, and `autoLoadRemoteImages`/per-mail `showRemoteImages` only lifts the remote-`<img src>` block on the already-sanitised HTML (`blockRemoteContent(html, { allowRemote: true })`, which surrenders only IMG src under the same `ALLOWED_URI_REGEXP` — scripts, event handlers, `javascript:`, CSS `url()` and the default path are stripped exactly as before). This kills the `<script>/<img onerror>/<a href=javascript:>` execution channel through the main document (shadowRoot.innerHTML / iframe srcdoc). **Behavior change**: with the switch off, remote images in a mail body no longer auto-load (a notice plus the "load images" button remains); the toggle now grants an extra *resource* permission on clean HTML, it can no longer be a sanitisation bypass. Tests: new assertions for `blockRemoteContent(…,{allowRemote:true})` (malicious scripts still stripped, remote img kept, per-call state never leaks across invocations)
- fix: |Aggregator| H1 unknown-SIZE skips no longer advance the watermark — fixes an entire batch of new mail being silently and permanently lost: `fetch_new_messages` skipped messages whose `RFC822.SIZE` was missing (servers that don't support the SIZE attribute, common on imap_custom) via a fail-closed path, but every skip also did `set_last_uid(u)` — advancing the watermark past unread mail, so `last_uid+1:*` would never retry that batch. Every new email was skipped before its content was read while the watermark advanced, silently losing the whole batch with only `synced=0` in the logs and no alert. Fix: messages with missing SIZE are skipped (counted in `dropped` and logged with an `unknown-size skip uid=<u>` warning) but the watermark is **not advanced** — the next run retries from the original start (re-fetching the SIZE list each round is acceptable), so new mail is never lost; genuinely `MAX_SINGLE_BYTES`-oversize messages still advance the watermark as before (the two semantics are separated). Regression tests: all-SIZE-missing leaves the watermark untouched and a next round on server SIZE recovery re-fetches the whole batch from the start (asserting no mail is lost and the `dropped` count is correct); partial-missing skips only the unknown ones without advancing the watermark, while picked messages advance correctly through the sync layer (commit pending)
- fix: |auth| I7a address JWT now carries an `exp` claim (default 90d, configurable via `ADDRESS_JWT_TTL_DAYS`) plus `REJECT_EXPLESS_JWT` default-false (~90d grace period before rejecting legacy no-exp tokens)
- fix: |rate-limit| I7b registration rate limit now warns on KV errors (fail-open retained so a KV outage never locks registration site-wide)
- fix: |admin| I7c admin login lockout (per-IP counter, locked after ≥10 failures in a 15min window, fail-closed when KV is unreachable)
- fix: |webhook| I7d webhook URL SSRF protection (rejects private/loopback/metadata addresses; Workers has no DNS module, so runtime DNS-rebinding stays a residual risk)
- fix: |quota| I7e mail-account quota TOCTOU compensation (recounts after INSERT and deletes the row when over the cap); address quota accepted-low (soft cap, race overshoot bounded at 1)
- fix: |frontend| C3 logout clears all auth credentials (adminAuth/auth/jwt/userJwt/oauth2 session), fixing shared-device residue that allowed continued access
- fix: |Worker| Scoped readonly key privilege escalation read (C1 [security]): `inWhitelist` previously granted access when a whitelist was configured but the row's `account_id`/`source` was `NULL` (or empty after comma-split), letting a scoped key read rows outside their scope (fail-open). Now fail-closed: NULL/empty row values are always rejected; only `undefined` (the request dimension not supplied) passes through for `scopeQuery` to inject the whitelist. `ingest.ts` now also requires a non-empty `account_id`, so NULL-account rows can't be created (commit `f574b04`)
- fix: |auth| The three `/open_api/*_login` routes (site/admin/credential) returned 500 on empty or non-JSON bodies (`c.req.json()` throws `Unexpected end of JSON input`). Extracted `parseLoginBody` that catches to `{}`, letting each route's existing `!password`/`!credential` check return 401 — same semantics as a wrong password, so a prober learns nothing about whether the body was missing vs the password wrong. Pre-existing upstream cloudflare_temp_email defect, not introduced by this review.
- fix: |Worker| Dedicated row-level auth entry point (C1 review Important-2): added `canAccessRow(key, source, accountId)` for `getEmail`'s per-row source/account check, which is fail-closed on `undefined` too (a NULL DB row value accidentally coerced to `undefined` can no longer silently reopen C1); `canAccess` keeps its request-layer semantics (middleware passes missing filter params to `scopeQuery` for whitelist injection). Tests cover: row-level `undefined`/NULL/empty/out-of-scope all denied, while an unscoped key keeps the "any row readable" behavior
- fix: |Aggregator| `normalize._attachments` had no guard around `get_payload(decode=True)`; a single malformed-base64 attachment could crash an entire sync batch, wedge the watermark, and deadlock the account permanently (C3 [reliability]). Now skips corrupt attachments with a `try/except` like `_bodies`, plus regression test (commit `f574b04`)
- fix: |Aggregator| Per-message guard at the sync boundary (C3 hardening): `sync_imap` and `sync_pop3` now build batches with per-message `try/except` instead of one list comprehension, so a single `normalize_message` crash (bad attachment/header/anything) no longer aborts the whole batch. IMAP skips the bad message and still advances `last_uid` to the window's max UID (including the bad one, so the same window is never re-fetched every round — consistent with the `MAX_SINGLE_BYTES` skip semantics); POP3 skips the bad UIDL without marking it seen, retrying it next round. Covered by edge-case tests: bad single message skipped, the rest upload, and the watermark still advances when the whole window is bad
- feat: |Aggregator| Dropped-counter observability (review Important-2): the `sync_account` return shape now includes a `dropped` field — aggregating fetch-layer `MAX_SINGLE_BYTES` oversize skips (IMAP/POP3) with sync-layer per-message normalize failures; `run_once` logs one line per account with `protocol=… synced=N dropped=M`. Previously these dropped messages only scattered as per-message warnings in the logs and couldn't be alerted on; a health check can now monitor the single `dropped` number to catch "how many messages were abandoned this round." Boundary tests: an all-oversize IMAP window is fully counted, and oversize-lazy-skip POP3 messages are counted
- fix: |Aggregator| Monotonic watermark fix (review finding, supplement to commit `999e7d8`): `sync_imap` used to close each window with `set_last_uid(account, folder, max(m.uid for m in msgs))`, but the fetch layer had already advanced the watermark past any `MAX_SINGLE_BYTES` oversize uid — so when a window mixes in an "oversize-max-uid single" like `[1,2,3,1000_oversize]` (only `[1,2,3]` picked), the write pulled the watermark back from 1000 to 3, re-fetching `4..1000` every round and re-counting the oversize in `dropped`. Now uses `state.set_last_uid_max()` (monotonic: only accepts larger values, never regresses), taking the larger of the window's picked max and what the fetch layer already pushed. Regression test added: `test_sync_imap_oversize_above_picked_does_not_regress_watermark`. Also per review feedback: a POP3 all-oversize-window test locking in `synced=0, dropped=N` with no error (an all-oversize window is lazily discarded — it must NOT be treated as all-normalize-failed, which raises `RuntimeError`); adds `dropped=N` to the all-bad `RuntimeError` message; gives the `protocol` log a `?` fallback; removes the redundant `res["protocol"]="pop3"` in `_fallback_to_pop3` and adds a trailing newline
- refactor: |Worker| Merge the duplicated `inWhitelist`/`inWhitelistRow` implementations into a single `inWhitelistImpl(list, val, failOnMissing)` (review Minor-3): the two were copy-paste with only a different `undefined` treatment (request-layer pass vs row-layer deny). The `failOnMissing` boolean now distinguishes them, so the two can't drift
- fix: |Worker| Fix one-mail `api_keys` readonly keys whose `allowed_sources`/`allowed_accounts` are created as comma strings (`/admin/unified/keys` string input) being stored by `JSON.stringify` as a quoted string, causing `scopeQuery` to crash calling `join` (`accounts.join is not a function`): `parseList` now falls back to splitting on commas when JSON parsing yields a string (one-mail unified inbox M4)
- fix: |Worker| Fix the one-mail 90-day read-email retention cleanup only running when the legacy `auto_cleanup` setting is present: `scheduled` now runs the cleanup on every trigger, independent of that setting (one-mail M5 retention)
- fix: |Aggregator| Batch IMAP sync fetches: `fetch_new_messages` now processes at most `BATCH_SIZE` (default 200) newest messages per run, so a large mailbox's first full pull no longer stalls in a single `fetch` and times out (9999-email QQ INBOX reproduced the timeout in production) (one-mail aggregator M3)
- fix: |Aggregator| IMAP batching now drains from the oldest window (`uids[:BATCH_SIZE]`) and advances `last_uid` to the window's max UID, converging over multiple runs across the entire mailbox — fixes the previous new-first window permanently dropping the oldest batch of large mailboxes; also makes `state.py` tolerant of a missing `uidvalidity` key (review fix)
- fix: |Worker| Unified inbox `verifcodes` and `GET /api/unified/emails/:id` no longer leak across scopes: a readonly key is forced into `allowed_sources`/`allowed_accounts` via injected WHERE (verifcodes) or row source/account validation (getEmail), returning 403 for out-of-scope reads (review fix)
- fix: |Worker| `unread` is now a three-state filter (`1`→unread, `0`→read); `verifcodes` validates `fresh` (400 on non-numeric) and returns up to `LIMIT 50`; `markRead` checks existence before updating so re-marking a read email is idempotent instead of a false 404; retention cleanup deletes in pages (≤1000/batch) and guards R2 attachment keys (review fix)
- fix: |Aggregator| IMAP sync crashed with `TypeError: Object of type Header is not JSON serializable` when a mail header parsed into a `email.header.Header` object (`headers_json` did a bare `json.dumps(dict(msg.items()))`), stalling a large-mailbox re-crawl mid-way: added `_header_json_stringify` to coerce every header value to str (bytes→decode, `Header`→str) before serializing (review fix round 2, commit `068e462`)
- fix: |Aggregator| IMAP sync OOM on huge-attachment mailboxes: a QQ INBOX contains single 66MB/65MB messages; batching by count (`BATCH_SIZE=200`) pulled ~200MB+ RFC822 per window and pxed's K8s container (cgroup memory.max≈3.9GB, ~1GB baseline) repeatedly OOM-killed python (`rc=137`), stalling sync at `last_uid=4024`. Two-layer fix: ① `fetch_new_messages` probes `RFC822.SIZE` first and caps each window at `BATCH_BYTES=64MiB`; ② any single message over `MAX_SINGLE_BYTES=30MiB` is skipped and the watermark advanced past it so one message can't trip the container again (commits `269c3fd`+`60d33c9`)
- feat: |Aggregator| Add IMAP-first / POP3-fallback: normal password accounts default to `protocol: auto` (try IMAP first; if connecting or selecting fails and the account is not OAuth, fall back to POP3 automatically). Accounts like 163 whose IMAP is rejected at EXAMINE/SELECT (`Unsafe Login`) are verified to converge via `pop.163.com:995` POP3. POP3 uses UIDL as a stable watermark (`state.pop3_seen`, namespaced per `account|folder`, so renumbering message numbers after deletes never resyncs); stable keys in the `pop3:` namespace are written into the same `imap_uid` field so the Worker's partial unique index keeps inserts idempotent; `LIST` probes per-message sizes and reuses `BATCH_BYTES/MAX_SINGLE_BYTES` to avoid the big-attachment OOM. Supports `protocol: imap` (never fall back), `protocol: pop3` (direct), and OAuth accounts never fall back. After a successful fallback the account is pinned to POP3 (`state.fallback`), and the pin is only written after POP3 succeeds, avoiding imap:/pop3: duplicate rows when IMAP briefly blips (one-mail aggregator)
- fix: |Aggregator| `normalize_message` now guarantees a non-empty `from_addr` (fallback to the raw From header text, then `unknown`) for mails with a missing/empty From or a pseudo-address without `@`. The Worker ingest rejects batches with an empty sender (`from_addr required` → HTTP 500) and previously a single malformed QQ mail stalled the whole 200-mail batch (last_uid stuck at 7237); after this fix QQ resumed `protocol=imap` at 200/cycle (commit `3d3d5b6`)
- fix: |external mail| C1 one-address-one-user: partial unique index on user_mail_accounts(username) WHERE enabled=1 + pre-insert cross-user ownership check, preventing an attacker from connecting another user's external address to inject forged mail
- fix: |external mail| I5 dedup semantics are now correct under one-address-one-user: the (host, username) dedup in main.py no longer has an ambiguity from multiple users legitimately sharing one address (changelog note only — no code change)
- fix: |aggregator| I3 IMAPClient 30s socket timeout (sync + oauth factories), a single hung account no longer eats the whole 240s loop budget
- fix: |aggregator| I4 atomic state.save() (temp file + os.replace), a killed process no longer leaves truncated JSON that wipes all sync state
- fix: |create address| I6 DISABLE_ANONYMOUS_USER_CREATE_EMAIL unset now treated as true (fail-closed), removing anonymous-creation exposure on config omission; explicit false required to allow
- fix: |role quota| C2 saveRoleAddressConfig now merges (PATCH semantics): existing roles preserved, only submitted roles overwritten, preventing concurrent admins editing different roles from clobbering each other
- fix: |deploy| I1 gitignore frontend/.env.pages + add .env.pages.example to prevent secret leakage; untracking is a separate deploy step
- fix: |auth| security: `/open_api/credential_login` now uses `verifyAddressJwt` from `core/auth` — it previously used a bare `Jwt.verify` checking only that `address` is non-empty, bypassing `REJECT_EXPLESS_JWT` (true rejects exp-less address JWTs); now unified with the `/api/*` address-JWT middleware semantics, rejected/invalid returns 401 (remaining `Jwt.verify` call sites are non-address user/telegram/config JWTs and were left untouched)
- fix: |auth| security: admin credential comparison is now constant-time — `utils.checkIsAdmin` (the `x-admin-auth` header path shared by the Worker `/admin/*` middleware and the telegram miniapp) previously compared via `getAdminPasswords().includes(adminAuth)`, an array lookup with a timing side channel. Added `core/timing.ts` `safeEqual(a,b)` (SHA-256 equal-length digests compared byte-by-byte with XOR accumulation — naturally length-normalized and independent of a platform `timingSafeEqual`, which neither Workers nor Node exposes) and `checkIsAdmin` now iterates `ADMIN_PASSWORDS` one candidate at a time with `safeEqual`. The shared admin-key header path (aggregator `/admin/unified/*` and other multi-tool consumers) deliberately gets NO IP lockout — locking would falsely trip shared-credential callers with no browser fingerprint (the interactive `/open_api/admin_login` already has its own IP lockout in `admin_lockout.ts`)
- fix: |external mail| security: `user_api/mail_accounts` now validates the oauth provider whitelist — `oauth.provider` only accepts `gmail`/`outlook` (the set defined by the aggregator's `oauth.py` `_TOKEN_FN`); unknown/malformed/missing provider returns 400 fail-closed. Previously an unknown provider was stored directly and the live aggregator's `oauth_client_factory` KeyError on `_TOKEN_FN[provider]` froze an entire sync round
- fix: |frontend| security: mail-body rendering (SendBox preview, desktop + mobile) now goes through the repo's existing `sanitizeHtml()` (DOMPurify) — previously `is_html` rendered `<div v-html="curMail.content">` unsanitized, letting a malicious mail (e.g. `<img onerror>`) run scripts in the primary inbox path
- fix: |frontend| security: OAuth provider login-button icon `v-html` now sanitized via `sanitizeHtml()` (`UserLogin.vue` / `UserOauth2Settings.vue`) — icons come from connector config and are treated as untrusted input
- fix: |frontend| security: logout now clears `unifiedApiKey` (a Bearer API-key credential, `localStorage.unifiedApiKey`) — previously Admin logout, UserSettings/AccountSettings logout and the `deleteAccount` path all left the credential behind on shared devices
- fix: |aggregator| security: unknown OAuth provider is now isolated per-account — the `oauth_client_factory` construction moved inside the per-account try so a `_TOKEN_FN[provider]` KeyError can no longer escape and freeze every account after it for the round; the bad account gets `last_error: provider unsupported: <provider>` and is skipped while the rest sync normally. The catch surface is widened to `(KeyError, AttributeError, TypeError)` and a non-dict oauth (string/None) is defensively reported as `<malformed:not-dict>`; an empty dict missing `provider` also errors per-account without aborting the round
- fix: |aggregator| `imap_uid` dedup key now includes the account dimension (high-risk silent mail loss): the old `host:folder:uidvalidity:uid` omitted the account — with multiple accounts on one host, UIDVALIDITY pinned to 1, and per-mailbox UIDs starting at 1, the Worker's unique `imap_uid` index would let `INSERT OR IGNORE` silently swallow a later account's entire message sync. IMAP keys become `account:host:folder:uidvalidity:uid` and POP3 keys `pop3:account:pop.host:folder:uidl`. Watermarks (IMAP `last_uid` / POP3 UIDL seen-set) are keyed by account/folder and independent of the `imap_uid` key format, so this upgrade does **not** re-pull old mail: only new pulls get the new key, historical rows keep theirs
- fix: |aggregator| infinite retry with no backoff for persistently-failing accounts (IP-ban risk): `state.py` now tracks per-account `fail_count`/`skip_until` (old state files tolerated — missing fields read as 0/None); `run_once` enters a 15-minute backoff window after 3 consecutive failures and skips the account outright inside the window (recording `last_error` instead of connecting), resetting to zero on any success (including a 0-new-mail round). Backoff offset is a testable pure function `next_backoff_offset`
- fix: |aggregator| per-message size gate no longer a no-op when `RFC822.SIZE` is missing (important): an imap_custom server that doesn't support `RFC822.SIZE` previously yielded size=0 for every message, so `MAX_SINGLE_BYTES` never fired and oversized messages were loaded whole into memory (OOM). Now "unknown = oversize" fail-closed: a missing size skips the message, advances the watermark, and logs a warning (consistent with the POP3 LIST-missing policy); a server that persistently omits SIZE will have its messages skipped as oversize (fail-closed — safe drop over OOM) rather than fetched wholesale
- feat: |aggregator| POP3 seen-set FIFO cap to bound growth: per-account cap `POP3_SEEN_MAX=2000`, trimming the oldest entries when exceeded (a legacy oversized set is trimmed on the next add — backward compatible)
- fix: |frontend| security: Telegram mail-view XSS (C2) — `src/views/telegram/Mail.vue` fed raw parser output (`curMail.message`) straight into `<iframe srcdoc>`; it was the only branch in the repo rendering un-sanitized parsed output directly. Added a shared `sanitizeHtmlMail()` (`src/utils/sanitize-html-mail.js`, reusing `blockRemoteContent`'s provablyLocal + DOMPurify allowlist pipeline) and the component now routes through it, as `MailContentRenderer.vue` does; the iframe also gains `sandbox="allow-same-origin"` (scripts stay disabled, `target=_blank` popups and top-level navigation blocked so the frame cannot escape). Verified by new `sanitize-html-mail.test.js` (`<img onerror>` stripped, `javascript:` hrefs stripped, `<script>/<iframe>/<base>` etc. forbidden, local blob/cid/data:image resources kept, byte-for-byte parity with `blockRemoteContent` semantics)
- fix: |frontend| security: logout now clears `LocalAddressCache` (H5) — the address picker (`AddressSelect.vue`) caches address JWTs in `localStorage.LocalAddressCache` outside the global store, and none of the three logout handlers cleared it. Added a shared `clearLocalAddressCache()` (`src/utils/address-cache.js`, single source of truth `LOCAL_ADDRESS_CACHE_KEY`) wired into all three logout handlers plus the `deleteAccount` path; only that key is cleared, UI preferences (theme/locale/layout) are untouched
- fix: |auth| security (R2, CRITICAL): removed the user-role fallback authorization surface from `/admin/*` — previously any user token signed with `JWT_SECRET` could carry `user_role=admin` in its payload and hit the `/admin/*` write surface indefinitely (the claim came from the JWT and was never re-checked against the DB `user_roles` table). Now the fallback no longer authorizes: a JWT-role-admin must also satisfy `checkIsAdmin` (a valid `x-admin-auth`); the role is only a frontend UX signal for showing the admin panel. All fallback failures share the same per-IP bucket as the admin header (15-min window, >=10 failures -> 429); decision logic extracted to pure function `decideAdminAuth` in `unified/admin_lockout.ts` (zero relative imports, runs under node --test). +8 tests (incl. lock-window fallback cannot bypass / forged user_role=admin without credentials rejected 401 / per-IP independent buckets)
- fix: |oauth| security (R3, CRITICAL): OAuth callback now unconditionally requires `state` — `/user_api/oauth2/callback` previously skipped verification when `state` was absent (CSRF code-swap without state). Failures now uniformly return 400 (fail-closed) and the KV state (`oauth_state:*`) is consumed once; `getOauth2LoginUrl` continues to require a state stored into KV. Frontend `UserOauth2Callback.vue` updated: callback body now includes `state` (`route.query.state` first, falling back to the session-stored state). New `user_api/oauth2_state.test.mjs` +8 (missing state rejected / mismatch rejected / match + one-time consume / expired rejected / legacy frontend without state rejected / query fallback)
- fix: |admin| security (H2): `/admin/telegram/init` now passes `secret_token` to `setWebhook` when `TELEGRAM_SECRET_TOKEN` is configured — otherwise Telegram callbacks would always miss the `X-Telegram-Bot-Api-Secret-Token` header and be rejected 401 (silently severed). `/telegram/webhook` now returns 503 (fail-closed) instead of a silent 200 when secret is unconfigured, letting the operator notice the bot is disconnected. webhook.test synchronized (secret-configured branch + unconfigured 503 + setWebhook argument assertion)
- fix: |deploy|: documented `TELEGRAM_SECRET_TOKEN` in `wrangler.toml.template` / `.example`; added per-IP independent failure bucket assertions to `admin_lockout.test.mjs` (H3); worker-vars docs updated to reflect the 503 fail-closed semantics
- fix: |frontend| UnifiedInbox silent 401 hang (H6) — `unifiedClient`/`unifiedUserClient` had no `onUnauthorized` hook, so an expired key/userJwt threw `Error("Code 401...")` without clearing credentials or redirecting. `createApiClient` now wires a unified 401 handler on both channels (clears the matching `unifiedApiKey`/`userJwt` and dynamically imports the router to navigate to `/user`, avoiding the router→views→api static cycle), matching the siteClient session behavior
- fix: |auth| security (H2): `verifyAddressJwt` now unconditionally rejects address JWTs without an `exp` claim or with a past `exp` (previously only rejected exp-less tokens when `REJECT_EXPLESS_JWT=true`; `Jwt.verify`'s default 4-arg options otherwise allowed legacy tokens through). `REJECT_EXPLESS_JWT` is now a no-op placeholder kept for env backward compatibility
- fix: |admin| security (H3): the `/admin/*` header path (`checkIsAdmin`) now has failure lockout — only when an `x-admin-auth` header mismatches every `ADMIN_PASSWORDS` entry does it count per-IP, returning 429 after 10 failures in a 15-minute window; a correct token clears the count; KV unreachable fails closed to 429. The aggregator's fixed strong token never trips the counter
- fix: |telegram| security (H4): `/telegram/webhook` now validates its source — when `TELEGRAM_SECRET_TOKEN` is configured it compares the `X-Telegram-Bot-Api-Secret-Token` header (401 on mismatch); when unset the endpoint only logs and does not process updates (fail-closed). The miniapp's initData HMAC verification (WebApp-standard double SHA-256 derivation) was confirmed as an existing implementation and covered by new positive/negative tests
- fix: |oauth| security (H6): OAuth state is now validated server-side — `getOauth2LoginUrl` stores the state in KV (`oauth_state:<state>`, 10-min TTL, with clientID/expires) and `/user_api/oauth2/callback`, when a state is provided, verifies existence, clientID match, and non-expiry then consumes it once (CSRF code-swap protection); when no state is provided the frontend sessionStorage comparison still guards it (backward compatible)

### Improvements

- refactor: |architecture| In-place monorepo (pnpm workspace + packages/shared shared contract pkg, worker/frontend renamed @one-mail/*); worker core/ layering (address JWT sign/verify, settings, emails INSERT, raw_mails list single-source); frontend 4 auth wrappers consolidated into one createApiClient factory (zero behavior change)

- docs: |Frontend| Add a frontend development guide (`guide/ui/frontend-dev`, EN + zh): covers the one-mail unified-inbox frontend architecture (Vue 3 + Vite + Naive UI talking cross-origin directly to the Worker), directory layout and key modules (`api/index.js` auth-header injection, `router` locale-aware routing, `store` global state, `email-parser` wasm parsing), local development (`VITE_API_BASE` + `vite.config.js` dev proxy → `127.0.0.1:8787` for wrangler-dev integration), environment variables (`VITE_API_BASE`/`VITE_CF_WEB_ANALY_TOKEN`/`VITE_IS_TELEGRAM`), the build/deploy matrix (`build` / `build:pages` / `build:telegram`), one-mail unified-inbox Bearer API-key auth and the `/api/unified/*` endpoint table, coding style, and FAQ. Use it as the entry point when building the unified-inbox frontend pages later

- fix: |Worker| Throttle address-activity touches to one write per day so user settings and mailbox access do not repeatedly update recently active addresses, reducing D1 writes (issue #1103)

- feat: |User| Add server-side pagination for bound addresses, with totals queried only on the first page; validate user-mail list ownership with a JOIN and delete ownership with `EXISTS` instead of loading every bound address for large users (issue #1103)

- feat: |Worker| Process mail, sent-mail, and creation/activity-based address cleanup in batches of 3000 by default, configurable through `CLEANUP_BATCH_SIZE` up to 5000, reducing per-run scans and deletes (issue #1103)

### Testing

- fix: |E2E| Add regression coverage ensuring user settings do not rewrite recent address activity timestamps
- fix: |E2E| Cover cleanup batch limits, continuation on later runs, preservation of recent data, and address-related data cleanup

## v1.10.0

### Features

- feat: |Admin| Add `GET /admin/mails/:id` for administrators to fetch a single mail by ID across mailboxes, including gzip-compressed storage support (issue #1096)
- feat: |Frontend| Add a "Full-width mailbox list view" toggle in Appearance settings. When enabled, the mailbox shows a full-width list of subjects and body previews by default; clicking a mail expands it into the two-pane split view, clicking the same mail again returns to the list view; in multi-select mode, clicking a mail updates both its checked state and the right-side preview while disabling same-mail collapse, and the split width still follows the "Left list width in two-column mailbox view" setting. Defaults to off, preserving the original two-pane behavior
- feat: |Frontend| Add "Body Preview Lines" in Appearance settings for the full-width mailbox list view, allowing runtime control over the body-preview clamp. It defaults to 2 lines, and 0 disables previews
- feat: |Frontend| Add an "Automatically load external images in mail body" toggle in Appearance settings. When disabled, the mail body (including fullscreen view) is run through DOMPurify and an allowlist policy: only references that can be *proven* local are kept (`cid:`, `data:image/`, `blob:` and same-origin relative paths), everything else is blocked. Elements that fetch on their own or change how relative URLs resolve — `base`, `meta`, `script`, `link`, `iframe`, `object`, `embed`, `noscript` — are removed in this mode, while `<style>` is kept with remote `url()`, `image-set()` and `@import` references substituted. A banner above the body reports how many resources were blocked and loads them for that mail on demand; defaults to on, preserving the previous behavior (issue #1073)

### Bug Fixes

- fix: |Frontend| Preserve external navigation links on `<a>` and `<area>` elements when automatic remote-image loading is disabled, and block remote CSS resources hidden behind escaped function or at-rule names
- fix: |Frontend| Sanitize HTML announcements in both the About page and startup notification through a shared DOMPurify helper, preventing executable tags or event attributes in `ANNOUNCEMENT` from causing XSS
- fix: |Worker| Align junk-mail checking with authentication standards: treat SPF, DKIM, and DMARC `none` plus SPF/DKIM `neutral` as absent, and ignore unregistered results and unsupported method versions; `JUNK_MAIL_FORCE_PASS_LIST` still requires an explicit supported `pass`
- fix: |Admin| When deleting an address from the admin panel, delete its mails, sender records, sendbox and auto-reply entries before removing the address row itself; previously the address row was deleted first, so the name-based subqueries matched nothing and the mails were left orphaned in the database
- fix: |AI Extract| Strengthen the prompt to keep original link domains from the email, preventing small models from rewriting verification-link domains (issue #1072)
- fix: |AI Extract| Convert HTML-only mail bodies into compact readable text before sending them to Workers AI, preventing long templates from pushing verification codes past the 4000-character truncation window
- fix: |Frontend| Add mobile Header page padding so the title and menu button no longer sit too close to the screen edge
- fix: |IMAP Proxy| Fix IMAP `STORE` not actually marking mail as read: messages are no longer hardcoded to `\Seen`, and `SimpleMailbox` flag changes are now persisted to a local SQLite file (new `imap_flag_db_path` setting) so the read/unread state survives a client disconnect and reconnect (e.g. Thunderbird polling) instead of resetting on every new connection (issue #1074)
- fix: |IMAP Proxy| Fix `SEARCH UNSEEN` returning every message: `SimpleMailbox.search()` now evaluates `SEEN`/`UNSEEN`/`FLAGGED`/`DELETED`/`ANSWERED`/`DRAFT` and their negations against the persisted flags, combining multiple keys with AND; search keys it cannot evaluate keep the previous behaviour of matching everything
- fix: |IMAP Proxy| Fix fetches never marking mail as read: `BODY[...]`, `RFC822` and `RFC822.TEXT` fetches now set `\Seen` per RFC 3501, while `BODY.PEEK[...]`, `RFC822.HEADER` and metadata-only fetches (e.g. `FLAGS`) do not

### Testing

- test: |Worker| Add junk_mail_policy regression tests (issue #1084): `none`/`neutral` results for SPF/DKIM/DMARC are treated as the method being absent, explicit `fail` results are still rejected, and `JUNK_MAIL_FORCE_PASS_LIST` only accepts an explicit `pass`

### Improvements

- docs: |README| Add a complete Japanese README and Japanese navigation links to the Chinese and English READMEs
- feat: |Frontend| Lower the "Left list width in two-column mailbox view" minimum from 0.25 to 0 so the left list pane can fully collapse for a near-fullscreen content view, with a 0 mark added; applies to both the inbox and send-box two-pane splits, and clarifies the Appearance setting label so it is clear the value controls the left mail list width

## v1.9.0

### Features

- feat: |AI Extract| Fall back to a built-in regex verification-code extractor (English / Chinese / Japanese / Korean, with year and `YYYYMMDD` date rejection) when no Workers AI binding is configured, so self-hosted deployments without Workers AI still surface codes in Telegram pushes and webhooks
- feat: |Telegram| Show AI extraction results in Telegram new-mail notifications and `/mails` history views, including verification codes, auth links, service links, and subscription links
- feat: |Webhook| Support AI extraction placeholders in mail webhook templates, including `aiExtractType`, `aiExtractResult`, and `aiExtractResultText`
- feat: |Frontend| Add `DISABLE_SHOW_GITHUB_FOR_USER` to hide the Header GitHub/version entry from normal users while keeping it visible to admin users (issue #1041)
- feat: |Frontend| Upgrade the address credential dialog to "Address Credentials & Connection Methods" and reuse it for both normal users and admin-created addresses; support showing AI Agent access via `ENABLE_AGENT_EMAIL_INFO` and SMTP/IMAP client settings via `SMTP_IMAP_PROXY_CONFIG`
- docs: |Random Subdomain| Clarify in the "Use Random Subdomain" frontend tip and the `subdomain` / `worker-vars` docs (zh & en) that receiving mail on `name@<random>.abc.com` requires a wildcard `*` MX record under the base domain in DNS, because Cloudflare Email Routing does not inherit the apex configuration onto subdomains (issue #1035)

### Bug Fixes

- fix: |Admin| Hash address passwords in the frontend before admin reset requests, and make the backend accept and store only the hash instead of plaintext
- fix: |Address| Stop returning stored address password hashes from the admin address list and user bound-address list APIs to avoid exposing sensitive fields
- fix: |Address| Normalize whitespace and casing for configured domains, inbound recipient domains, and prefixes across `DOMAINS`, `DEFAULT_DOMAINS`, `USER_ROLES.domains`, random subdomains, forwarding rules, SMTP, and `SEND_MAIL` domain matching, preserve blank-domain catch-all forwarding rules, and clarify that empty `DEFAULT_DOMAINS` / role domains fall back to `DOMAINS`, to avoid create, receive, forward, or send failures caused by mixed-case configuration or inbound recipient domains (issue #926)
- fix: |AI Extract| Switch the default Workers AI model for AI email recognition to the JSON Mode-compatible, non-deprecated `@cf/meta/llama-3.1-8b-instruct-fast`, and document structured-output compatibility guidance for `@cf/zai-org/glm-4.7-flash` (issue #1029)
- fix: |CI| Upgrade GitHub Actions and e2e Docker images to Node.js 24 to satisfy Wrangler 4.90.0 runtime requirements
- fix: |Frontend| Prevent iOS Safari from auto-zooming the page when focusing mobile form controls with small font sizes

### Improvements

## v1.8.0

### Features

- feat: |Frontend| Add six-language frontend support (`zh` / `en` / `es` / `pt-BR` / `ja` / `de`), keep `zh` as the default locale; locale-unprefixed routes (for example `/` and `/user`) render in Chinese by default while still recording browser language as the stored preference. Explicit locale switches are persisted, and the current route, query string, and canonical locale URL stay in sync during switching
- feat: |API| Add server-side parsed-mail endpoints `/api/parsed_mails` and `/api/parsed_mail/:id` that return `sender` / `subject` / `text` / `html` / `attachments` metadata directly (reuses `commonParseMail`), so AI agents no longer need a client-side MIME parser
- feat: |Skill| Bundle a read-only skill `cf-temp-mail-agent-mail` (`skills/cf-temp-mail-agent-mail/`) so AI agents like OpenClaw / Codex / Cursor can consume a mailbox with a user-supplied Address JWT + API base URL — list mails, poll verification codes, etc. — sidestepping the Turnstile challenge required to create a mailbox. Install via `npx degit dreamhunter2333/cloudflare_temp_email/skills/cf-temp-mail-agent-mail`
- docs: |Docs| Add "AI Agent Mailbox Usage" doc (`guide/feature/agent-email`) covering the `parsed_mail` API and a local-parse fallback using `mail-parser-wasm` + `postal-mime` (mirrors the frontend) when parsed endpoints are unavailable
- docs: |Docs| Make "a domain is a hard prerequisite" explicit at the top of `quick-start`, `worker-vars`, and `email-routing` (zh + en), spelling out that Cloudflare Email Routing must be enabled with email DNS records provisioned before deployment, the Catch-all rule must be bound after the Worker is deployed, and subdomains do not inherit the parent domain's Email Routing — so users no longer start deploying without a usable domain and end up unable to receive mail (issue #1004)
- docs: |Deployment troubleshooting| Improve docs for recent UI-deployment and upgrade issues: document `nodejs_compat`, the required uppercase `DB` D1 binding, `/open_api/settings` verification, backend API URL entry, Cloudflare security challenges causing `Network Error`, D1 size limits and Cron Trigger cleanup, GitHub OAuth public email requirements, the difference between admin passwords and user accounts, and the `enableRandomSubdomain` API flag; move the Help/FAQ menu directly after Core Configuration so it is easier to find
- docs: |Docs| Document how to handle the "address already exists" case when recreating an old mailbox, and clarify the GitHub Actions workflow for automatic updates with Page Functions forwarding backend requests (issues #947 #654)
- docs: |OAuth2| Document GitHub private-email login configuration using `https://api.github.com/user/emails`, a JSONPath email field, and the `user:email` scope to read the primary email (issue #655)

### Bug Fixes

- fix: |Frontend| Narrow address-management modal widths and keep address tables horizontally scrollable inside the modal to prevent multi-address lists from stretching the dialog
- fix: |Frontend| Fix the frontend settings bootstrap throwing an `undefined` error when `/open_api/settings` does not return a `domains` array by normalizing the field to an empty array before mapping it
- fix: |Frontend| Fix every API call crashing client-side with `Invalid character in header content ["Authorization"]` when stale localStorage credentials (`jwt` / `auth` / `adminAuth` / `userJwt` / `access_token`) are empty, the literal string `"undefined"`, or contain a stray newline or other control character (issue #1000). Adds `safeHeaderValue` / `safeBearerHeader` helpers that validate every auth header against RFC 7230 and omit the header entirely when unsafe, so the worker returns a clean 401 instead of the request being rejected by axios/undici
- fix: |Frontend| Fix the multilingual header on mobile by keeping only the menu button in the top bar and moving language/version actions into the drawer to avoid horizontal crowding or overflow

### Improvements

- refactor: |Worker| Split `mails_api/index.ts` and `admin_api/index.ts` so the index files only wire routes. Business logic moved into dedicated `*_api.ts` files (`mails_crud.ts` / `new_address.ts` / `parsed_mail_api.ts` / `address_api.ts` / `address_sender_api.ts` / `sendbox_api.ts` / `statistics_api.ts` / `account_settings_api.ts`). Paths and behavior unchanged

## v1.7.0

### Breaking Changes

- breaking: |send mail| `SEND_MAIL` semantics changed from a verified-address-only compatibility path to a normal fallback send channel. If an instance already binds `SEND_MAIL` and does not configure Resend/SMTP, recipients outside `verifiedAddressList` will now also be sent through the Cloudflare binding after upgrade, changing runtime behavior and cost routing

### Features

- feat: |send mail| Recommend Cloudflare `send_email` binding as the default send channel. Domains onboarded to Email Routing without Resend/SMTP now automatically use the binding to send to arbitrary addresses (Workers Paid includes 3,000 msgs/month, $0.35/1000 beyond); existing `verifiedAddressList` / Resend / SMTP configurations remain fully compatible (#964)

### Bug Fixes

- fix: |Send Mail| Auto-initialize the default send balance for addresses that have no `address_sender` row yet when `DEFAULT_SEND_BALANCE > 0`, on the first send-settings read or send API call (`ON CONFLICT DO NOTHING`). Existing rows — including admin-disabled or admin-edited ones — are never overwritten by the runtime path, so users no longer need to manually request send permission first (#925 #985)
- fix: |User Mailbox| Fix an issue where the user center still showed delete actions and could still delete mail via `/user_api/mails/:id` when `ENABLE_USER_DELETE_EMAIL` was disabled (#978)
- fix: |Address| Lowercase configured prefixes when creating addresses to avoid generating mixed-case mailbox names; existing data must be migrated to lowercase manually by the user (#930)

### Improvements

## v1.6.0

### Features

- feat: |Admin| Add **IP Whitelist (strict mode)** to IP blacklist settings: when enabled, ONLY whitelisted IPs can access rate-limited APIs (create address, send mail, external send mail, user register, verify code); all other IPs are denied (#920)
- feat: |Address| Support setting max address count to `0` for unlimited (#968)

### Bug Fixes

- fix: |Admin| Fix `D1_ERROR: LIKE or GLOB pattern too complex` on `/admin/address` and `/admin/users` when searching by full email address (query length pushes the LIKE pattern over D1's 50-byte limit). Long queries now fall back to `instr()` to bypass the LIKE pattern length cap (#956)

### Improvements

- docs: |Send Mail API| Clarify authentication differences between `/api/send_mail` and `/external/api/send_mail`, add "Address JWT" concept explanation (#922)
- docs: |Worker Variables| Add generation instructions for `JWT_SECRET` (`openssl rand -hex 32`) (#932)
- docs: |CLI Deployment| Add usage explanation for `routes` custom domain configuration (#932)
- docs: |Admin API| Add `address_id` field to `/admin/new_address` response documentation (#912)
- docs: |Admin| Add account list sorting feature documentation (#918)
- docs: |Pages Deployment| Add SPA mode instructions to avoid 404 when refreshing or accessing sub-paths directly (#813)
- docs: |Sidebar| Restructure documentation sidebar into "Core Configuration", "Notifications & Integrations", "Advanced Features", "Admin Console" groups
- docs: |FAQ| Significantly expand FAQ with SPA 404, send balance, SMTP_CONFIG, mail client login and more (#919, #925, #839, #715, #921, #609)
- docs: |Email Sending| Enhance SMTP_CONFIG field reference and multi-domain examples, add send balance mechanism documentation
- docs: |Email Routing| Note that subdomains require Email Routing to be enabled separately; enabling it only on the apex domain does not cover subdomains (#969)

## v1.5.0

### Features

- feat: |Admin| Admin account list now supports column sorting (ID, name, created at, updated at, mail count, send count), search automatically resets pagination to page 1 (#918)
- feat: |Admin API| `/admin/new_address` endpoint now returns `address_id` field, avoiding additional query after address creation (#912)
- feat: |Create Address| Add `ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH` switch and an admin-panel toggle for suffix-based subdomain matching in create-address APIs; when enabled, `foo.example.com` can match base domain `example.com`
- feat: |Auto Reply| Add regex matching support for sender filter using `/pattern/` syntax (e.g. `/@example\.com$/`), backward compatible with prefix matching
- feat: |Turnstile| Add global Turnstile CAPTCHA for all login forms via `ENABLE_GLOBAL_TURNSTILE_CHECK` env var (#767)
- feat: |Telegram| Support sending email attachments in Telegram push (50MB per file limit), multiple attachments sent via `sendMediaGroup`, controlled by `ENABLE_TG_PUSH_ATTACHMENT` env var (#894)
- feat: |Mail Storage| Support enabling gzip-compressed email storage via `ENABLE_MAIL_GZIP` variable (#823)
  - Run database migration before enabling it: `Admin -> Quick Setup -> Database -> Migrate Database`, or call `POST /admin/db_migration`
  - New emails are stored in `raw_blob` and reads stay compatible with `raw` / `raw_blob`; compression and decompression add CPU overhead, so a paid Worker plan is recommended

### Bug Fixes

- fix: |Auto Reply| Fix auto-reply not triggering when `source_prefix` is empty string (#459), empty value now correctly matches all senders
- fix: |OAuth2| Fix OAuth2 login callback failure on Android via browser and other mobile browsers due to sessionStorage loss during redirect, add localStorage fallback (#900)
- fix: |IMAP| Fix nested reply email mojibake, Gmail empty Content-Type header parsing failure, missing Date header, and locale-dependent date formatting issues

### Testing

- test: |E2E| Add create-address subdomain matching tests covering default exact-match behavior, admin-enabled matching, and env=false hard-disable precedence
- test: |E2E| Add auto-reply trigger E2E tests covering empty prefix, prefix matching, regex matching, and disabled state

### Docs

- docs: |Create Address| Update create-address API, worker variables, and subdomain docs to clarify the difference between explicitly specified subdomains and random subdomains
- docs: |API| Add clarification between Address JWT and User JWT to avoid confusion; reorganize documentation menu structure with dedicated API Endpoints section (#910)
- docs: |Telegram| Add per-user mail push and global push documentation (#769)
- docs: |Webhook| Add webhook template examples for Telegram Bot, WeChat Work, Discord and other common push platforms
- feat: |Webhook| Add Telegram Bot, WeChat Work, Discord preset templates to frontend webhook settings

### Improvements

## v1.4.0

### Features

- feat: |User Registration| Add email regex validation for user registration, admins can configure email format validation rules
- feat: |Frontend| Add configurable Status menu button via `STATUS_URL` environment variable for status monitoring page link
- feat: |SMTP| Add STARTTLS support for SMTP proxy server via `smtp_tls_cert` and `smtp_tls_key` environment variables
- feat: |Webhook| Add preset templates dropdown to Webhook settings page, supporting one-click fill for Message Pusher, Bark, and ntfy

### Bug Fixes

- fix: |Telegram| Fix admin users unable to view emails via Telegram MiniApp due to `Auth date expired` error, support admin password auth for viewing emails
- fix: |Admin API| Fix `/admin/account_settings` throwing `Cannot read properties of undefined (reading 'put')` when KV is not configured and `fromBlockList` is empty
- fix: |Database| Fix missing `idx_raw_mails_message_id` index in `DB_INIT_QUERIES` causing full table scan on `UPDATE raw_mails ... WHERE message_id = ?`, sync `schema.sql` with init code, add v0.0.6 migration
- fix: |Docs| Fix User Mail API documentation incorrectly using `x-admin-auth`, changed to correct `x-user-token`
- fix: |Frontend| Fix email content text being unreadable in dark theme, improve dark mode styles for plain text mail and Shadow DOM rendering
- docs: |Docs| Add Admin API documentation for delete mail, delete address, clear inbox, and clear sent items
- fix: |Frontend| Fix reply to HTML email losing original HTML content, prefer HTML message over plain text
- fix: |Security| Fix XSS vulnerability in reply/forward mail content, sanitize HTML with DOMPurify whitelist and escape plain text
- fix: |API| Fix typo in `requset_send_mail_access` API path, renamed to `request_send_mail_access`

### Testing

- test: |E2E| Add Dockerized E2E test environment (Playwright + Mailpit), run with `cd e2e && npm test`
- test: |E2E| Cover API health check, address lifecycle, SMTP send, inbox UI, HTML reply & XSS sanitization
- test: |Worker| Add `/admin/test/seed_mail` test endpoint, only available when `E2E_TEST_MODE` is enabled

### Improvements

- style: |Mail List| Improve empty state display for inbox and sent box, show different messages based on mail count, add semantic icons
- feat: |Admin| Add ip.im lookup link for source IP in address list, click to quickly view IP information
- docs: |Docs| Fix VitePress i18n language switch path error, use dual-prefix locale configuration
- feat: |IMAP Proxy| Refactor IMAP server into separate modules (HTTP client, mailbox, message), use `deferToThread` for async HTTP to avoid blocking Twisted reactor, use backend `id` as stable UID, add STARTTLS support, LRU message cache, session-local flags management, SEARCH command support, JWT credential and address+password dual login methods, and comprehensive test suite
- fix: |IMAP Proxy| Fix `getHeaders()` filtering and `store()` crash
- fix: |Email Parser| Fix `parse_email.py` using private `_payload` attribute causing encoding errors, use `get_payload(decode=True)` for proper email body decoding

## v1.3.0

### Features

- feat: |OAuth2| Add email format transformation support for OAuth2, allowing regex-based email format conversion from third-party login providers (e.g., transform `user@domain` to `user@custom.domain`)
- feat: |OAuth2| Add SVG icon support for OAuth2 providers, admins can configure custom icons for login buttons, preset icons for GitHub, Linux Do, Authentik templates
- feat: |Send Mail| Auto-hide sendmail tab, sendbox tab, and reply button when send mail is not configured

### Bug Fixes

- fix: |User Address| Fix address count limit check failure when anonymous creation is disabled for logged-in users, add public function `isAddressCountLimitReached` to unify address count limit logic

### Improvements

- refactor: |Code Refactoring| Extract address count limit check as a public function to improve code reusability
- perf: |Performance| Change address activity time update in GET requests to async execution using `waitUntil`, non-blocking response

## v1.2.1

### Bug Fixes

- fix: |Scheduled Tasks| Fix scheduled task cleanup error `e.get is not a function`, use optional chaining for safe access to Context methods

### Improvements

- style: |AI Extraction| Use softer blue color (#A8C7FA) for AI extraction info in dark mode to reduce eye strain

## v1.2.0

### Breaking Changes

- |Database| Add `source_meta` field, need to execute `db/2025-12-27-source-meta.sql` to update database or click database update button on admin maintenance page

### Features

- feat: |Admin| Add admin account page, display current login method and support logout (password login only)
- fix: |GitHub Actions| Fix container image name must be lowercase
- feat: |Email Forwarding| Add source address regex forwarding, filter by sender address, fully backward compatible
- feat: |Address Source| Add address source tracking feature, record address creation source (Web records IP, Telegram records user ID, Admin panel marked)
- feat: |Email Filtering| Remove backend keyword parameter, switch to frontend filtering of current page emails, optimize query performance
- feat: |Frontend| Unify address switching into a dropdown component, support switching in simple mode, add address management entry on the homepage
- feat: |Database| Add index for `message_id` field to optimize email update operations, need to execute `db/2025-12-15-message-id-index.sql` to update database
- feat: |Admin| Add custom SQL cleanup feature to maintenance page, support scheduled task execution of custom cleanup statements
- feat: |i18n| Backend API error messages now fully support Chinese and English internationalization
- feat: |Telegram| Bot supports Chinese/English switching, add `/lang` command to set language preference

## v1.1.0

- feat: |AI Extraction| Add AI email recognition feature, use Cloudflare Workers AI to automatically extract verification codes, authentication links, service links and other important information from emails
  - Support priority extraction: verification codes > authentication links > service links > subscription links > other links
  - Admin can configure address whitelist (supports wildcards, e.g. `*@example.com`)
  - Frontend list and detail pages display extraction results
  - Need to configure `ENABLE_AI_EMAIL_EXTRACT` environment variable and AI binding
  - Need to execute SQL in `db/2025-12-06-metadata.sql` file to update `D1` database or click database update button on admin maintenance page
- feat: |Admin| Add feature to cleanup addresses with empty mailboxes older than n days on maintenance page
- fix: Fix custom authentication password function issue (frontend property name error & /open_api interface blocked)

## v1.0.7

- feat: |Admin| Add IP blacklist feature for limiting high-frequency API access
- feat: |Admin| Add ASN organization blacklist feature, support filtering requests based on ASN organization name (supports text matching and regex)
- feat: |Admin| Add browser fingerprint blacklist feature, support filtering requests based on browser fingerprint (supports exact matching and regex)

## v1.0.6

- feat: |DB| Update db schema add index
- feat: |Address Password| Add address password login feature, enabled via `ENABLE_ADDRESS_PASSWORD` configuration, need to execute SQL in `db/2025-09-23-patch.sql` file to update `D1` database
- fix: |GitHub Actions| Fix debug mode configuration, only enable debug mode when DEBUG_MODE is 'true'
- feat: |Admin| Account management page adds multi-select batch operations (batch delete, batch clear inbox, batch clear outbox)
- feat: |Admin| Maintenance page adds feature to cleanup unbound user addresses
- feat: Support configuring different bound address quantity limits for different roles, configurable in admin page

## v1.0.5

- feat: Add `DISABLE_CUSTOM_ADDRESS_NAME` configuration: disable custom email address name feature
- feat: Add `CREATE_ADDRESS_DEFAULT_DOMAIN_FIRST` configuration: prioritize first domain when creating addresses
- feat: |UI| Add button to enter minimalist mode on homepage
- feat: |Webhook| Add whitelist switch feature, support flexible access control

## v1.0.4

- feat: |UI| Optimize minimalist mode homepage, add all emails page functionality (delete/download/attachments/...), switchable in `Appearance`
- feat: Admin account settings page adds `Email Forwarding Rules` configuration
- feat: Admin account settings page adds `Reject Unknown Address Emails` configuration
- feat: Email page adds Previous/Next buttons

## v1.0.3

- fix: Fix github actions deployment issue
- feat: telegram /new when domain not specified, use random address

## v1.0.2

- fix: Fix oauth2 login failure issue

## v1.0.1

- feat: |UI| Add minimalist mode homepage, switchable in `Appearance`
- fix: Fix oauth2 login default role not taking effect issue

## v1.0.0

- fix: |UI| Fix User inbox viewing, when address not selected, keyword query not working
- fix: Fix auto cleanup task, time 0 not taking effect issue
- feat: Cleanup feature adds cleanup of addresses created n days ago, cleanup of addresses inactive for n days
- fix: |IMAP Proxy| Fix IMAP Proxy server unable to view new emails issue

## v0.10.0

- feat: Support User inbox viewing, `/user_api/mails` interface, support `address` and `keyword` filtering
- fix: Fix Oauth2 login token retrieval, some Oauth2 require `redirect_uri` parameter issue
- feat: When user accesses webpage, if `user token` expires within 7 days, auto refresh
- feat: Add db initialization feature to admin portal
- feat: Add `ALWAYS_SHOW_ANNOUNCEMENT` variable to configure whether to always show announcements

## v0.9.1

- feat: |UI| Support google ads
- feat: |UI| Use shadow DOM to prevent style pollution
- feat: |UI| Support URL jwt parameter auto-login to mailbox, jwt parameter overrides browser jwt
- fix: |CleanUP| Fix cleanup emails when cleanup time exceeds 30 days error bug
- feat: Admin user management page: add user address viewing feature
- feat: | S3 Attachments| Add S3 attachment deletion feature
- feat: | Admin API| Add admin bind user and address api
- feat: | Oauth2 | When Oauth2 gets user info, support `JSONPATH` expressions

## v0.9.0

- feat: | Worker | Support multi-language
- feat: | Worker | `NO_LIMIT_SEND_ROLE` configuration supports multiple roles, comma separated
- feat: | Actions | Add `worker-with-wasm-mail-parser.zip` in build to support UI deployment with `wasm` worker

## v0.8.7

- fix: |UI| Fix mobile device date display issue
- feat: |Worker| Support sending emails via `SMTP`, using [zou-yu/worker-mailer](https://github.com/zou-yu/worker-mailer/blob/main/README_zh-CN.md)

## v0.8.6

- feat: |UI| Announcements support html format
- feat: |UI| `COPYRIGHT` supports html format
- feat: |Doc| Optimize deployment documentation, supplement `Github Actions Deployment Documentation`, add `Worker Variable Description`

## v0.8.5

- feat: |mail-parser-wasm-worker| Fix `deprecated` parameter warning when calling `initSync` function
- feat: rpc headers convert & typo (#559)
- fix: telegram mail page use iframe show email (#561)
- feat: |Worker| Add `REMOVE_ALL_ATTACHMENT` and `REMOVE_EXCEED_SIZE_ATTACHMENT` for removing email attachments, due to parsing emails some information will be lost, such as images.

## v0.8.4

- fix: |UI| Fix admin portal delete call api error when no recipient email
- feat: |Telegram Bot| Add telegram bot cleanup invalid address credentials command
- feat: Add worker configuration `DISABLE_ANONYMOUS_USER_CREATE_EMAIL` to disable anonymous user email creation, only allow logged-in users to create email addresses
- feat: Add worker configuration `ENABLE_ANOTHER_WORKER` and `ANOTHER_WORKER_LIST`, for calling other worker rpc interfaces (#547)
- feat: |UI| Auto refresh configuration saved to browser, configurable refresh interval
- feat: Spam detection adds check-when-exists list `JUNK_MAIL_CHECK_LIST` configuration
- feat: | Worker | Add `ParsedEmailContext` class for caching parsed email content, reduce parsing times
- feat: |Github Action| Worker deployment adds `DEBUG_MODE` output logging, `BACKEND_USE_MAIL_WASM_PARSER` configuration for whether to use wasm to parse emails

## v0.8.3

- feat: |Github Action| Add auto update and deploy feature
- feat: |UI| Admin user settings, support oauth2 configuration deletion
- feat: Add spam detection must-pass list `JUNK_MAIL_FORCE_PASS_LIST` configuration

## v0.8.2

- fix: |Doc| Fix some documentation errors
- fix: |Github Action| Fix frontend deployment branch error issue
- feat: Admin send email feature
- feat: Admin backend, account configuration page adds unlimited send email address list

## v0.8.1

- feat: |Doc| Update UI installation documentation
- feat: |UI| Hide mailbox account ID from users
- feat: |UI| Add `Forward` button to email detail page

## v0.8.0

- feat: |UI| Random address generation doesn't exceed max length
- feat: |UI| Email time display in browser timezone, can switch to display UTC time in settings
- feat: Support transferring emails to other users

## v0.7.6

### Breaking Changes

UI deployment worker needs to click Settings -> Runtime, modify Compatibility flags, add `nodejs_compat`

![worker-runtime](vitepress-docs/docs/public/ui_install/worker-runtime.png)

### Changes

- feat: Support pre-setting bot info to reduce telegram callback latency (#441)
- feat: Add telegram mini app build archive
- feat: Add whether to enable spam check `ENABLE_CHECK_JUNK_MAIL` configuration

## v0.7.5

- fix: Fix `name` validation check

## v0.7.4

- feat: UI list page adds minimum width
- fix: Fix `name` validation check
- fix: Fix `DEFAULT_DOMAINS` configuration empty not taking effect issue

## v0.7.3

- feat: Worker adds `ADDRESS_CHECK_REGEX`, address name regex, only for checking, matching will pass check
- fix: UI fix login page tab active icon misalignment
- fix: UI fix admin page refresh popup password input issue
- feat: Support `OAuth2` login, can login via `Github` `Authentik` and other third parties, see details [OAuth2 Third-party Login](https://temp-mail-docs.awsl.uk/en/guide/feature/user-oauth2.html)

## v0.7.2

### Breaking Changes

`webhook` structure adds `enabled` field, existing configurations need to be re-enabled and saved on the page.

### Changes

- fix: Worker adds `NO_LIMIT_SEND_ROLE` configuration, loading failure issue
- feat: Worker adds `# ADDRESS_REGEX = "[^a-z.0-9]"` configuration, regex for replacing illegal symbols, if not set, defaults to [^a-z0-9], use with caution, some symbols may cause receiving issues
- feat: Worker optimizes webhook logic, supports admin configuring global webhook, adds `message pusher` integration example

## v0.7.1

- fix: Fix user role loading failure issue
- feat: Admin account settings adds source email address blacklist configuration

## v0.7.0

### Breaking Changes

DB changes: Add user `passkey` table, need to execute `db/2024-08-10-patch.sql` to update `D1` database

### Changes

- Docs: Update new-address-api.md (#360)
- feat: Worker adds `ADMIN_USER_ROLE` configuration, for configuring admin user role, users with this role can access admin management page (#363)
- feat: Worker adds `DISABLE_SHOW_GITHUB` configuration, for configuring whether to show github link
- feat: Worker adds `NO_LIMIT_SEND_ROLE` configuration, for configuring roles that can send unlimited emails
- feat: User adds `passkey` login method, for user login, no password required
- feat: Worker adds `DISABLE_ADMIN_PASSWORD_CHECK` configuration, for configuring whether to disable admin console password check, if your site is only privately accessible, you can disable the check

## v0.6.1

- pages github actions && fix cleanup emails days 0 not taking effect by @tqjason (#355)
- fix: imap proxy server doesn't support password by @dreamhunter2333 (#356)
- worker adds `ANNOUNCEMENT` configuration, for configuring announcement info by @dreamhunter2333 (#357)
- fix: telegram bot create new address defaults to first domain by @dreamhunter2333 (#358)

## v0.6.0

### Breaking Changes

DB changes: Add user role table, need to execute `db/2024-07-14-patch.sql` to update `D1` database

### Changes

Worker configuration file adds `DEFAULT_DOMAINS`, `USER_ROLES`, `USER_DEFAULT_ROLE`, see documentation [worker configuration](https://temp-mail-docs.awsl.uk/en/guide/cli/worker.html)

- Remove `apiV1` related code and related database tables
- Update `admin/statistics` api, add user statistics info
- Update address rules, only allow lowercase+numbers, for historical addresses `lowercase` processing will be performed when querying emails
- Add user role feature, `admin` can set user roles (currently can configure domain and prefix for each role)
- Admin page search optimization, enter key auto search, input content auto trim

## v0.5.4

- Click logo 5 times to enter admin page
- Fix 401 cannot redirect to login page (admin and site authentication)

## v0.5.3

- Fix some bugs in smtp imap proxy server
- Improve user/admin delete inbox/outbox functionality
- Admin can delete send permission records
- Add Chinese email alias configuration `DOMAIN_LABELS` [documentation](https://temp-mail-docs.awsl.uk/en/guide/cli/worker.html)
- Remove `mail channels` related code
- github actions adds `FRONTEND_BRANCH` variable to specify deployment branch (#324)

## v0.5.1

- Add `mail-parser-wasm-worker` for worker email parsing, [documentation](https://temp-mail-docs.awsl.uk/en/guide/feature/mail_parser_wasm_worker.html)
- Add user email length validation configuration `MIN_ADDRESS_LEN` and `MAX_ADDRESS_LEN`
- Fix `pages function` not forwarding `telegram` api issue

## v0.5.0

- UI: Add local cache for address management
- worker: Add `FORWARD_ADDRESS_LIST` global email forwarding address (equivalent to `catch all`)
- UI: Multi-language uses routing for switching
- Add save attachments to S3 feature
- UI: Add received email list `batch delete` and `batch download`

## v0.4.6

- Worker configuration file adds `TITLE = "Custom Title"`, can customize website title
- Fix KV not bound unable to delete address issue

## v0.4.5

- UI lazy load
- telegram bot adds user global push feature (admin users)
- Add support for cloudflare verified user sending emails
- Add using `resend` to send emails, `resend` provides http and smtp api, easier to use, documentation: https://temp-mail-docs.awsl.uk/en/guide/config-send-mail.html

## v0.4.4

- Add telegram mini app
- telegram bot adds `unbind`, `delete` commands
- Fix webhook multiline text issue

## v0.4.3

### Breaking Changes

Configuration file `main = "src/worker.js"` changed to `main = "src/worker.ts"`

### Changes

- `telegram bot` whitelist configuration
- `ENABLE_WEBHOOK` add webhook
- UI: admin page uses two-level tabs
- UI: can directly switch addresses on homepage after login
- UI: outbox also uses split view display (similar to inbox)
- `SMTP IMAP Proxy` add outbox viewing

* feat: telegram bot TelegramSettings && webhook by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/244
* fix build by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/245
* feat: UI changes by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/247
* feat: SMTP IMAP Proxy: add sendbox && UI: sendbox use split view by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/248

## v0.4.2

- Fix some bugs in smtp imap proxy server
- Fix UI interface text errors, interface adds version number
- Add telegram bot documentation https://temp-mail-docs.awsl.uk/en/guide/feature/telegram.html

* fix: imap server by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/227
* fix: Maintenance wrong label by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/229
* feat: add version for frontend && backend by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/230
* feat: add page functions proxy to make response faster by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/234
* feat: add about page by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/235
* feat: remove mailV1Alert && fix mobile showSideMargin by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/236
* feat: telegram bot by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/238
* fix: remove cleanup address due to many table need to be clean by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/240
* feat: docs: Telegram Bot by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/241
* fix: smtp_proxy: cannot decode 8bit && tg bot new random address by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/242
* fix: smtp_proxy: update raise imap4.NoSuchMailbox by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/243

### v0.4.1

- Username limited to max 30 characters
- Fix `/external/api/send_mail` not returning bug (#222)
- Add `IMAP proxy` service, support `IMAP` viewing emails
- UI interface adds version number display

* feat: use common function handleListQuery when query by page by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/220
* fix: typos by @lwd-temp in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/221
* fix: name max 30 && /external/api/send_mail not return result by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/222
* fix: smtp_proxy_server support decode from mail charset by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/223
* feat: add imap proxy server by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/225
* feat: UI show version by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/226

### New Contributors

* @lwd-temp made their first contribution in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/221

## v0.4.0

### DB Changes/Breaking changes

Added user related tables for storing user information

- `db/2024-05-08-patch.sql`

### config changes

Enable user registration email verification requires `KV`

```toml
# kv config for send email verification code
# [[kv_namespaces]]
# binding = "KV"
# id = "xxxx"
```

### function changes

- Add user registration feature, can bind email addresses, automatically obtain email JWT credentials after binding
- Add default text display for emails, text and HTML email display mode switch button
- Fix `BUG` randomly generated email names are invalid #211
- `admin` email page supports email content search #210
- Fix bug where emails weren't deleted when deleting addresses #213
- UI adds global tab position configuration, side margin configuration

* feat: update docs by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/204
* feat: add Deploy to Cloudflare Workers button by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/205
* feat: add Deploy to Cloudflare Workers docs by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/206
* feat: add UserLogin by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/209
* feat: admin search mailbox && fix generateName multi dot && user jwt exp in 30 days && UI globalTabplacement && useSideMargin by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/214
* feat: UI check openSettings in Login page by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/215
* feat: UI move AdminContact to common by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/217
* feat: docs by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/218

## v0.3.3

- Fix Admin delete email error
- UI: Reply email button, quote original email text #186
- Add send email address blacklist
- Add `CF Turnstile` CAPTCHA configuration
- Add `/external/api/send_mail` send email api, use body verification #194

## v0.3.2

## What's Changed

- UI: Add reply email button
- Add scheduled cleanup feature, configurable in admin page (need to enable scheduled task in config file)
- Fix delete account no response issue

* feat: UI: MailBox add reply button by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/187
* feat: add cron auto clean up by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/189
* fix: delete account by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/190

## v0.3.1

### DB Changes

Added `settings` table for storing general configuration information

- `db/2024-05-01-patch.sql`

### Changes

- `ENABLE_USER_CREATE_EMAIL` whether to allow users to create emails
- Allow admin to create emails without prefix
- Add `SMTP proxy server`, support SMTP sending emails
- Fix some cases where browsers can't load `wasm` use js to parse emails
- Footer adds `COPYRIGHT`
- UI allows users to switch email display mode `v-html` / `iframe`
- Add `admin` account configuration page, support configuring user registration name blacklist

* feat: support admin create address && add ENABLE_USER_CREATE_EMAIL co… by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/175
* feat: add SMTP proxy server by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/177
* fix: cf ui var is string by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/178
* fix: UI mailbox 100vh to 80vh by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/179
* fix: smtp_proxy_server hostname && add docker image for linux/arm64 by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/180
* fix: some browser do not support wasm by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/182
* feat: add COPYRIGHT by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/183
* feat: UI: add user page: useIframeShowMail && mailboxSplitSize by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/184
* feat: add address_block_list for new address by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/185

## v0.3.0

### Breaking Changes

The prefix of the `address` table will migrate from code to db, please replace `tmp` in the sql below with your prefix, then execute.
If your data is important, please backup your database first.

**Note: Replace prefix**

```sql
update
    address
set
    name = 'tmp' || name;
```

### Changes

- Migrate the prefix of the `address` table from code to db
- `admin` account page adds send/receive email counts
- `admin` outbox page defaults to show all
- `admin` send permission page supports search by address
- `admin` email page uses split view UI

* feat: remove PREFIX logic in db by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/171
* feat: admin page add account mail count && sendbox default all && sen… by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/172
* feat: all mail use MailBox Component by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/173

**Full Changelog**: https://github.com/dreamhunter2333/cloudflare_temp_email/compare/0.2.10...v0.3.0

## v0.2.10

- `ENABLE_USER_DELETE_EMAIL` whether to allow users to delete account and emails
- `ENABLE_AUTO_REPLY` whether to enable auto reply
- fetchAddressError prompt improvement
- Auto refresh shows countdown

* feat: docs update by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/165
* feat: add ENABLE_USER_DELETE_EMAIL && ENABLE_AUTO_REPLY && modify fetchAddressError i18n && UI: show autoRefreshInterval by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/169

## v0.2.9

- Add rich text editor
- Admin contact info, won't show if not configured, can configure any string `ADMIN_CONTACT = "xx@xx.xxx"`
- Default send email balance, if not set, will be 0 `DEFAULT_SEND_BALANCE = 1`

## v0.2.8

- Allow users to delete emails
- Admin notifies user by email when modifying send permissions
- Send permission defaults to 1
- Add RATE_LIMITER rate limiting for sending emails and creating new addresses
- Some bug fixes

- feat: allow user delete mail && notify when send access changed by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/132
- feat: request_send_mail_access default 1 balance by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/143
- fix: RATE_LIMITER not call jwt by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/146
- fix: delete_address not delete address_sender by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/153
- fix: send_balance not update when click sendmail by @dreamhunter2333 in https://github.com/dreamhunter2333/cloudflare_temp_email/pull/155

## v0.2.7

- Added user interface installation documentation
- Support email DKIM
- Rate limiting configuration for `/api/new_address`

## v0.2.6

- Added admin query outbox page
- Add admin data cleaning page

## 2024-04-12 v0.2.5

- Support send email

DB changes:

- `db/2024-04-12-patch.sql`

## 2024-04-10 v0.2.0

### Breaking Changes

- remove `ENABLE_ATTACHMENT` config
- use rust wasm to parse email in frontend
- deprecated api moved to `/api/v1`

### Rust Mail Parser

Due to some problems with nodejs' email parsing library, this version switches to using rust wasm to call rust's mail parsing library.

- Faster speed, good attachment support, can display attachment images of emails
- Parsing supports more rfc specifications

### DB changes

The `mails` table will be discarded, and the `raw` text of the new `mail` will be directly stored in the `raw_mails` table

## Upgrade Step

```bash
git checkout v0.2.0
cd worker
wrangler d1 execute dev  --file=../db/2024-04-09-patch.sql --remote
pnpm run deploy
cd ../frontend
pnpm run deploy
```

Note: For historical messages, use the Deploy New web page to view old data.

```bash
git checkout feature/backup
cd frontend
# Create a new pages for accessing old data
pnpm run deploy --project-name temp-email-v1
```

## 2024-04-09 v0.0.0

release v0.0.0

## 2024-04-03

DB changes

- `db/2024-04-03-patch.sql`

Changes:

- add delete account
- add admin panel search

## 2024-01-13

DB changes

- `db/2024-01-13-patch.sql`
