<!-- markdownlint-disable-file MD033 MD045 -->
# One-Mail — 次世代 AI ネイティブ統合受信トレイ＆エッジサーバーレス・メールハブ

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
  <b>複数メールアカウントの切り替えと認証コード探しの煩わしさに終止符を。</b><br>
  Gmail、Outlook、QQ、163、独自ドメインの IMAP/POP3 を世界規模の Cloudflare エッジネットワークに秒速集約。<br>
  <b>瞬時 OTP 認証コード抽出カプセル</b>、<b>AI メール要約</b>、<b>Passkey 生体パスワードレス認証</b>、<b>使い捨て/独自ドメインメール</b> を統合。
</p>

<p align="center">
  <a href="#主な機能">主な機能</a> •
  <a href="#システムアーキテクチャ">アーキテクチャ</a> •
  <a href="#one-mail-を選ぶ理由">比較・優位性</a> •
  <a href="#クイックスタート">クイックスタート</a> •
  <a href="#open-api--開発者エコシステム">開発者 API</a> •
  <a href="#ライセンス">ライセンス</a>
</p>

---

## なぜ One-Mail なのか？

エンジニア、インフラ管理者、デジタルノマドにとって、Gmail、Outlook、163、QQ、企業ドメインなど複数のメールボックスの管理は大きな負担です。従来のデスクトップクライアントは重く、IP制限を受けやすく、端末ごとの設定が必要で認証コードの自動抽出もできません。一方、商用アグリゲーションサービスはプライバシー流出リスクと高額な月額費用が伴います。

One-Mail は、これらの課題を根本から解決するためにゼロから開発された本番仕様のメールプラットフォームです：
- **完全エッジサーバーレス**：コア API は Cloudflare Workers + D1 上で動作。超高速コールドスタート、全世界レイテンシ 50ms 未満、日常利用での**サーバー＆DB 運用コストは実質 0 円**。
- **プライバシーとゼロトラスト**：自己ホスト型で完全なデータ主権を保持。外部メールのパスワードやトークンはエッジ上で AES-GCM-256 暗号化されて保存。Passkey によるパスワードレス生体認証に対応。
- **AI ネイティブな効率化**：長文のプロモーションメールを開く必要なく、メール一覧のカード上に認証コードカプセルと AI 要約が即座に表示されます。

---

## 主な機能

| モジュール | 機能ハイライト | 技術的優位性 |
|---|---|---|
| **マルチアカウント統合受信トレイ**<br>`Unified Inbox` | • Gmail / Outlook / QQ / 163 / 独自 IMAP をワンストップ集約<br>• **IMAP IDLE によるミリ秒レベルのリアルタイムプッシュ** + 60秒フォールバックポーリング<br>• プロトコル適応型フォールバック（IMAP エラー時に自動で POP3 に降格し固定）<br>• プロセス単位の `redemption_lock` により OAuth リフレッシュトークンの競合破損を防止 | 軽量 Python デーモン + Cloudflare D1 冪等同期による取りこぼしゼロの堅牢設計 |
| **瞬時 OTP 認証コードカプセル**<br>`Instant OTP Capsule` | • 4〜8桁の数字、`123-456` ハイフン形式、`G-123456` プレフィックスを自動識別<br>• 西暦年（19xx/20xx）、日付、金額を排除する高精度な誤検知防止フィルター<br>• メール一覧カード上にハイライト表示され、**ワンクリックで即座にコピー可能** | 高精度多言語正規表現エンジンで業務効率を 90% 向上 |
| **AI メール要約＆インサイト**<br>`AI Summarization` | • メールの主旨、重要アクション項目（Action Items）、送信者信頼度を自動抽出<br>• 構造化されたクリーンなテキスト要約<br>• クライアントサイド FIFO/LRU キャッシュ（最大50件）により高速タブ切り替えを実現 | エッジとフロントエンドの最適化により API コストとメモリリークを完全防止 |
| **Passkey 生体パスワードレス認証**<br>`WebAuthn / Passkeys` | • Apple Touch ID / Face ID、Windows Hello、YubiKey にネイティブ対応<br>• 複雑なマスターパスワードの管理から解放<br>• デバイス指紋による認証器の自動命名と安全なフォールバック | SimpleWebAuthn v13 + FIDO2 準拠、フィッシング詐欺を完全ブロック |
| **ゼロトラスト認証情報保管庫**<br>`Credential Vault` | • 外部メールの認証コードや OAuth トークンを暗号化保存<br>• 暗号鍵は Worker エッジ環境変数で厳重に保護<br>• 細粒度な API キー管理（`readonly` / `admin` ロール、送信元ホワイトリスト） | WebCrypto ネイティブ AES-GCM-256 暗号化 |
| **モダン・グラスモーフィズム UI**<br>`Awesome UI & UX` | • Vue 3 + Tailwind CSS + Naive UI による洗練されたデザイン<br>• `<keep-alive>` ライフサイクル最適化：非アクティブタブでタイマーを自動一時停止し D1 読み取りクォータを保護<br>• 多言語ディープリンク対応（検索条件やページ状態を保持したまま復帰可能）<br>• ダークモード＆ライトモード対応、スマホ・タブレット・PC に完全レスポンシブ | 描画負荷ゼロ、DOM メモリ増殖ゼロの徹底最適化 |
| **多機能メールハブ基盤**<br>`Temp & Domain Mail` | • 使い捨て一時メール：Cloudflare Email Routing 連携、即時エイリアス発行<br>• 独自ドメイン管理：マルチテナント分離と仮想アドレス受信<br>• 送信ハブ (Send Mail)：Resend/SMTP/CF 対応、`x-idempotency-key` による二重送信防止 | Rust WASM 高速 MIME 解析エンジンと配送ステータス調停 |

