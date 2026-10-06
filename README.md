<!-- markdownlint-disable-file MD033 MD045 -->
# 📮 One-Mail — 新一代 AI 原生统一收件箱与边缘邮件中枢

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
  <b>终结多邮箱频繁切号与验证码翻找的时代！</b><br>
  将 QQ、网易 163、Gmail、Outlook、企业私有邮箱等所有账户，汇聚至全球毫秒响应的 Cloudflare 边缘网络。<br>
  集成 <b>秒级验证码提取胶囊</b>、<b>AI 智能邮件要点速览</b>、<b>Passkey 生物免密登录</b> 与 <b>全功能临时/私有域名邮箱</b>。
</p>

<p align="center">
  <a href="#-核心特性">✨ 核心特性</a> •
  <a href="#-系统架构全景">📐 系统架构</a> •
  <a href="#-为什么选择-one-mail">📊 对比优势</a> •
  <a href="#-快速开始">🚀 快速部署</a> •
  <a href="#-开放-api-与开发者生态">🔌 开放 API</a> •
  <a href="#-开源协议">📄 开源协议</a>
</p>

---

## 🌟 为什么需要 One-Mail？

在日常开发、多账号运维或数字游民生活中，每个人往往同时持有数十个邮箱（QQ、163、多账号 Gmail、Outlook、各类工作邮箱与测试临时邮箱）。
传统的邮件客户端笨重臃肿、容易封 IP、多设备同步慢，且无法自动化提取验证码；商业聚合托管服务又面临严重的隐私泄漏与高昂订阅费风险。

**One-Mail** 应运而生 —— 它是团队**从零自主设计并打磨至生产级**的现代邮件解决方案：
- **边缘 Serverless**：核心 API 运行在 Cloudflare Workers + D1 边缘网络，超快冷启动，全球延迟 < 50ms，日常使用 **0 服务器与数据库成本**。
- **极致隐私与安全**：用户私有部署，密码与 Token 均落盘前在边缘由 AES-GCM-256 加密，支持 FIDO2 Passkeys 免密登录。
- **AI 智能赋能**：无需展开数百行营销冗余，卡片即显核心验证码胶囊与 AI 重点摘要。

---

## ✨ 核心特性

