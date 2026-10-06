<!-- markdownlint-disable-file MD033 MD045 -->
# One-Mail — Next-Gen AI-Native Unified Inbox & Edge Serverless Mail Hub

<p align="center">
  <a href="README.md"><img alt="简体中文" src="https://img.shields.io/badge/README-简体中文-blue.svg"></a>
  <a href="README_EN.md"><img alt="English" src="https://img.shields.io/badge/README-English-blue.svg"></a>
  <a href="README_JA.md"><img alt="日本語" src="https://img.shields.io/badge/README-日本語-blue.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-green.svg"></a>
  <img alt="Vue 3" src="https://img.shields.io/badge/Vue-3.5-4FC08D?logo=vue.js&logoColor=white">
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white">
  <img alt="Hono" src="https://img.shields.io/badge/Hono-v4-E36002?logo=hono&logoColor=white">
  <img alt="Tailwind CSS" src="https://img.shields.io/badge/TailwindCSS-v4-38B2AC?logo=tailwind-css&logoColor=white">
  <img alt="Passkeys" src="https://img.shields.io/badge/WebAuthn-Passkeys-4285F4?logo=webauthn&logoColor=white">
  <img alt="Tests" src="https://img.shields.io/badge/tests-100%25_passing-brightgreen.svg">
</p>

<p align="center">
  <b>Say goodbye to juggling dozens of email clients and digging through spam for verification codes.</b><br>
  Consolidate Gmail, Outlook, QQ, 163, and custom IMAP/POP3 mailboxes into a globally distributed Cloudflare edge network.<br>
  Featuring <b>Instant OTP / Code Extraction Capsules</b>, <b>AI-Powered Summarization</b>, <b>FIDO2 Passkeys Biometric Login</b>, and <b>Disposable / Custom Domain Inboxes</b>.
</p>

<p align="center">
  <a href="#key-features">Key Features</a> •
  <a href="#system-architecture">Architecture</a> •
  <a href="#why-one-mail">Comparison</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#open-api--developer-ecosystem">Open API</a> •
  <a href="#license">License</a>
</p>

---

## Why One-Mail?

Whether managing systems, building products, or working remotely, juggling separate accounts for Gmail, Outlook, 163, QQ, and company domains is notoriously painful. Traditional desktop clients are heavy, prone to network limits, lack smart OTP extraction, and require manual device-by-device configuration. Meanwhile, commercial aggregation platforms introduce data privacy concerns along with recurring subscription fees.

One-Mail was engineered from scratch to resolve these challenges:
- **100% Edge Serverless**: Core APIs run on Cloudflare Workers + D1 at the edge. Cold starts are near-zero, worldwide latency is sub-50ms, and everyday personal usage incurs **zero server or database cost**.
- **Privacy & Zero-Trust Security**: Self-hosted sovereignty. All mailbox credentials and OAuth refresh tokens are encrypted at rest with AES-GCM-256 before hitting storage. Passkey passwordless login eliminates credential phishing.
- **AI-Native Efficiency**: No need to scroll through marketing clutter—instant OTP capsules and key action summaries are front and center on the mail list cards.

---

## Key Features

| Module | Highlights | Technical Edge & Value |
|---|---|---|
| **Unified Multi-Account Inbox**<br>`Unified Inbox` | • Aggregates Gmail, Outlook / 365, QQ, 163, and custom IMAP/POP3<br>• **IMAP IDLE millisecond-level real-time push** + 60s fallback polling<br>• Smart protocol auto-downgrade (falls back to POP3 when IMAP is rejected)<br>• Process-level `redemption_lock` preventing concurrent OAuth token burn | Lightweight Python daemon + Cloudflare D1 idempotent upload, rock-solid without missed emails |
| **Instant OTP Extraction Capsule**<br>`Instant OTP Capsule` | • Detects 4-8 digit codes, `123-456` hyphens, and `G-123456` prefixes<br>• Negative lookaheads eliminate false positives (calendar years, dates, prices)<br>• **One-click copy capsule** displayed directly on email cards | High-precision multilingual regex engine; 90% time saved opening full mail |
| **AI-Native Email Insights**<br>`AI Summarization` | • Auto-extracts email intent, sender reputation, and action items<br>• Clean plain-text structured synthesis<br>• Client-side FIFO/LRU cache (capacity: 50) for instant zero-lag switching | Edge & frontend dual optimization; zero unnecessary API bills and zero memory leaks |
| **Passkeys / WebAuthn Biometrics**<br>`WebAuthn / Passkeys` | • Full support for Apple Touch ID, Face ID, Windows Hello, and YubiKeys<br>• Eliminates master passwords and cross-device password sync fatigue<br>• Automatic device fingerprint naming with seamless fallback | SimpleWebAuthn v13 + FIDO2 compliant; impervious to phishing attacks |
| **Zero-Trust Credential Vault**<br>`Credential Vault` | • Mailbox authorization codes and OAuth tokens symmetrically encrypted<br>• Encryption keys strictly confined to Cloudflare Worker edge environment<br>• Granular API Key permissions (`readonly` / `admin` roles, source whitelist) | WebCrypto native AES-GCM-256 cryptography |
| **Modern Glassmorphic UI & UX**<br>`Awesome UI & UX` | • Vue 3 + Tailwind CSS + Naive UI glassmorphism design<br>• `<keep-alive>` lifecycle optimization: pauses timers when tabs are hidden<br>• Preserves deep query routes (keyword filters and pagination cursors)<br>• Smooth dark/light theme switching, responsive on mobile & desktop | Zero layout shift, optimized DOM footprint, and zero D1 quota waste |
| **All-in-One Disposable Mail Hub**<br>`Temp & Domain Mail` | • Disposable Temp-Mail: Powered by Cloudflare Email Routing; instant alias creation<br>• Custom Domain Inboxes: Multi-tenant isolation and virtual address routing<br>• Outbound Sending (Send Mail): Resend/SMTP/CF with `x-idempotency-key` replay safety | Rust WASM MIME parser and delivery dispute reconciliation |