---

## システムアーキテクチャ

```text
  外部メールプロバイダ (External Providers)
  ┌───────────────┐ ┌───────────────┐ ┌────────────────┐ ┌────────────────┐
  │  QQ / 163 メール│ │ Gmail (OAuth) │ │ Outlook / 365  │ │ 独自 IMAP/POP3 │
  └───────┬───────┘ └───────┬───────┘ └────────┬───────┘ └────────┬───────┘
          │                 │                  │                  │
          └─────────────────┴────────┬─────────┴──────────────────┘
                                     │ (IMAP IDLE リアルタイムプッシュ / 60秒ポーリング)
                                     ▼
                      ┌──────────────────────────────┐
                      │    VPS Python アグリゲーター │
                      │         aggregator/          │
                      │ ──────────────────────────── │
                      │ • IMAP 優先、POP3 自動降格   │
                      │ • トークン競合防止ロック     │
                      │ • 30MB 予算制限で OOM 回避   │
                      │ • ウォーターマーク冪等アップ │
                      └──────────────┬───────────────┘
                                     │ (HTTPS REST API / x-admin-auth)
                                     ▼
        ┌────────────────────────────────────────────────────────────┐
        │       Cloudflare Edge サーバーレスコア (worker/)           │
        │ ────────────────────────────────────────────────────────── │
        │ • Hono v4 超軽量 REST API ルーティングエンジン              │
        │ • SimpleWebAuthn Passkeys 生体認証 (FIDO2)                 │
        │ • AES-GCM-256 外部認証情報暗号化保管庫                     │
        │ • Rust WASM 高性能 MIME メール解析器 (mail-parser-wasm)    │
        │ • Cloudflare D1 (分散 SQLite) + KV + Email Routing         │
        │ • 90日経過済み既読メールの自動保持期限クリーンアップ       │
        └────────────────────────────┬───────────────────────────────┘
                                     │ (JSON / Bearer Token / API Key)
                                     ▼
        ┌────────────────────────────────────────────────────────────┐
        │         モダン前後端分離 Web フロントエンド (frontend/)     │
        │ ────────────────────────────────────────────────────────── │
        │ • Vue 3 + Vite + Tailwind CSS + Naive UI グラスデザイン    │
        │ • 高精度 OTP 認証コード自動ハイライトカプセル (ワンタップ) │
        │ • AI メール要約＆クライアント LRU キャッシュ               │
        │ • keep-alive 対応（非表示タブでのポーリング休止で節約）    │
        │ • 多言語ディープリンク対応 (zh / en / ja / es / pt / de)   │
        └────────────────────────────────────────────────────────────┘
```

---

## One-Mail を選ぶ理由

| 評価項目 | One-Mail | 従来のデスクトップクライアント | 商用アグリゲーション SaaS |
|---|:---:|:---:|:---:|
| **運用コスト** | **0 円 サーバーレス**（無料枠で十分運用可能） | ローカル常駐が必要 | 高額な月額席料課金 |
| **リアルタイム同期** | **クラウド側で全自動集約**、ブラウザで即閲覧 | 端末ごとに設定が必要、ルール同期不可 | サービス専用クラウドに依存 |
| **プライバシーと主権** | **100% 自身が所有**、エッジ対称暗号化 | ローカルディスクに平文保存リスク | メールデータが第三者企業サーバーに保存 |
| **パスワードレス認証** | **ネイティブ Passkey / WebAuthn (指紋/顔認証)** | マスターパスワードのみ | パスワードまたは Google 連携のみ |
| **認証コード抽出** | **カード上に OTP カプセル直出し、1秒コピー** | メール本文を開いて探す必要あり | 単純なテキストプレビューのみ |
| **AI メール要約** | **標準搭載 AI 解析 + ローカル高速 LRU** | なし、または高価なプラグイン | 上位有料プランのみ提供 |
| **使い捨て＆独自ドメイン**| **Temp Mail と独自ドメインハブを標準統合** | 非対応 | 非対応 |
| **アカウント凍結対策** | **自動 POP3 降格＆トークン排他制御** | 頻繁なポーリングで制限を受けやすい | 外部ポリシー変更の影響を受けやすい |

---

## クイックスタート

本プロジェクトは現代的な前後端分離アーキテクチャを採用しており、**Cloudflare Worker API**、**Web フロントエンド**、**VPS アグリゲーター** の 3 つの要素で構成されます。

### 1. Cloudflare Worker（バックエンドコア）のデプロイ