| 模块 | 特性亮点 | 技术实现与优势 |
|---|---|---|
| 📬 **多源统一收件箱**<br>`Unified Inbox` | • 一站式聚合 QQ / 163 / Gmail / Outlook / 自定义 IMAP<br>• **IMAP IDLE 毫秒级实时收信推送** + 60s 稳健兜底轮询<br>• 智能协议自适应降级（IMAP 鉴权受阻自动降级 POP3 并锁定）<br>• 进程级并发锁（`redemption_lock`）防止 OAuth RT 竞争失效 | Python 守护进程 + Cloudflare D1 幂等上传去重，稳定运行无漏信 |
| ⚡ **秒级验证码胶囊**<br>`Instant OTP Capsule` | • 识别 4-8 位纯数字、`123-456` 连字符、`G-123456` 等前缀码<br>• 严格负向预查排除公历年份（19xx/20xx）、日期与金额误判<br>• 列表卡片直出高亮胶囊，**一键秒级复制**无需打开邮件全文 | 高精度多语言正则引擎，误报率趋零，效率提升 90% |
| 🤖 **AI-Native 邮件速览**<br>`AI Summarization` | • 智能提炼邮件核心意图、关键待办行动项（Action Items）<br>• 发件人信誉评估与纯文本结构化清洗<br>• 客户端 FIFO/LRU 缓存（上限 50 条），列表无缝复用零内存泄漏 | 纯前端与边缘双重加速，多次切换秒开，保护网络与 API 额度 |
| 🔐 **Passkey 生物免密认证**<br>`WebAuthn / Passkeys` | • 支持 Apple Touch ID / Face ID、Windows Hello、YubiKey<br>• 告别传统复杂密码与跨设备记密负担<br>• 自动提取设备指纹命名凭证，提供流畅降级兼容体验 | SimpleWebAuthn v13 + FIDO2 官方标准，防网络钓鱼攻击 |
| 🛡️ **零信任凭据保险库**<br>`Credential Vault` | • 外部邮箱第三方授权码与 OAuth 凭证全流程对称加密<br>• 密钥隔离保存在 Worker 环境变量，任何静态库与日志均无明文<br>• 细粒度 API Key 体系（`readonly` / `admin` 角色与邮箱源白名单） | WebCrypto 原生 AES-GCM-256 加密体系 |
| 🎨 **现代化美学界面**<br>`Awesome UI & UX` | • Vue 3 + Tailwind CSS + Naive UI 毛玻璃质感交互<br>• 深度适配 `<keep-alive>` 视图：**后台标签页自动休眠定时器**，彻底杜绝 D1 读配额偷跑<br>• 多语言深链接（保存搜索关键字与分页游标，一键无损返回）<br>• 完整暗黑/明亮模式自适应，支持手机、平板与桌面端 | 性能极致调优，无任何无用重绘与 DOM 内存积压 |
| 🧰 **全功能邮件中枢基座**<br>`Temp & Domain Mail` | • **临时临时邮箱**：Cloudflare Email Routing 驱动，即用即抛，支持自定义前缀<br>• **私有域名管理**：无限绑定私有域名，多租户隔离与虚拟别名收信<br>• **发信中枢 (Send Mail)**：支持 Resend/SMTP/CF，具备 `x-idempotency-key` 幂等防重保障 | Rust WASM 邮件流高效解析，提供投递异常仲裁机制 |

---

## 📐 系统架构全景

```text
  外部邮箱生态 (External Providers)
  ┌───────────────┐ ┌───────────────┐ ┌────────────────┐ ┌────────────────┐
  │  QQ / 163 邮箱 │ │ Gmail (OAuth) │ │ Outlook / 365  │ │ 自建 IMAP/POP3  │
  └───────┬───────┘ └───────┬───────┘ └────────┬───────┘ └────────┬───────┘
          │                 │                  │                  │
          └─────────────────┴────────┬─────────┴──────────────────┘
                                     │ (IMAP IDLE 实时推送 / 60s 兜底轮询)
                                     ▼
                      ┌──────────────────────────────┐
                      │    VPS Python 聚合器守护进程  │
                      │         (aggregator/)        │
                      │ ──────────────────────────── │
                      │ • IMAP 协议优先，POP3 智能降级 │
                      │ • OAuth 兑换锁防止 RT 竞态烧卡 │
                      │ • 单封 30MB 预算截断防 OOM    │
                      │ • 水印标记 + D1 Partial 幂等 │
                      └──────────────┬───────────────┘
                                     │ (HTTPS REST API / x-admin-auth)
                                     ▼
        ┌────────────────────────────────────────────────────────────┐
        │        Cloudflare Edge Serverless 核心 (worker/)           │
        │ ────────────────────────────────────────────────────────── │
        │ • Hono v4 现代轻量级 API 路由引擎                           │
        │ • SimpleWebAuthn Passkeys 生物认证 (FIDO2)                 │
        │ • AES-GCM-256 外部凭据安全加密 / 解密中枢                   │
        │ • Rust WASM 高性能邮件解析器 (mail-parser-wasm)            │
        │ • Cloudflare D1 (分片 SQLite) + KV 缓存 + Email Routing     │
        │ • 90 天已读邮件生命周期智能巡检与空间清理                   │
        └────────────────────────────┬───────────────────────────────┘
                                     │ (JSON / Bearer Token / API Key)
                                     ▼
        ┌────────────────────────────────────────────────────────────┐
        │        现代化前后端分离 Web 前端 (frontend/)               │
        │ ────────────────────────────────────────────────────────── │
        │ • Vue 3 + Vite + Tailwind CSS + Naive UI 毛玻璃现代 UI      │
        │ • 验证码高精度智能高亮提取胶囊 (一键复制)                   │
        │ • AI 邮件重点提炼与 LRU 缓存加速引擎                       │
        │ • keep-alive 组件生命周期感知 (后台自动挂起轮询省配额)      │
        │ • 多语言深度路由记忆 (支持 zh / en / ja / es / pt-BR / de) │
        └────────────────────────────────────────────────────────────┘
```

