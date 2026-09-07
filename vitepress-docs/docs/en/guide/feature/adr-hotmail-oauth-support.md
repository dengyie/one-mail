# ADR: Outlook / Hotmail mailbox onboarding — OAuth2 (XOAUTH2) support

- **Status: Implemented (Stage 0+1 on branch `feat/hotmail-oauth-support`)**
- **Date:** 2026-09-08
- **Scope:** `aggregator` OAuth client, a one-time device-code bootstrap script, config contract, Worker/Frontend integration

> This is the **development (design) document** for onboarding **personal @hotmail.com / @outlook.com (consumer MSA)** mailboxes into the one-mail unified inbox. It explains *why* OAuth is the only path, *what* exists today, *what* changes, and *how* to land it.
> **Stage 0 (`oauth.py` MSA branch + unit tests) and Stage 1 (`msa_authorize.py` bootstrap) were implemented on 2026-09-08 and fully pass: aggregator 132, worker 127, vitepress build green.**

---

## 1. Background & Motivation

Goal: allow a **personal** `@hotmail.com` / `@outlook.com` (consumer Microsoft) mailbox to be aggregated into the one-mail unified inbox.

**Hard facts (verified on pxed 2026-09-08 + official docs):**

1. Microsoft has **disabled Basic authentication for IMAP / POP / SMTP in every tenant**.
   - Microsoft Learn: [Deprecation of Basic authentication in Exchange Online](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online) → "Basic authentication is now disabled in **all** tenants."
   - By **2026-04-30**, SMTP AUTH Client Submission will be fully disabled, no exceptions.
2. Empirical evidence (pxed, through the one-mail SOCKS5 tunnel, using the same aggregator connection logic):
   ```
   [imap-mail.outlook.com]  LOGIN app-pass    -> LoginError: b'Basic authentication is disabled.'
   [imap-mail.outlook.com]  LOGIN wrong-pass  -> LoginError: b'Basic authentication is disabled.'
   ```
   **The correct and wrong passwords return the identical error** → this is a **protocol-level disable of Basic auth** on the server side, unrelated to the password. App Passwords are no longer guaranteed for all accounts either (MS Q&A / Stack Overflow, since ~2024-10).
3. Therefore the **only officially supported** way to access personal Hotmail/Outlook.com is **OAuth2 + XOAUTH2**:
   - Official: [Authenticate an IMAP, POP or SMTP connection using OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth) — OAuth2 supports **both Microsoft 365 and Outlook.com (personal accounts)**.
   - Permanent scope: `https://outlook.office.com/IMAP.AccessAsUser.All` + `offline_access`.

### Constraints in short

| Item | Current / constraint |
|---|---|
| Personal MSA accounts (hotmail/outlook.com) | **OAuth2 / XOAUTH2 only**; Basic auth disabled server-side |
| OAuth scopes | `https://outlook.office.com/IMAP.AccessAsUser.All` + `offline_access` |
| Easy token acquisition | **Device Code Flow** (officially recommended, personal MSA supported, no client secret, MSAL 4.5+) |
| one-mail existing | `aggregator/src/one_mail_agg/oauth.py` already has `outlook_access_token` (`grant_type=refresh_token` → `oauth2_login`, XOAUTH2) but **requires `client_secret` and won't work secret-less** |

---

## 2. Why today's `outlook` path fails for personal MSA

Existing:

```python
def outlook_access_token(oauth: dict) -> str:
    r = requests.post("https://login.microsoftonline.com/common/oauth2/v2.0/token", data={
        "client_id": oauth["client_id"], "client_secret": oauth["client_secret"],   # <- hard secret dep
        "refresh_token": oauth["refresh_token"], "grant_type": "refresh_token",
        "scope": "https://outlook.office.com/IMAP.AccessAsUser.All offline_access",
    }, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]
```

Problems:
- Personal MSA uses the **`/consumers` tenant** with a **public (confidential-less) client** — but the existing code sends a `client_secret`.
- It forces the user through Azure App Registration + client_secret + refresh_token — exactly the "too many binding details" flow.