> Node.js 20+ および pnpm がインストールされていることを確認してください。

```bash
# 1. リポジトリをクローン
git clone https://github.com/dengyie/one-mail.git
cd one-mail/worker

# 2. 依存関係のインストール
pnpm install

# 3. wrangler.toml の設定
cp wrangler.toml.template wrangler.toml
# wrangler.toml を編集し、D1 データベース ID、KV ID、および暗号化キー MAIL_CRED_ENCRYPTION_KEY を設定

# 4. データベースのマイグレーションを実行
pnpm wrangler d1 migrations apply DB --remote

# 5. Cloudflare エッジネットワークへ一括デプロイ
pnpm deploy
```

デプロイ完了後、Worker の API エンドポイント（例: `https://mail-api.yourdomain.com`）が発行されます。

---

### 2. VPS アグリゲーター（同期エンジン）の設定

アグリゲーターは Python 3.10+ の標準ライブラリのみで動作し、メモリ消費量は 50MB 未満です。

```bash
cd ../aggregator

# 1. 設定ファイルの作成
cp config.example.json config.json
# config.json を編集し、各メールアカウント情報（protocol: auto/imap/pop3）と Worker API の URL/Key を設定

# 2. パッケージのインストール
pip install -e .

# 3. Supervisord などを用いた常駐プロセスの起動（推奨）
# 設定例は deploy/supervisor.conf を参照してください
# IMAP IDLE リアルタイム受信と 60秒の安全な差分ポーリングが自動で開始されます
```

---

### 3. Web フロントエンドのビルド＆デプロイ

フロントエンドは軽量な Vue 3 SPA であり、Cloudflare Pages、Nginx、Docker、Vercel などに即座にデプロイ可能です。

```bash
cd ../frontend

# 1. 依存関係のインストール
pnpm install

# 2. 環境変数の設定
cp .env.example .env.local
# VITE_API_BASE=https://mail-api.yourdomain.com を指定

# 3. 開発プレビュー
pnpm dev

# 4. 本番用ビルド
pnpm build
# dist/ 配下に成果物が出力されます。Nginx や Cloudflare Pages にそのまま配置できます
```

#### Nginx 本番設定例

```nginx
server {
    listen 80;
    server_name inbox.yourdomain.com;

    root /www/one-mail/dist;
    index index.html;

    # SPA ルーティングフォールバック
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 静的アセットキャッシュ設定
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|wasm)$ {
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }
}
```

---

## Open API & 開発者エコシステム

外部スクリプト、Telegram Bot、CI/CD ワークフローと容易に連携可能な RESTful API を提供しています。

### 認証方式

- **統合受信トレイ照会**：`Authorization: Bearer <api-key>` ヘッダー
- **管理・データ送信**：`x-admin-auth: <ADMIN_PASSWORD>` ヘッダー

### 主要エンドポイント

```http
# 1. 統合受信トレイの一覧取得・キーワード検索
GET /api/unified/emails?source=gmail&limit=20&offset=0&q=invoice

# 2. 未読・総メール数の集計
GET /api/unified/count?unread=1

# 3. 指定アドレスの最新有効認証コードを瞬時抽出
GET /api/unified/verifcodes?addr=user@example.com&fresh=1

# 4. メールの既読化
POST /api/unified/emails/:id/read

# 5. アグリゲーターからのバッチメール取り込み（UID 冪等重複排除）
POST /admin/unified/ingest

# 6. 二重送信防止キー付きメール送信
POST /api/send_mail
x-idempotency-key: 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d
```

---

## 技術スタック

- **エッジバックエンド**: Cloudflare Workers, Hono v4, Cloudflare D1 (SQLite), Cloudflare KV, SimpleWebAuthn
- **フロントエンド**: Vue 3.5, Vite 7, Tailwind CSS v4, Naive UI, Lucide Icons, Marked, DOMPurify
- **同期デーモン**: Python 3.10+, stdlib `imaplib`/`poplib`, Microsoft Graph API / Google OAuth 2.0
- **メール解析器**: Rust WASM (`mail-parser-wasm`), Postal-Mime
- **テスト＆自動化**: Vitest, Playwright, ESLint 9, GitHub Actions CI/CD Pipeline

---

## 多言語対応 (i18n)

グローバルな言語切り替えに完全対応しています：
- 🇨🇳 简体中文 (`zh`)
- 🇺🇸 English (`en`)
- 🇯🇵 日本語 (`ja`)
- 🇪🇸 Español (`es`)
- 🇧🇷 Português (`pt-BR`)
- 🇩🇪 Deutsch (`de`)

---

## コントリビューション

Issue や Pull Request による改善提案を心より歓迎いたします！
- 新規提案の前に、既存の [Issues](https://github.com/dengyie/one-mail/issues) をご確認ください。
- One-Mail がお役に立ちましたら、ぜひリポジトリ右上の Star をお願いいたします。

---

## ライセンス

本プロジェクトは [MIT ライセンス](LICENSE) のもとでオープンソースとして公開されています。
個人利用・商用利用を問わず自由にご利用いただけます（著作権表示を保持してください）。
