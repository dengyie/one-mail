<!-- markdownlint-disable-file MD033 MD045 -->
# One-Mail — 新一代 AI 原生统一收件箱以及边缘邮件中枢

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
  <b>把频繁在多个邮箱之间切换以及翻找验证码的繁琐流程予以终结。</b><br>
  能够把 QQ、网易 163、Gmail、Outlook 以及企业私有邮箱等各个账户，汇聚到全球毫秒响应的 Cloudflare 边缘网络当中。<br>
  集成了秒级验证码提取胶囊、AI 智能邮件要点速览、Passkey 生物免密登录以及全功能临时与私有域名邮箱管理功能。
</p>

<p align="center">
  <a href="#核心特性">核心特性</a> •
  <a href="#系统架构全景">系统架构</a> •
  <a href="#方案对比优势">对比优势</a> •
  <a href="#快速开始">快速部署</a> •
  <a href="#开放-api-与开发者生态">开放 API</a> •
  <a href="#开源协议">开源协议</a>
</p>

---

## 为什么需要 One-Mail？

在日常开发、多账号运维或者数字游民生活当中，往往需要同时管理数量较多的邮箱。传统的邮件客户端大多比较臃肿，容易面临网络限制，跨设备同步也偏慢，并且缺乏自动提取验证码的机制；商业托管服务则存在隐私层面的顾虑以及持续的订阅开销。

One-Mail 鉴于这些痛点从零开展自主设计与研发工作，并打磨至生产可用级别：
- **边缘 Serverless**：核心 API 依靠 Cloudflare Workers 以及 D1 边缘网络来运行，冷启动极快，全球延迟维持在 50ms 以内，日常运用当中几乎无需承担服务器与数据库费用。
- **隐私与安全管控**：支持自行部署，密码以及 Token 在落盘前都会在边缘借助 AES-GCM-256 算法开展加密处理，还可以运用 FIDO2 Passkeys 开展免密登录。
- **AI 智能赋能**：无需展开大段冗长内容，列表卡片就能够马上呈现验证码胶囊以及 AI 提取的核心摘要。

---

## 核心特性

| 模块 | 特性亮点 | 技术实现与优势 |
|---|---|---|
| **多源统一收件箱**<br>`Unified Inbox` | • 一站式聚合 QQ、163、Gmail、Outlook 以及自定义 IMAP<br>• 借助 IMAP IDLE 开展毫秒级实时收信推送，同时配有 60s 兜底轮询<br>• 具备协议自适应降级特性，要是 IMAP 鉴权受阻就自动降级为 POP3 并且进行锁定<br>• 依靠进程级并发锁 `redemption_lock` 防止 OAuth RT 发生竞争失效 | 依靠 Python 守护进程以及 Cloudflare D1 幂等上传去重，保障运行稳定并且防止漏信 |
| **秒级验证码胶囊**<br>`Instant OTP Capsule` | • 识别 4-8 位纯数字、`123-456` 连字符以及 `G-123456` 等前缀码<br>• 借助严格的负向预查排除公历年份像 19xx 与 20xx、日期以及金额的误判<br>• 列表卡片马上呈现高亮胶囊，一键即可开展快速复制，不用打开邮件全文 | 凭借高精度多语言正则引擎，误报率趋零，能够极大程度上节省时间 |
| **AI 邮件智能速览**<br>`AI Summarization` | • 智能提炼邮件核心意图以及关键待办行动项即 Action Items<br>• 开展发件人信誉评估以及纯文本清洗工作<br>• 配备客户端 FIFO 与 LRU 缓存，上限为 50 条，多次切换可以马上开启 | 前端与边缘双重优化，切换流畅，同时保护接口调用额度 |
| **Passkey 生物免密认证**<br>`WebAuthn / Passkeys` | • 支持 Apple Touch ID、Face ID、Windows Hello 以及 YubiKey<br>• 告别传统复杂密码与跨设备记密负担<br>• 依靠设备指纹自动对凭证进行命名，提供流畅的降级兼容体验 | 选用 SimpleWebAuthn v13，契合 FIDO2 标准，有效抵御网络钓鱼 |
| **零信任凭据保险库**<br>`Credential Vault` | • 外部邮箱授权码以及 OAuth 凭据全流程开展对称加密<br>• 密钥隔离保存在 Worker 环境变量当中，库与日志均不包含明文<br>• 提供细粒度 API Key 体系，涵盖 `readonly` 与 `admin` 角色以及白名单 | 运用 WebCrypto 原生 AES-GCM-256 加密体系 |
| **现代化美学界面**<br>`Awesome UI & UX` | • 选用 Vue 3、Tailwind CSS 以及 Naive UI 构建毛玻璃质感界面<br>• 适配 `<keep-alive>` 视图：后台标签页会自动把定时器暂停，避免 D1 读配额消耗<br>• 支持多语言深链接，能把搜索关键字与分页状态完整记录下来<br>• 完整支持暗黑与明亮模式自适应，适宜手机、平板与桌面端 | 经过性能调优，避免不必要的重绘以及内存堆积 |
| **全功能邮件中枢基座**<br>`Temp & Domain Mail` | • 临时邮箱：依靠 Cloudflare Email Routing 驱动，即用即抛，支持自定义前缀<br>• 私有域名管理：支持把私有域名绑定进来开展管理，实现多租户隔离与虚拟别名收信<br>• 发信中枢：支持 Resend、SMTP 以及 CF，凭借 `x-idempotency-key` 保证幂等防重 | 借助 Rust WASM 实现高效邮件流解析，并拥有异常状态调解机制 |