---

## 3. Goals

1. Onboard **`@hotmail.com` / `@outlook.com` personal accounts**:
   - scope `IMAP.AccessAsUser.All` + `offline_access`
   - SASL **XOAUTH2** via the existing `oauth2_login`.
2. **Temporary bootstrap**: provide a **one-time "authorize script"** (device-code flow or auth-code flow) that, after the user logs in and approves in a browser, emits a `client_id` + `refresh_token` ready for config. Long-lived refresh token means **configure once, works forever**.
3. **Config contract**: support the new provider on both the admin side (`config.json`) and the user self-service side (`user_mail_accounts`).
4. **Do not break** existing gmail/outlook/qq/163: new provider branch, backward compatible.
5. **Security**: refresh tokens are long-lived credentials; they must live only in pxed `config.json` (chmod 600) and in D1 `oauth_enc` (encrypted); never in logs, never committed.

### Non-goals
- No organization (`/onmicrosoft.com`) multi-tenant compliance details (keep `/common` for org; use `/consumers` for personal).
- No full front-end OAuth authorization UI this iteration (only admin config + bootstrap script; a UI flow can follow under user_oauth2).
- No SMTP sending (scope is IMAP-read only).

---

## 4. Decision: add `provider = "msa"` (aliases `hotmail` / `outlook_personal`)

Without breaking the existing `imap_outlook` (organizational, secret-required), add a **public-client, no-secret** personal provider.

```text
provider value:   "msa"
compat aliases:   "outlook_personal" / "hotmail"
```

### 4.1 New function in `oauth.py`

```python
def msa_access_token(oauth: dict) -> str:
    """Personal MSA / Hotmail / Outlook.com refresh_token -> access_token.
    Uses the /consumers tenant with a public client (no client_secret required).
    """
    payload = {
        "client_id": oauth["client_id"],
        "refresh_token": oauth["refresh_token"],
        "grant_type": "refresh_token",
        "scope": "https://outlook.office.com/IMAP.AccessAsUser.All offline_access",
    }
    if oauth.get("client_secret"):          # optional: send only if present
        payload["client_secret"] = oauth["client_secret"]
    r = requests.post(
        "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        data=payload, timeout=30,
    )
    r.raise_for_status()
    return r.json()["access_token"]
```

Register in `_TOKEN_FN`:

```python
_TOKEN_FN = {
    "gmail": gmail_access_token,
    "outlook": outlook_access_token,   # organizational / secret flow
    "msa": msa_access_token,              # NEW: Hotmail/Outlook.com personal (consumer)
}
```

> `/consumers` is the official endpoint for **personal Microsoft accounts** (live / hotmail / outlook.com) token exchange. As a **public client**, `client_secret` may be omitted.

### 4.2 host / source mapping

Standard personal Hotmail/Outlook IMAP:
- host `outlook.office365.com:993` (recommended) or `imap-mail.outlook.com:993`, both SSL
- `source` (admin / UI) stays **`imap_outlook`** (no enum change to avoid a large frontend refactor); the auth method is distinguished by `oauth.provider == "msa"`.

### 4.3 aliases & backward compatibility
- Keep `outlook` → org/secret flow (existing tests unaffected).
- Add `msa`, and map `hotmail` / `outlook_personal` to `msa` during normalization.

---

## 5. Bootstrap script (device code flow)

New `aggregator/scripts/msa_authorize.py` (official Device Code Flow, works for personal MSA):

1. `GET https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode`
   body: `client_id=<PUBLIC_CLIENT_ID>&scope=offline_access+https%3A%2F%2Foutlook.office.com%2FIMAP.AccessAsUser.All`
2. Print the `user_code` and open/hint `verification_uri`.
3. The user logs in with the `@hotmail.com` account and approves.
4. The script polls `POST .../token` (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) → yields short-lived `access_token` and long-lived `refresh_token`.
5. Print two JSON lines ready to paste:
   ```json
   { "provider": "msa", "client_id": "<PUBLIC_CLIENT_ID>", "refresh_token": "<refresh_token>" }
   ```

