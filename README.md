<!-- markdownlint-disable-file MD033 MD045 -->
# one-mail — 统一收件箱系统

<p align="center">
  <a href="README.md"><img alt="中文" src="https://img.shields.io/badge/README-中文-blue"></a>
  <a href="README_EN.md"><img alt="English" src="https://img.shields.io/badge/README-English-blue"></a>
  <a href="README_JA.md"><img alt="日本語" src="https://img.shields.io/badge/README-日本語-blue"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

> **统一收件箱**：把分散在多个邮箱（QQ / 163 / Gmail / Outlook…）的邮件，经 **VPS 聚合器** 定时拉取汇聚到 Cloudflare Worker 的统一 API，再在前端集中查看验证码、登录确认等关键邮件。

本项目基于 [dreamhunter2333/cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email) fork，保留原项目的临时邮箱基座（Cloudflare Email Routing + Worker 收信 + Vue 前端），在这之上新增一套 **one-mail 统一收件箱**能力。

> 当前外部邮箱能力以**单向收件聚合**为主；已读回写、删除/归档/移动、外部账号身份发信、线程和完整附件能力仍在演进中。目标架构、分阶段计划与验收标准见 [统一邮箱开发设计](vitepress-docs/docs/zh/guide/feature/unified-mailbox-development.md)。

---

## 架构

```
邮箱服务 (IMAP/POP3)
   QQ / 163 / Gmail / Outlook ...
        │  (VPS 聚合器轮询拉取)
        ▼
VPS Python 聚合器  aggregator/
   │  IMAP 协议优选，POP3 兜底降级
   │  BATCH_SIZE / BATCH_BYTES 批量收敛，超大附件跳过防 OOM
   ▼
Cloudflare Worker ──mail-api.mangoqwq.cc.cd──> API (worker/)
   │  ├─ /api/unified/*       统一收件箱查询（API-key 鉴权）
   │  ├─ /admin/unified/*     统一收件箱管理/ingest（admin 鉴权）
   │  └─ /api/* ·/user_api/* ·/admin/*  临时邮箱基座（上游能力）
   ▼
前端（frontend/）  —  VITE_API_BASE 直连 Worker，前后端分离
```

### 组件

| 组件 | 技术栈 | 说明 |
|---|---|---|
| `worker/` | TypeScript + Hono · Cloudflare Workers · D1 | 统一收件箱 API + 临时邮箱基座（Email Routing 实时收信） |
| `aggregator/` | Python 3 · stdlib `imaplib`/`poplib` | VPS 侧拉取器：IMAP 首选，POP3 自动降级，稳定水印幂等同步 |
| `frontend/` | Vue 3 + Naive UI | 邮箱管理界面，直连 Worker（前后端分离） |
| `pages/` | 纯静态托管壳 | 可选静态托管模板（无 Functions，代理拓扑已删除） |
| `db/` | D1 SQLite | unified schema（emails / mail_accounts / api_keys）+ 分片迁移 |
| `mail-parser-wasm/` | Rust WASM | 邮件解析（上游基座） |
| `smtp_proxy_server/` | Python | SMTP 发送 / IMAP 查看代理（上游基座，本地开发用） |

---

## 统一收件箱

### 鉴权

统一收件箱是聚合侧 API，**不使用**临时邮箱基座的 JWT，而是独立的两套头：

| 范围 | Header | 来源 |
|---|---|---|
| `/api/unified/*`（查询） | `Authorization: Bearer <api-key>` | `/admin/unified/keys` 下发的 API key |
| `/admin/unified/*`（管理） | `x-admin-auth` | `ADMIN_PASSWORDS[0]` |

API key 支持 **readonly / admin** 两种角色，可绑定 `allowed_sources`（QQ/163/...）与 `allowed_accounts` 白名单，跨源/越权一律 403。

### 主要接口

