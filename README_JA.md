<!-- markdownlint-disable-file MD033 MD045 -->
# one-mail — 統合受信トレイ

<p align="center">
  <a href="README.md"><img alt="中文" src="https://img.shields.io/badge/README-中文-blue"></a>
  <a href="README_EN.md"><img alt="English" src="https://img.shields.io/badge/README-English-blue"></a>
  <a href="README_JA.md"><img alt="日本語" src="https://img.shields.io/badge/README-日本語-blue"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

> **統合受信トレイ**: 複数のメールアカウント（QQ / 163 / Gmail / Outlook …）に散らばるメールを、**VPS 上のアグリゲーター** が定期的に取得して Cloudflare Worker の統一 API に集約。フロントエンドで、各メールボックスの認証コードやログイン確認メールをひとつの場所で確認できます。

本プロジェクトはチームが**ゼロから自主開発**したもので、一時メール基盤（Cloudflare Email Routing + Worker 受信 + Vue フロントエンド）と、その上に **one-mail 統合受信トレイ** の能力を備えています。

> 現時点の外部メール対応は主に**単方向の受信集約**です。既読の書き戻し、削除/アーカイブ/移動、外部アカウントとしての送信、スレッド、完全な添付ファイル処理は現在開発中です。目標アーキテクチャ、段階的計画、受け入れ基準は [統合メールボックス開発設計](vitepress-docs/docs/zh/guide/feature/unified-mailbox-development.md) を参照してください（中文）。

---

## アーキテクチャ

```
メールプロバイダ (IMAP/POP3)
   QQ / 163 / Gmail / Outlook ...
        │  (VPS アグリゲーターがポーリング)
        ▼
VPS Python アグリゲーター  aggregator/
   │  IMAP 優先、自動 POP3 フォールバック
   │  BATCH_SIZE / BATCH_BYTES でウィンドウ収束、超大メールはスキップ（OOM 対策）
   ▼
Cloudflare Worker ──mail-api.mangoqwq.cc.cd──> API (worker/)
   │  ├─ /api/unified/*        統合受信トレイ照会（API-key 認証）
   │  ├─ /admin/unified/*      管理 / ingest（admin 認証）
   │  └─ /api/* ·/user_api/* ·/admin/*  一時メール基盤
   ▼
frontend/  —  VITE_API_BASE で Worker に直接接続（前後端分離）
```

## コンポーネント

| コンポーネント | 技術スタック | 役割 |
|---|---|---|
| `worker/` | TS + Hono · Workers · D1 | 統合受信トレイ API + 一時メール基盤 |
| `aggregator/` | Python 3（stdlib） | IMAP/POP3 をポーリングし、冪等にアップロード |
| `frontend/` | Vue 3 + Naive UI | UI。Worker に直接接続 |
| `pages/` | 静的シェル | 任意の静的ホスティング（Functions なし） |
| `db/` | D1 SQLite | 統合スキーマ + マイグレーション |
| `mail-parser-wasm/` | Rust WASM | メール解析 |
| `smtp_proxy_server/` | Python | ローカル開発用 SMTP/IMAP プロキシ |

## 統合受信トレイ

認証 — 一時メール基盤の JWT とは別系統:

| スコープ | ヘッダー | 発行元 |
|---|---|---|
| `/api/unified/*`（照会） | `Authorization: Bearer <api-key>` | `POST /admin/unified/keys` |
| `/admin/unified/*`（管理） | `x-admin-auth` | `ADMIN_PASSWORDS[0]` |

API キーは `readonly` / `admin` の 2 ロールで、`allowed_sources` / `allowed_accounts` によるスコープ指定が可能です。

主要エンドポイント: `GET /api/unified/emails`（一覧 + `q=` キーワード検索）· `/count` · `/verifcodes` · `/:id` · `POST /:id/read` · `POST /admin/unified/ingest` · `POST /admin/unified/keys` · `GET /admin/unified/mail_accounts`（アグリゲーターが有効なユーザーメールボックスと復号済み資格情報を取得、`x-admin-auth`）· `POST /admin/unified/mail_accounts/:id/status`（アグリゲーターが同期状態 / `last_error` を書き戻し、`x-admin-auth`）。

アグリゲーターの特長:
- **`protocol: auto`** — まず IMAP を試し、`Unsafe Login` で拒否されたら POP3 に自動フォールバック（163 で検証済み）。その後アカウントを**固定**し、imap:/pop3: の重複を防ぎます。
- **バッチ同期** — `BATCH_SIZE`（200）/ `BATCH_BYTES`（64 MiB）でウィンドウ化し `last_uid` を進めます。`MAX_SINGLE_BYTES`（30 MiB）超の超大メールはスキップします。
- **冪等** — Worker 側で `(uidvalidity, imap_uid)` ユニークインデックスによる重複アップロード防止。

### 保持ポリシー（D1）

`scheduled` 実行のたびに `is_read=1` かつ `received_at` が 90 日より古いメールをページング削除します（D1 行）。R2 添付ファイルのクリーンアップは予約ロジックです（`retention.ts` は `ATTACHMENTS` バケットがバインドされ**かつ**行が `r2_key` を持つ場合のみ発火）。本番環境には R2 バインディングがなく、アグリゲーターも `r2_key` を書き込まないため、実際には D1 クリーンアップのみ実行されます。

---

## クイックスタート

```bash
# 1. Worker
cd worker && cp wrangler.toml.template wrangler.toml && pnpm install && pnpm deploy

# 2. アグリゲーター (VPS)
cd aggregator && cp config.example.json config.json   # アカウント: protocol auto/imap/pop3
pip install -e .                                      # supervisord が 5 分ループを実行（deploy/README.md 参照）

# 3. フロントエンド
cd frontend && cp .env.example .env.local   # VITE_API_BASE=https://<worker-domain>
pnpm install && pnpm dev
```

全変数は `worker/wrangler.toml.template` と `aggregator/config.example.json` を参照してください。

### 送信の冪等性と未知の配送状態

`POST /api/send_mail`、`POST /external/api/send_mail`、`POST /admin/send_mail` は `x-idempotency-key` を受け付けます。リクエストが 503 を返した場合（Worker がタイムアウトする前にプロバイダがメッセージを受け入れている可能性がある）、**同じキーで再試行**してください。同じリクエストなら再生安全、異なるリクエストなら 409 を返します。未知の配送は管理者が解決するまでクォータと送信者残高を予約したまま保持します:

- 一覧: `GET /admin/send_mail/unknown`
- 解決: `POST /admin/send_mail/unknown/:id/resolve`、ボディは `{"outcome":"sent"}` または `{"outcome":"rejected"}`

既存の D1 データベースをアップグレードする前にバックアップを取り、`db/2026-09-09-send-mail-delivery-state.sql` を一度だけ実行してください（例: `cd worker && wrangler d1 execute <database> --remote --file=../db/2026-09-09-send-mail-delivery-state.sql`）。

## ドキュメント & 変更履歴

- `CHANGELOG.md`（中文） / `CHANGELOG_EN.md`（English） — バージョン履歴
- `docs/` — one-mail の設計・受け入れノート（前後端分離、アグリゲーター）
- `vitepress-docs/` — 一時メール機能ドキュメント（付録）

## ライセンス

[MIT](LICENSE)
