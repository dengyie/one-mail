# Frontend Development Guide (one-mail Unified Inbox)

> [!NOTE]
> This is the Vue 3 frontend for the **one-mail unified inbox**. The `frontend/` directory
> is forked from the upstream `cloudflare_temp_email` Vue frontend (Vue 3 + Vite + Naive UI),
> and since the frontend/backend separation (commit `64f0eda`) the frontend is the **only
> form that talks directly to the Worker cross-origin** — there is no Pages Functions proxy
> topology anymore.

---

## Architecture Overview

```
Browser (Vue 3 SPA)
   │  VITE_API_BASE points at the Worker custom domain
   │  (locally the Vite dev server proxies to 127.0.0.1:8787)
   ▼
Cloudflare Worker ──mail-api.mangoqwq.cc.cd
   │  ├─ /api/unified/*       unified inbox queries (API-key auth)
   │  ├─ /admin/unified/*     unified inbox admin (x-admin-auth)
   │  └─ /api/* · /user_api/* · /admin/*   temp-mail base (upstream capabilities)
```

The `frontend/` app is a pure static Vue 3 SPA:

- **Stack**: Vue 3 (Composition API) + Vite + Naive UI (`unplugin-auto-import` +
  `unplugin-vue-components`); `vue-router` 4, `vue-i18n` 11, `axios` (`api/index.js`),
  `@vueuse/core` (persisted global state), `@fingerprintjs` (device fingerprint).
- **Local dev**: `pnpm dev` starts the Vite dev server at `http://localhost:5173`; during
  dev the `/api`, `/open_api`, `/user_api`, `/admin`, `/telegram`, `/external` paths are
  proxied to `127.0.0.1:8787` via `vite.config.js`'s `server.proxy` (your local `wrangler dev`).
- **Production**: `VITE_API_BASE` points at the Worker custom domain (e.g.
  `https://mail-api.mangoqwq.cc.cd`); the build artifact is static, hosted by Cloudflare
  Pages, and every request goes cross-origin straight to the Worker.

> [!TIP]
> Minimal local backend: `cd worker && pnpm install && pnpm dev` (wrangler dev against a local
> D1/KV). Need a local D1 first — see `cli/d1` / `ui/d1`. The frontend dev server talks to
> `127.0.0.1:8787` with no extra CORS configuration.

---

## Directory Layout

```
frontend/
├── .env.example          # env var sample (see "Environment Variables" below)
├── .env.pages            # Pages build env (contains the production API URL)
├── vite.config.js        # Vite config + dev server.proxy + PWA + wasm plugin
├── package.json          # scripts: dev / build / build:pages / build:telegram ...
└── src/
    ├── main.js           # entry: createApp + i18n + router + @unhead/vue
    ├── App.vue
    ├── router/           # routes + global before-guard (locale/auth redirects)
    ├── store/index.js    # global state (@vueuse/core createGlobalState + useLocalStorage)
    ├── i18n/             # vue-i18n 11 config, message resources, locale utils
    ├── api/index.js       # the single API wrapper (axios instance + apiFetch + auth headers)
    ├── models/index.ts   # OAuth2 / type definitions
    ├── constant/index.ts # common mail domains etc.
    ├── utils/            # headers / fingerprint / email-parser / sanitize-html ...
    ├── components/       # shared components (MailBox / AddressCredentialModal / Turnstile ...)
    └── views/            # page views
```

---

## Key Modules

### API layer (`src/api/index.js`)

The single API wrapper. Empty `import.meta.env.VITE_API_BASE` sends requests to the same
origin (the Vite dev server, forwarded by proxy); a non-empty value crosses origin to the
Worker.

`apiFetch(path, options)`:
- Injects `x-user-token`, `x-user-access-token`, `x-custom-auth`, `x-admin-auth`,
  `Authorization: Bearer <jwt>`, plus `x-lang` and `x-fingerprint`.
- Every request runs values through `safeHeaderValue` / `safeBearerHeader`
  (`utils/headers.js`), dropping `undefined`/`null`, empty strings, the literals
  `"undefined"`/`"null"`, and any value containing control characters — so header injection
  like `Invalid character in header content` can't crash the request (issue #1000).
- Resolves to `response.data`; throws on HTTP ≥ 300; on 401 decides by endpoint whether to
  pop the login / admin modal.

### Router (`src/router/index.js`)

`createWebHistory` + locale-aware routes (`/:lang/*`), resolved via
`resolveSupportedLocale` / `getPreferredLocale`; paths without a locale prefix redirect to
the default locale.

> [!TIP]
> Adding a page: register it in `router/index.js`, add a component under `src/views/`, and
> — if it needs i18n strings — add them under `i18n/locales/*`.

### Global state (`src/store/index.js`)