---

## 系统架构全景

```text
  外部邮箱生态
  ┌───────────────┐ ┌───────────────┐ ┌────────────────┐ ┌────────────────┐
  │  QQ / 163 邮箱 │ │ Gmail (OAuth) │ │ Outlook / 365  │ │ 自建 IMAP/POP3  │
  └───────┬───────┘ └───────┬───────┘ └────────┬───────┘ └────────┬───────┘
          │                 │                  │                  │
          └─────────────────┴────────┬─────────┴──────────────────┘
                                     │ (IMAP IDLE 实时推送 / 60s 兜底轮询)
                                     ▼
                      ┌──────────────────────────────┐
                      │    VPS Python 聚合器守护进程  │
                      │         aggregator/          │
                      │ ──────────────────────────── │
                      │ • IMAP 协议优先，POP3 智能降级 │
                      │ • 运用兑换锁防止 RT 竞态失效   │
                      │ • 单封 30MB 截断以防 OOM     │
                      │ • 水印标记结合 D1 实现幂等     │
                      └──────────────┬───────────────┘
                                     │ (HTTPS REST API / x-admin-auth)
                                     ▼
        ┌────────────────────────────────────────────────────────────┐
        │        Cloudflare Edge Serverless 核心 worker/             │
        │ ────────────────────────────────────────────────────────── │
        │ • 运用 Hono v4 作为 API 路由引擎                           │
        │ • 借助 SimpleWebAuthn 开展 Passkeys 生物认证                │
        │ • 依托 AES-GCM-256 开展外部凭据加密与解密工作              │
        │ • 选用 Rust WASM 邮件解析器 mail-parser-wasm               │
        │ • 借助 Cloudflare D1、KV 以及 Email Routing 开展数据管理    │
        │ • 定期对超过 90 天的已读邮件开展清理                       │
        └────────────────────────────┬───────────────────────────────┘
                                     │ (JSON / Bearer Token / API Key)
                                     ▼
        ┌────────────────────────────────────────────────────────────┐
        │        现代化前后端分离 Web 前端 frontend/                 │
        │ ────────────────────────────────────────────────────────── │
        │ • 选用 Vue 3、Vite、Tailwind CSS 与 Naive UI 呈现现代界面  │
        │ • 验证码智能高亮胶囊，支持一键马上复制                     │
        │ • AI 邮件重点提炼，借助 LRU 缓存开展加速                   │
        │ • 具备 keep-alive 状态感知，后台自动把轮询挂起以节省额度   │
        │ • 完善的多语言深层路由记忆，契合国际化访问需求             │
        └────────────────────────────────────────────────────────────┘
```

---

## 方案对比优势

| 评估维度 | One-Mail | 传统客户端，像 Foxmail 与 Thunderbird | 商业托管服务，像 Spark 与 Missive |
|---|:---:|:---:|:---:|
| **部署与运行成本** | **0 元 Serverless**，免费配额适宜日常运转 | 需要依靠本地客户端常驻 | 往往需要按月支付席位费用 |
| **设备间实时同步** | **云端全自动聚合**，打开网页便可浏览全量数据 | 需在各设备分别配置，无法同步规则 | 依赖第三方商业云端中转 |
| **数据与隐私主权** | **由用户自主掌控**，边缘对称加密 | 存储于本地磁盘，存在明文风险 | 邮件数据会上载至服务商服务器 |
| **免密登录体验** | **原生 Passkey 与 WebAuthn 指纹及人脸认证** | 仅支持传统主密码 | 依靠账号密码或外部账号绑定 |
| **验证码快速提取** | **卡片直出 OTP 胶囊，马上复制** | 需要翻找邮件长文正文 | 仅能提供普通的文字预览 |
| **AI 邮件要点提炼** | **内置智能解析并搭配本地 LRU 缓存** | 无此功能或需额外插件 | 需付费开通高级订阅套餐 |
| **临时与域名邮箱** | **内置完整的 Temp Mail 与私有域名管理中枢** | 不具备此类功能 | 不具备此类功能 |
| **防护与容灾能力** | **具备 POP3 降级与防烧卡锁定机制** | 客户端易因频繁刷新面临限制 | 容易受到外部服务策略调整的影响 |

---

## 快速开始