---

## 📊 为什么选择 One-Mail？

| 评估维度 | One-Mail | 传统客户端 (Foxmail/Thunderbird) | 商业托管服务 (Spark/Missive) |
|---|:---:|:---:|:---:|
| **部署与运行成本** | **0 元 Serverless**（免费额度足充日常） | 需本地客户端常驻 | 高昂按月席位订阅费 |
| **设备间实时同步** | **云端全自动聚合**，打开网页即全量数据 | 需各设备配置，不同步邮件与规则 | 依赖其商业云端中转 |
| **数据与隐私主权** | **100% 掌握在自己手中**，边缘对称加密 | 存储于本地磁盘（明文风险） | 邮件数据上传至商业服务商云服务器 |
| **免密登录体验** | **原生 Passkey / WebAuthn (指纹/人脸)** | 仅支持传统主密码 | 账号密码或 Google 登录绑定 |
| **验证码快速提取** | **卡片直出 OTP 胶囊，1 秒复制** | 需翻找邮件长文正文 | 仅提供常规预览 |
| **AI 邮件要点提炼** | **内置智能解析 + 本地极速 LRU 缓存** | 无 / 需自费插件 | 需付费购买高级 AI 订阅套餐 |
| **临时与域名邮箱** | **内置完整 Temp Mail 与私有域名中枢** | 无此能力 | 无此能力 |
| **抗封禁与容灾** | **智能 POP3 降级与单进程防烧卡机制** | 客户端容易因频繁刷新被反爬封锁 | 易受第三方服务商策略变更影响 |

---

## 🚀 快速开始

本项目采用现代化前后端分离架构，核心分为三个组件：**Cloudflare Worker API**、**前端静态单页应用** 与 **VPS 聚合器守护进程**。

### 1. 部署 Cloudflare Worker（后端核心）

> 确保本地已安装 Node.js 20+ 以及 pnpm。

```bash
# 1. 克隆代码仓库
git clone https://github.com/dengyie/one-mail.git
cd one-mail/worker

# 2. 安装依赖
pnpm install

# 3. 配置 wrangler.toml
cp wrangler.toml.template wrangler.toml
# 编辑 wrangler.toml，填入你的 Cloudflare 账户 D1 数据库 ID、KV 空间 ID 与凭据加密密钥 MAIL_CRED_ENCRYPTION_KEY

# 4. 执行数据库初始化迁移
pnpm wrangler d1 migrations apply DB --remote

# 5. 一键发布部署到全球边缘网络
pnpm deploy
```

部署完成后，你将获得一个 Worker 边缘 API 域名（例如 `https://mail-api.yourdomain.com`）。

---

### 2. 配置与运行 VPS 聚合器（多邮箱同步中枢）

聚合器基于纯 Python 3 原生标准库实现，无重型第三方 C 依赖，超低内存占用（< 50MB）。

```bash
cd ../aggregator

# 1. 拷贝并配置账号信息
cp config.example.json config.json
# 编辑 config.json：配置各邮箱协议（auto / imap / pop3）、授权码及 Worker API 地址与密钥

# 2. 本地可执行环境安装
pip install -e .

# 3. 推荐使用 Supervisord 守护进程常驻运行
# 配置文件示例参考 deploy/supervisor.conf
# 聚合器会自动启动 IMAP IDLE 实时监听，并在 60s 内对非 IDLE 邮箱进行安全增量轮询
```