Built on `@vueuse/core`'s `createGlobalState`, exposing `openSettings / settings / jwt /
userJwt / auth / adminAuth / userSettings / preferredLocale` as shared reactive state,
persisted through `useLocalStorage` so it survives reloads.

### Mail parsing (`src/utils/email-parser.js`)

`processItem(item)` prefers `mail-parser-wasm` for `raw` → sender/subject/body/attachments,
falling back to `postal-mime`. Attachments become `URL.createObjectURL` blobs and `cid:`
references are replaced with their blob url.

> [!NOTE]
> `/api/mails` returns raw RFC822 by design (including `raw`), and the frontend parses it
> into readable fields before rendering. The unified inbox `/api/unified/emails` returns
> already-parsed fields (`subject`/`from_addr` etc.).

---

## 2. Local Development

```bash
# 1) worker (backend)
cd worker
pnpm install
pnpm dev            # wrangler dev, listens on 127.0.0.1:8787

# 2) frontend (second terminal)
cd frontend
pnpm install
pnpm dev            # Vite dev server http://localhost:5173
```

Open `http://localhost:5173` in the browser to work against the local worker — no CORS
config needed (the dev proxy forwards the same origin).

- **Point dev requests at the right Worker**: keep `VITE_API_BASE` empty (unset) so
  requests stay same-origin and hit the proxy. If you set a non-empty value, requests go
  cross-origin straight to that Worker (usually not what you want for local debugging).
- **`server.proxy` in `vite.config.js`** already forwards `/api`, `/open_api`, `/user_api`,
  `/admin`, `/telegram`, `/external` to `http://127.0.0.1:8787`. Add a line if you expose a
  new path prefix.

---

## 3. Environment Variables

| Variable | Meaning | Required |
|----------|---------|----------|
| `VITE_API_BASE` | Worker root (`https://` prefix, no trailing `/`). Required in production; empty = same-origin (local dev only). | Required in prod |
| `VITE_CF_WEB_ANALY_TOKEN` | Cloudflare Web Analytics token (optional) | No |
| `VITE_IS_TELEGRAM` | Telegram-only build toggle (`true` → use `build:telegram`) | No |

> [!WARNING]
> **Never** commit real secrets/tokens. `.env.example` / `.env.pages.example` only hold
> placeholders plus explanations; `.env.pages` is gitignored and never committed.

> [!NOTE]
> `frontend/.env.pages` is now covered by the root `.gitignore` (I1 security hardening) — it
> is a secret landing zone and must not be committed; only `.env.pages.example` is kept in the
> repo. However, `pnpm build:pages` implicitly loads `.env.pages` (Vite `-m pages`), so the
> pxed deploy must `scp`/inject `frontend/.env.pages` to the build host **before** running
> `pnpm build:pages` (values per `.env.pages.example`).

Example:

```bash
# .env.local (local / custom environment)
VITE_API_BASE=https://mail-api.mangoqwq.cc.cd
VITE_CF_WEB_ANALY_TOKEN=
```

---

## 4. Build / Deploy Matrix

| Target | Command | Notes |
|--------|---------|-------|
| Local preview | `pnpm dev` | Vite dev server (proxy → 8787) |
| Static artifact | `pnpm build` | Production build to `dist/` |
| Pages deploy | `pnpm build:pages` | Pages-shaped `dist/` (uses `.env.pages` API base) |
| Pages deploy (no PWA) | `pnpm build:pages:nopwa` | As above, without Service Worker |
| Telegram form | `pnpm build:telegram` | Slim Telegram-only single page |
| Deploy to Pages (CLI) | `pnpm deploy` | `build` + `wrangler pages deploy ./dist --branch production` |

After `build:pages`, upload `dist/` to Cloudflare Pages (connected repo or manual upload)
and bind your custom domain. The frontend is fully static — every API call goes
cross-origin to the Worker via `VITE_API_BASE`, so the page host needs no reverse proxy.

---

## 5. one-mail Unified Inbox & API Auth

### Logged-in user and API-key auth

`/api/unified/*` supports two auth channels, with the existing user system as the preferred browser path:

- A logged-in user sends `x-user-token` (the existing `users` JWT). Users whose role matches `ADMIN_USER_ROLE` are administrators and can see all aggregated mail.
- Normal users are scoped through `users_address → address.name → emails.to_addr`, so they can only see mail addressed to their bound addresses. A user with no bound address is fail-closed and sees no rows.
- Without a logged-in user, `Authorization: Bearer <apiKey>` remains available for the aggregator and scripted access.
- API keys are created by `POST /admin/unified/keys` (`x-admin-auth` protected); the plaintext is returned only once. Keys may carry `role` (`readonly` / `admin`) and `allowed_sources` / `allowed_accounts` whitelists.
- Single-mail reads and mark-read, plus verification-code queries, enforce the corresponding row/address scope. API-key row checks fail closed for missing or empty `source`/`account_id` values.

### Unified inbox API endpoints

| Endpoint | Method | Purpose | Auth |
|----------|--------|---------|------|
| `/api/unified/emails` | GET | Paginated mail query (filter `source`/`account_id`/`unread`) | User JWT / API-key |
| `/api/unified/emails/:id` | GET | Single mail (incl. raw, scoped) | User JWT / API-key |
| `/api/unified/count` | GET | Mail count | User JWT / API-key |
| `/api/unified/verifcodes` | GET | Verification-code mail query (`addr`/`fresh`, scoped) | User JWT / API-key |
| `/api/unified/emails/:id/read` | POST | Mark as read (scoped; `readonly` key → 403) | User JWT / API-key |
| `/api/unified/ingest` | POST | Ingest from aggregator | `x-admin-auth` |
| `/admin/unified/keys` | POST | Create API-key | `x-admin-auth` |

