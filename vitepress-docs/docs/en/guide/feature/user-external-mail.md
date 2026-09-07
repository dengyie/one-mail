# Self-service External Mailbox Aggregation

Normal users can aggregate their own external mailboxes (Gmail / QQ / 163 / Outlook, or any IMAP/POP3 mailbox) into the unified inbox, where each person sees only their own mail. Useful for account isolation when the site is opened to many users.

## Prerequisites

- The unified inbox account system is deployed with user login enabled (`ADMIN_USER_ROLE`, etc.).
- The Worker has `MAIL_CRED_ENCRYPTION_KEY` configured (32 bytes base64, generated with `openssl rand -base64 32`). When unset, this feature fails closed and is unavailable.
- The one-mail IMAP aggregator (Python, runs every 5 minutes) is deployed; it fetches external mailboxes and writes rows into the `emails` table. The Worker cannot hold long TCP connections for IMAP/POP3, so fetching must be done by the aggregator.

## How it works

1. On the "My Mailboxes" page, the user enters the external mailbox IMAP/POP3 host, port, email address, app-password / authorization code (protocol `auto`/`imap`/`pop3`) and submits.
2. The Worker encrypts the credential with AES-GCM (`MAIL_CRED_ENCRYPTION_KEY`) and stores it in D1 `user_mail_accounts.cred_enc`; the plaintext is never persisted.
3. Each aggregator run fetches all `enabled=1` user mailboxes via `GET /admin/unified/mail_accounts` (`x-admin-auth` protected), decrypts the credentials, logs in, and writes the mail with `to_addr = the mailbox address`. `to_addr` always uses the `username` entered at connect time (not the message `To:` header), so alias / mailing-list forwarding / bcc / multi-recipient mail is still visible to the mailbox owner; the original `To:` header is preserved verbatim in `headers_json`.
4. The unified inbox isolates by `to_addr`: a normal user's scope = their bound site addresses ∪ their external mailbox `username`s, so they only see their own mail; admins see everything.
5. After each sync the aggregator writes back `last_sync_at` / `last_error` (`POST /admin/unified/mail_accounts/:id/status`, `x-admin-auth` protected): a login failure (e.g. wrong app-password) shows up directly on the "My Mailboxes" page via `last_error` instead of silently receiving no mail.

## User endpoints (`x-user-token` auth)

```bash
GET  /user_api/mail_accounts            # list your own connected mailboxes (never returns cred_enc)
POST /user_api/mail_accounts            # connect a new mailbox
DELETE /user_api/mail_accounts/:id      # delete (WHERE user_id prevents cross-user access)
POST /user_api/mail_accounts/:id/toggle # enable/disable
```

Create request body:

```json
{
  "label": "My QQ",
  "source": "imap_qq",
  "host": "imap.qq.com",
  "port": 993,
  "username": "you@qq.com",
  "cred": "app-password / authorization code",
  "protocol": "auto",
  "folders": ["INBOX"]
}
```

`source` enum: `imap_gmail` / `imap_outlook` / `imap_qq` / `imap_163` / `imap_custom`. Connect operations are rate-limited at 5/min/IP.

> [!NOTE] Personal Hotmail / Outlook.com (MSA) vs organizational accounts
> Microsoft has disabled IMAP Basic authentication in all tenants, so personal
> `@hotmail.com` / `@outlook.com` / `@live.com` accounts can **only** use OAuth2/XOAUTH2
> (scope `imap.outlook.office.com/IMAP.AccessAsUser.All offline_access`). On the aggregator
> side `oauth.provider` accepts `msa` / `hotmail` / `outlook_personal` (all normalized to
> `msa`, going through the `/consumers` public client with no `client_secret` required).
> Organizational (work/school) accounts still use `outlook` + `client_secret`. From the guide and
> full design see [[adr-hotmail-oauth-support]] and `aggregator/scripts/msa_authorize.py`.

## Connection-count quota

The number of external mailboxes a user may connect defaults to **5** and is configurable per role (the "Max External Mailboxes" column on the admin "Role Address Config" page):

- The setting is stored in the D1 `settings` table under the `role_address_config` key as `RoleConfig.maxMailAccountCount` (`{"<role>":{"maxMailAccountCount": <n>}}`).
- A role without `maxMailAccountCount`, or a negative value, falls back to the default 5.
- `0` means **unlimited** (same semantics as the address quota `maxAddressCount`).

External mailbox connections are **counted separately** and do not consume the site address quota (`maxAddressCount`): the `source_meta='external'` placeholder rows bound by connected external mailboxes are excluded from the `isAddressCountLimitReached` address count, so connecting external mailboxes never eats into a user's site-domain address allowance.

## Aggregator credential-fetch endpoint (admin)

```bash
GET /admin/unified/mail_accounts
Header: x-admin-auth: <admin_password>
```

Returns all `enabled=1` user mailboxes with decrypted plaintext credentials, for the aggregator to use in memory only:

```json
{ "accounts": [ { "id": "...", "source": "imap_qq", "host": "...", "port": 993,
  "username": "you@qq.com", "password": "<plaintext>", "protocol": "auto",
  "folders": ["INBOX"], "oauth": null } ] }
```

## Security notes

- `MAIL_CRED_ENCRYPTION_KEY` is stored only in `wrangler.toml` (gitignored) and the password vault, never committed. Rotating the key requires re-encrypting all credentials.
- `cred_enc` is never returned by any `user_api` endpoint; only `/admin/unified/mail_accounts` decrypts and returns it under an admin token.
- Delete / toggle / query are all scoped with `WHERE user_id = ?` to prevent cross-user access.
- An external mailbox address can be connected by only one user: a second user attempting the same address is rejected (400, backed by a DB partial unique index), preventing cross-user forged-mail injection at the source.