---

## System Architecture

```text
  External Mail Providers
  ┌───────────────┐ ┌───────────────┐ ┌────────────────┐ ┌────────────────┐
  │  QQ / 163 Mail │ │ Gmail (OAuth) │ │ Outlook / 365  │ │ Custom IMAP/POP│
  └───────┬───────┘ └───────┬───────┘ └────────┬───────┘ └────────┬───────┘
          │                 │                  │                  │
          └─────────────────┴────────┬─────────┴──────────────────┘
                                     │ (IMAP IDLE Push / 60s Fallback Polling)
                                     ▼
                      ┌──────────────────────────────┐
                      │     VPS Python Aggregator    │
                      │         aggregator/          │
                      │ ──────────────────────────── │
                      │ • IMAP preferred, POP3 auto  │
                      │ • Token lock avoids RT burn  │
                      │ • 30MB limit skips anti-OOM  │
                      │ • Idempotent watermark sync  │
                      └──────────────┬───────────────┘
                                     │ (HTTPS REST API / x-admin-auth)
                                     ▼
        ┌────────────────────────────────────────────────────────────┐
        │       Cloudflare Edge Serverless Backend (worker/)         │
        │ ────────────────────────────────────────────────────────── │
        │ • Modern Hono v4 REST API router                           │
        │ • SimpleWebAuthn Passkeys FIDO2 biometrics                 │
        │ • AES-GCM-256 credential encryption & decryption vault     │
        │ • Rust WASM high-performance MIME parser (mail-parser-wasm)│
        │ • Cloudflare D1 (sharded SQLite) + KV + Email Routing      │
        │ • Scheduled 90-day retention cleanup lifecycle             │
        └────────────────────────────┬───────────────────────────────┘
                                     │ (JSON / Bearer Token / API Key)
                                     ▼
        ┌────────────────────────────────────────────────────────────┐
        │         Modern Decoupled Web Frontend (frontend/)          │
        │ ────────────────────────────────────────────────────────── │
        │ • Vue 3 + Vite + Tailwind CSS + Naive UI glassmorphic UX   │
        │ • Instant OTP extraction capsule with 1-click clipboard    │
        │ • AI email summaries with client-side LRU cache            │
        │ • keep-alive lifecycle awareness (pauses timers on idle)   │
        │ • Multi-locale deep routing (zh / en / ja / es / pt / de)  │
        └────────────────────────────────────────────────────────────┘
```

---

## Why One-Mail?

| Evaluation Criteria | One-Mail | Traditional Desktop Clients | Commercial SaaS Aggregators |
|---|:---:|:---:|:---:|
| **Operating Cost** | **$0 Serverless** (Cloudflare generous free tier) | Requires dedicated local client | Expensive per-seat monthly subscription |
| **Real-time Sync** | **Cloud-aggregated**, open any browser to view | Per-device config; no rule or state sync | Relies on proprietary cloud storage |
| **Privacy & Sovereignty** | **100% self-hosted**, edge symmetric encryption | Plaintext on local drive | Email data uploaded to third-party clouds |
| **Passwordless Auth** | **Native Passkeys / WebAuthn (Touch ID/Face ID)** | Master password only | Traditional username/password |
| **OTP Code Extraction** | **On-card OTP capsule, 1-click copy** | Must open and read through full email | Basic text preview only |
| **AI Email Summary** | **Built-in AI summarization with LRU cache** | None or costly plugins | High-tier premium paid feature |
| **Disposable Mail** | **Built-in temp mail & custom domain aliases** | Not supported | Not supported |
| **IP Ban Protection** | **Smart POP3 fallback & concurrency locks** | Prone to aggressive rate-limits | Subject to vendor policy shifts |