本项目选用前后端分离架构，主要由三个部分构成：**Cloudflare Worker API**、**前端静态单页应用** 以及 **VPS 聚合器守护进程**。

### 1. 部署 Cloudflare Worker

> 确保本地环境中安装了 Node.js 20+ 以及 pnpm。

```bash
# 1. 获取代码仓库
git clone https://github.com/dengyie/one-mail.git
cd one-mail/worker

# 2. 安装依赖包
pnpm install

# 3. 进行 wrangler.toml 的配置
cp wrangler.toml.template wrangler.toml
# 编辑 wrangler.toml，填入 D1 数据库 ID、KV 空间 ID 以及加密密钥 MAIL_CRED_ENCRYPTION_KEY

# 4. 执行数据库初始化与迁移
pnpm wrangler d1 migrations apply DB --remote

# 5. 发布部署到边缘网络
pnpm deploy
```

完成部署以后，即可获取对应的 Worker 边缘 API 域名。

---

### 2. 配置并运行 VPS 聚合器

聚合器基于 Python 3 标准库构建，不依赖繁重的第三方 C 扩展，内存占用处于 50MB 以内。

```bash
cd ../aggregator

# 1. 复制并编辑配置文件
cp config.example.json config.json
# 编辑 config.json：配置各邮箱协议、授权凭证以及 Worker 接口地址与对应密钥

# 2. 进行可执行环境的安装
pip install -e .

# 3. 建议借助 Supervisord 开展常驻进程管理
# 配置参考 deploy/supervisor.conf
# 聚合器会自动开启 IMAP IDLE 实时监听，并在 60s 内对其它邮箱开展增量轮询
```

---

### 3. 构建与部署 Web 前端

前端属于轻量化的 Vue 3 单页应用，适宜托管在 Cloudflare Pages、Nginx 或各类静态服务器当中。

```bash
cd ../frontend

# 1. 安装项目依赖
pnpm install

# 2. 对环境变量进行配置
cp .env.example .env.local
# 编辑 .env.local，把 VITE_API_BASE 指定为 Worker 对应的接口域名

# 3. 开启开发预览
pnpm dev

# 4. 执行生产打包
pnpm build
# 产物输出在 dist/ 目录，可直接交由 Nginx 进行托管
```

#### Nginx 生产环境配置示例

```nginx
server {
    listen 80;
    server_name inbox.yourdomain.com;

    root /www/one-mail/dist;
    index index.html;

    # 单页应用路由兜底
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 静态资源缓存配置
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|wasm)$ {
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }
}
```

---

## 开放 API 与开发者生态

One-Mail 提供了清晰的 RESTful API，方便与自动化脚本、机器人或者持续集成流程开展对接。

### 鉴权方式

- **统一收件箱查询接口**：在请求头中携带 `Authorization: Bearer <api-key>`
- **管理与状态同步接口**：在请求头中携带 `x-admin-auth: <ADMIN_PASSWORD>`

### 核心接口概览

```http
# 1. 统一收件箱分页与关键词搜索
GET /api/unified/emails?source=qq&account=user@qq.com&limit=20&offset=0&q=github

# 2. 统计未读以及总邮件数量
GET /api/unified/count?unread=1

# 3. 提取指定地址最新的有效验证码
GET /api/unified/verifcodes?addr=myaccount@163.com&fresh=1

# 4. 把单封邮件标记为已读
POST /api/unified/emails/:id/read

# 5. 聚合器批量推送并摄入邮件
POST /admin/unified/ingest

# 6. 发送邮件并附加防重 Key
POST /api/send_mail
x-idempotency-key: 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d
```

---

## 技术栈清单

- **边缘计算后端**: Cloudflare Workers, Hono v4, Cloudflare D1, Cloudflare KV, SimpleWebAuthn
- **前端生态**: Vue 3.5, Vite 7, Tailwind CSS v4, Naive UI, Lucide Icons, Marked, DOMPurify
- **同步引擎**: Python 3.10+, 标准库 `imaplib` 与 `poplib`, Microsoft Graph API 以及 Google OAuth 2.0
- **底层解析组件**: Rust WASM 即 `mail-parser-wasm`, Postal-Mime
- **工程化与质量保障**: Vitest, Playwright, ESLint 9, GitHub Actions CI/CD 流水线

---

## 多语言支持

已对以下语言环境开展了完整的适配工作：
- 简体中文 (`zh`)
- English (`en`)
- 日本語 (`ja`)
- Español (`es`)
- Português (`pt-BR`)
- Deutsch (`de`)

---

## 参与贡献

欢迎通过提交 Issue 与 Pull Request 的方式共同参与完善 One-Mail。若该项目在多邮箱管理方面带来了一定帮助，欢迎在代码仓库右上角点亮 Star 给予支持。

---

## 开源协议

本项目基于 [MIT 许可证](LICENSE) 开展开源授权。可以在保留原作者版权声明的前提下自由运用于个人或者商业项目当中。