---

### 3. 构建与部署前端（Web 界面）

前端是轻量高效的 Vue 3 单页应用，可部署在任何静态服务器（Cloudflare Pages、Nginx、Vercel 等）。

```bash
cd ../frontend

# 1. 安装前端依赖
pnpm install

# 2. 配置环境变量
cp .env.example .env.local
# 编辑 .env.local，配置 VITE_API_BASE=https://mail-api.yourdomain.com

# 3. 开发预览
pnpm dev

# 4. 生产打包构建
pnpm build
# 构建输出位于 dist/ 目录，直接托管至 Nginx 或发布到 Cloudflare Pages 即可
```

#### Nginx 生产环境配置参考

```nginx
server {
    listen 80;
    server_name inbox.yourdomain.com;

    root /www/one-mail/dist;
    index index.html;

    # 单页应用前端路由兜底
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 静态资源强缓存
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|wasm)$ {
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }
}
```

---

## 🔌 开放 API 与开发者生态

One-Mail 提供了清晰完备的 RESTful API，方便与个人脚本、Telegram Bot、自动化 CI/CD 或第三方工作流联动。

### 鉴权机制

- **统一收件箱查询**：请求头携带 `Authorization: Bearer <api-key>`
- **管理与状态上报**：请求头携带 `x-admin-auth: <ADMIN_PASSWORD>`

### 核心接口速览

```http
# 1. 统一收件箱分页与全文搜索
GET /api/unified/emails?source=qq&account=user@qq.com&limit=20&offset=0&q=github

# 2. 统计未读与总邮件数
GET /api/unified/count?unread=1

# 3. 秒级提取指定地址的最新有效验证码
GET /api/unified/verifcodes?addr=myaccount@163.com&fresh=1

# 4. 标记单封邮件为已读
POST /api/unified/emails/:id/read

# 5. 聚合器批量推送摄入邮件（内置 UID 幂等）
POST /admin/unified/ingest

# 6. 发信并附带幂等防重 Key
POST /api/send_mail
x-idempotency-key: 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d
```

---

## 🛠️ 技术栈清单

- **边缘计算 (Backend Edge)**: Cloudflare Workers, Hono v4, Cloudflare D1 (SQLite), Cloudflare KV, SimpleWebAuthn
- **前端生态 (Frontend)**: Vue 3.5, Vite 7, Tailwind CSS v4, Naive UI, Lucide Icons, Marked, DOMPurify
- **同步引擎 (Aggregator)**: Python 3.10+, stdlib `imaplib`/`poplib`, Microsoft Graph API / Google OAuth 2.0
- **底层解析 (Parser)**: Rust WASM (`mail-parser-wasm`), Postal-Mime
- **工程化与自动化 (DevOps & QA)**: Vitest, Playwright, ESLint 9, GitHub Actions CI/CD Pipeline

---

## 🌍 多语言支持 (i18n)

One-Mail 深度支持全球多语言无缝切换：
- 🇨🇳 简体中文 (`zh`)
- 🇺🇸 English (`en`)
- 🇯🇵 日本語 (`ja`)
- 🇪🇸 Español (`es`)
- 🇧🇷 Português (`pt-BR`)
- 🇩🇪 Deutsch (`de`)

---

## 🤝 贡献与反馈

非常欢迎提交 Issue 与 Pull Request 共同建设 One-Mail！
- 提交 Bug 或功能建议前，请先查阅已有 [Issues](https://github.com/dengyie/one-mail/issues)。
- 如果 One-Mail 帮您解决了多邮箱管理痛点，欢迎点亮右上角的 **Star ⭐️** 支持我们！

---

## 📄 开源协议

本项目基于 [MIT 许可证](LICENSE) 开源。
您可以自由用于个人或商业项目，但请保留原作者的版权声明与许可声明。