| 接口 | 说明 |
|---|---|
| `GET /api/unified/emails?source=&account=&limit=&offset=&q=` | 统一收件箱翻页查询；`q=` 全文关键词搜索 |
| `GET /api/unified/count?source=&unread=` | 邮件计数（含未读过滤） |
| `GET /api/unified/verifcodes?addr=&fresh=` | 验证码提取（内置验证码识别纯函数） |
| `GET /api/unified/emails/:id` | 单封邮件详情 |
| `POST /api/unified/emails/:id/read` | 标记已读（admin） |
| `POST /admin/unified/ingest` | 聚合器上传入口（`imap_uid` 幂等去重） |
| `POST /admin/unified/keys` | 创建 API key（明文仅返回一次） |
| `GET /admin/unified/mail_accounts` | 聚合器拉取启用中的用户邮箱并解密凭据（`x-admin-auth`） |
| `POST /admin/unified/mail_accounts/:id/status` | 聚合器回写同步状态 / `last_error`（`x-admin-auth`） |

### 聚合器（aggregator/）

- **协议自适应**：默认 `protocol: auto` —— 先尝试 IMAP，服务端 `Unsafe Login` 等拒绝时自动降级 POP3（实测 163）；降级成功后**钉住**（`state.fallback`），避免 IMAP/POP3 双写重复行。
- **批量收敛**：滚动窗口按 `BATCH_SIZE`（默认 200）或 `BATCH_BYTES`（64 MiB）预算截断，`last_uid` 持续推进，大收件箱多轮收敛完成。
- **防 OOM**：单封超 `MAX_SINGLE_BYTES`（30 MiB）跳过并推高水印，避免一封信打爆容器。
- **幂等**：`(uidvalidity, imap_uid)` 走 Worker partial unique index，重复上传安全。
- 运行：VPS 定时循环（`agg-loop.sh`），5 分钟一轮，**supervisord 托管**（pxed 无 systemd/cron），无需新依赖（stdlib）。

### 保留清理（D1）

`scheduled` 每次触发会分页删除 `is_read=1` 且 `received_at` 早于 90 天的邮件（D1 行）。R2 附件清理为预留逻辑（`retention.ts` 在配置了 `ATTACHMENTS` bucket 且行写入 `r2_key` 时才触发），当前生产未绑定 R2、聚合器亦不写 `r2_key`，故实际仅做 D1 清理。

---

## 快速开始

### 1. 部署 Worker

```bash
cd worker
cp wrangler.toml.template wrangler.toml     # 填 kv/d1/r2 binding 与 vars
pnpm install
pnpm deploy
# 绑定自定义域名（如 mail-api.mangoqwq.cc.cd）并配置 cron 触发
```

### 2. 配置聚合器（VPS）

```bash
cd aggregator
cp config.example.json config.json   # 填账号：protocol auto/imap/pop3 + 密码/OAuth
pip install -e .
# 定时循环：supervisord（见 deploy/README.md），每 5 分钟跑一轮
```

### 3. 前端

```bash
cd frontend
cp .env.example .env.local   # VITE_API_BASE=https://<你的worker域名>
pnpm install && pnpm dev     # dev 代理到 127.0.0.1:8787
```

### 4. 环境变量

详见 `worker/wrangler.toml.template`、`aggregator/config.example.json`（当前妥善管理）。

### 发信幂等与未知投递状态

`POST /api/send_mail`、`POST /external/api/send_mail` 和 `POST /admin/send_mail` 支持 `x-idempotency-key`。如果请求返回 503（外部服务可能已接受邮件但 Worker 超时），客户端必须使用同一个 key 重试；复用相同请求会得到已发送结果，使用不同请求会返回 409。未知状态不会自动释放额度或发信余额，需要管理员确认：

- 查询：`GET /admin/send_mail/unknown`
- 确认：`POST /admin/send_mail/unknown/:id/resolve`，body 为 `{"outcome":"sent"}` 或 `{"outcome":"rejected"}`

升级已有 D1 数据库前先备份，然后只执行一次 `db/2026-09-09-send-mail-delivery-state.sql`（例如 `cd worker && wrangler d1 execute <database> --remote --file=../db/2026-09-09-send-mail-delivery-state.sql`）。

---

## 文档 & 变更

- `CHANGELOG.md`（中文） / `CHANGELOG_EN.md`（English） — 版本变更
- `docs/` — one-mail 专项设计与验收（含前后端分离、聚合器设计）
- `vitepress-docs/` — 上游临时邮箱功能文档（附录）

## 许可证

[MIT](LICENSE)

远程临时邮箱基座能力来自上游 [cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email)；one-mail 统一收件箱为本仓库新增。