---

## Quick Start

One-Mail adopts a modern decoupled architecture composed of three main parts: **Cloudflare Worker API**, **Decoupled Web Frontend**, and **VPS Python Aggregator**.

### 1. Deploy Cloudflare Worker (Backend Edge)

> Ensure you have Node.js 20+ and pnpm installed.

```bash
# 1. Clone the repository
git clone https://github.com/dengyie/one-mail.git
cd one-mail/worker

# 2. Install dependencies
pnpm install

# 3. Configure wrangler.toml
cp wrangler.toml.template wrangler.toml
# Edit wrangler.toml: fill in your Cloudflare D1 database ID, KV namespace ID, and MAIL_CRED_ENCRYPTION_KEY

# 4. Apply database migrations
pnpm wrangler d1 migrations apply DB --remote

# 5. Deploy to Cloudflare edge network
pnpm deploy
```

Once deployed, you will obtain your Worker API URL (e.g., `https://mail-api.yourdomain.com`).

---

### 2. Configure VPS Aggregator (Sync Engine)

The aggregator runs on standard Python 3.10+ without heavy C extensions and consumes less than 50MB of RAM.

```bash
cd ../aggregator

# 1. Copy configuration template
cp config.example.json config.json
# Edit config.json: set email accounts (protocol: auto/imap/pop3), passwords/OAuth, and Worker API endpoints

# 2. Install in editable/production mode
pip install -e .

# 3. Recommended: run as a resident daemon with Supervisord
# See deploy/supervisor.conf for a production-ready supervisor configuration
# The aggregator activates IMAP IDLE real-time listening and 60s fallback polling automatically
```

---

### 3. Build & Deploy Web Frontend

The frontend is a lightweight Vue 3 SPA that can be hosted on Cloudflare Pages, Nginx, Docker, or Vercel.

```bash
cd ../frontend

# 1. Install frontend dependencies
pnpm install

# 2. Set environment variables
cp .env.example .env.local
# Set VITE_API_BASE=https://mail-api.yourdomain.com

# 3. Development server
pnpm dev

# 4. Production build
pnpm build
# Static bundle outputs to dist/, ready to be served by Nginx or Cloudflare Pages
```

#### Nginx Production Configuration

```nginx
server {
    listen 80;
    server_name inbox.yourdomain.com;

    root /www/one-mail/dist;
    index index.html;

    # Single Page Application fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Static assets cache header
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|wasm)$ {
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }
}
```

---

## Open API & Developer Ecosystem

One-Mail provides clean, developer-friendly RESTful endpoints for custom integrations, bots, and CI/CD pipelines.

### Authentication

- **Unified Inbox Endpoints**: `Authorization: Bearer <api-key>`
- **Management & Sync Endpoints**: `x-admin-auth: <ADMIN_PASSWORD>`

### Essential Endpoints

```http
# 1. List emails with pagination and keyword search
GET /api/unified/emails?source=gmail&limit=20&offset=0&q=invoice

# 2. Get unread and total email count
GET /api/unified/count?unread=1

# 3. Extract latest active verification code for an address
GET /api/unified/verifcodes?addr=user@example.com&fresh=1

# 4. Mark an email as read
POST /api/unified/emails/:id/read

# 5. Ingest messages from aggregator (idempotent UID deduplication)
POST /admin/unified/ingest

# 6. Send outbound email with replay protection
POST /api/send_mail
x-idempotency-key: 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d
```

---

## Tech Stack

- **Backend Edge**: Cloudflare Workers, Hono v4, Cloudflare D1 (SQLite), Cloudflare KV, SimpleWebAuthn
- **Frontend SPA**: Vue 3.5, Vite 7, Tailwind CSS v4, Naive UI, Lucide Icons, Marked, DOMPurify
- **Sync Daemon**: Python 3.10+, stdlib `imaplib`/`poplib`, Microsoft Graph API / Google OAuth 2.0
- **MIME Parser**: Rust WASM (`mail-parser-wasm`), Postal-Mime
- **DevOps & QA**: Vitest, Playwright, ESLint 9, GitHub Actions CI/CD Pipeline

---

## Internationalization (i18n)

Full localization support across multiple languages:
- 🇨🇳 简体中文 (`zh`)
- 🇺🇸 English (`en`)
- 🇯🇵 日本語 (`ja`)
- 🇪🇸 Español (`es`)
- 🇧🇷 Português (`pt-BR`)
- 🇩🇪 Deutsch (`de`)

---

## Contributing

Contributions, bug reports, and feature suggestions are warmly welcome!
- Please check existing [Issues](https://github.com/dengyie/one-mail/issues) before opening a new one.
- If One-Mail makes your digital life easier, please support the project by starring the repository.

---

## License

This project is licensed under the [MIT License](LICENSE).
You are free to use it for personal or commercial projects with attribution.