You need a **public client_id**. For a personal project you can self-host-create an Azure App (Supported account types = **Personal Microsoft accounts only**), use that `client_id` as the public client. **No client_secret** is required for a public client in device-code flow.

An authorization-code variant may also be provided (redirect to `http://localhost`), but device-code is recommended (does not depend on a local callback).

---

## 6. Config contract

### 6.1 Admin (pxed `config.json`)

```json
{
  "id": "hotmail-main",
  "source": "imap_outlook",
  "host": "outlook.office365.com",
  "port": 993,
  "username": "someone@hotmail.com",
  "password": "ignored-by-oauth",
  "use_ssl": true,
  "oauth": {
    "provider": "msa",
    "client_id": "<PUBLIC_CLIENT_ID>",
    "refresh_token": "<refresh_token>"
  }
}
```

`AccountConfig.oauth` already accepts a dict; no loading change is needed.

### 6.2 User self-service (Worker `user_mail_accounts`)

`worker/src/user_api/mail_accounts.ts` has `OAUTH_PROVIDERS = {"gmail","outlook"}`. Add `"msa"`:

```ts
const OAUTH_PROVIDERS = new Set(["gmail", "outlook", "msa"]);
```

`oauth_enc` stores JSON `{"provider":"msa","client_id":"...","refresh_token":"..."}` (still AES-GCM encrypted). The aggregator routes the decrypted `oauth.provider == "msa"` to `msa_access_token`.

---

## 7. Files to change (draft)

| File | Change | Risk |
|---|---|---|
| `aggregator/src/oauth.py` | add `msa_access_token` + register in `_TOKEN_FN` | Low; purely additive |
| `aggregator/tests/test_oauth.py` | MSA personas (public, no-secret, with secret, malformed, unknown-provider isolation) | Medium |
| `worker/src/user_api/mail_accounts.ts` | add `"msa"` to `OAUTH_PROVIDERS` | Medium |
| `aggregator/scripts/msa_authorize.py` (new) | device-code / auth-code bootstrap | Low |

> "provider unsupported" is already isolated per-account in `main.py` (`32cdfce`), so an unknown provider no longer blocks an entire sync round.

---

## 8. Rollout order

- **Stage 0 (this task)**: `oauth.py` `msa_access_token` + unit tests → commit `feat: aggregator support personal Microsoft (Hotmail/Outlook) OAuth2 consumer`.
- **Stage 1 (draft)**: `aggregator/scripts/msa_authorize.py` device-code bootstrap producing `refresh_token`.
- **Stage 2 (optional, later)**: Worker `OAUTH_PROVIDERS` + frontend "Hotmail (personal)" entry.
- **Stage 3 (not required)**: full org-account Azure flow docs.

> This iteration is Stage 0+1: wire `msa/consumer` into the config and ship an **Azure-panel-free** authorization bootstrap.

---

## 9. Definition of Done

- [ ] pytest coverage for the new `msa` branch (mocked token endpoint) green; no regression on existing gmail/outlook cases.
- [ ] Using the bootstrap script, obtain a real `@hotmail.com` `refresh_token`, write it to pxed `config.json`, aggregator returns `synced>0` and empty `last_error`.
- [ ] A real new email lands in the one-mail unified inbox (`to_addr = username`).
- [ ] Secrets never hit logs / are never committed; the `basic auth is disabled` error is no longer consumed.
- [ ] Docs (this ADR + vitepress `user-external-mail` / `user-oauth2`, zh + en) and the changelog updated.

---

## 10. Appendix (official)

- Device-code flow + personal MSA: MSAL.NET device-code supports personal accounts and `/`; see [device-code flow](https://learn.microsoft.com/en-US/entra/msal/dotnet/acquiring-tokens/desktop-mobile/device-code-flow).
- IMAP/POP/SMTP OAuth scopes & XOAUTH2 encoding: see [Authenticate IMAP/POP/SMTP using OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth).
- Basic auth deprecation: see [Deprecation of Basic authentication](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online).