---

## 6. Unified Inbox Frontend Page

The unified inbox page (top-nav "Unified", route `/unified`) is a dedicated view assembled
with Tailwind + awesome-ui components. It reads the cross-account mails aggregated by the
Python aggregator through `/api/unified/*`. Routes: `/unified` (main page) and
`/unified/:id` (single-mail detail).

### Tailwind wiring

- `src/tailwind.css`: `@import "tailwindcss"` + `@custom-variant dark (&:where(.dark, .dark *))`
  so `dark:` utilities follow the site-wide `useDark` (class strategy, `<html class="dark">`).
- `vite.config.js`: adds the `@tailwindcss/vite` plugin; the build emits Tailwind utilities.
- Coexists with Naive UI: Tailwind preflight does not override Naive component styles, and the
  zinc utilities are only used by this page and the awesome-ui components.

### Page structure (4 views)

| Tab | Description |
|-----|-------------|
| Mail List | Paginated (`limit`/`offset`) with `source`/`account_id`/`unread` filters + `q` keyword search; clicking a row opens the detail |
| Verification Codes | Recipient address + `fresh` window (10min/1h/24h); cards highlight the `code` with one-click copy |
| Aggregator Status | Derived from `/api/unified/count` + list rows: totals / unread / sources / accounts (frontend view; the actual IMAP/POP3 fetch is done by the Python aggregator) |
| API Settings | Paste/save the API-key (localStorage only); "Test connection"; admins can create a key (plaintext shown once) |

### Key implementation points

- `src/api/index.js`: logged-in users use `unifiedUserFetch`, which injects `x-user-token`; guests
  fall back to `unifiedFetch` with `Authorization: Bearer <unifiedApiKey>`. Neither path flips global
  loading; `buildUnifiedQuery` joins `source`/`account_id` arrays into comma-separated values.
- The page shows a login entry when neither a user JWT nor an API key is available. After login, no
  API key is required: administrators see all mail and normal users are scoped by the Worker to bound addresses.
- `UnifiedInboxDetail.vue` applies the same auth selection for direct deep links, so single-mail reads
  and mark-read cannot bypass the Worker scope.
- `src/store/index.js`: `unifiedApiKey` (`useLocalStorage`) persists the key.
- `src/components/ai/`: pure-Tailwind components copied from awesome-ui (`StatusIndicator`,
  etc., `<script setup lang="ts">` usable as-is).
- Body rendering: prefers `text_body`; falls back to a minimal HTML-to-text conversion for
  `html_body`. **Never uses `v-html`**.
- i18n: a `unified` namespace was added to `src/i18n/message-registry.ts`; the page uses
  `useScopedI18n('unified')`.

### Build verification

`pnpm build` emits two dedicated chunks (`UnifiedInbox`, `UnifiedInboxDetail`); Tailwind styles
compile into `index-*.css`. Local dev: run `worker` with `pnpm dev` (local D1) and the frontend
with `pnpm dev` (proxied to `127.0.0.1:8787`); after pasting an API-key in Settings the views
start fetching.

---

## 7. Style & Reference Points

- Entry: `src/main.js`
- Global router guard: `src/router/index.js` (locale redirect + `jwt` query handling)
- The single API layer: `src/api/index.js`
- Global state: `src/store/index.js`
- Components live in `src/components/`, pages in `src/views/`
- `src/utils/` holds pure helpers (headers / fingerprint / email-parser / sanitize-html ...)

Preferred conventions:

- ESM imports only (`type: module`).
- Vue 3 Composition API (`<script setup>`).
- Naive UI components are auto-imported by `unplugin-vue-components` — don't manually
  import `NButton` etc. into every file.
- Shared constants in `src/constant/`, types in `src/models/`, i18n messages in `src/i18n/`.

---

## 8. FAQ

**Q: Endpoints 404 / CORS in dev**
: Make sure `VITE_API_BASE` is empty (path proxy) and your local worker is on
  `127.0.0.1:8787`. If you set a non-empty `VITE_API_BASE` and your local worker isn't
  listening there, requests hit the remote endpoint.

**Q: Change to `vite.config.js` needs a restart**
: Vite auto-restarts the dev server on `vite.config.*` changes.

**Q: Weird characters in a token crash the request**
: `safeHeaderValue` in `utils/headers.js` drops values containing control characters /
  empty strings. If you hit `Invalid character` in an `Authorization`/token header, check
  whether a stale localStorage value got polluted (e.g. with `\n` / spaces).

**Q: Production shows no data (401/403)**
: Check `VITE_API_BASE` points at the right Worker; verify `x-custom-auth`/Bearer is valid;
  and that the API-key whitelist covers the target `source`/`account_id`.

---

> This guide stays aligned with the repository changelogs (zh: `CHANGELOG.md`, en:
> `CHANGELOG_EN.md`). Any frontend change must be recorded in both languages.