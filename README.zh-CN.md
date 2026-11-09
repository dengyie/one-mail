<!-- markdownlint-disable-file MD033 MD045 -->
<div align="center">

# OneMail

**新一代 AI 原生统一收件箱、多邮箱智能聚合器与边缘 Serverless 邮件中枢**

[![License](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![Vue 3](https://img.shields.io/badge/Vue-3.5-4FC08D.svg?style=flat-square&logo=vue.js&logoColor=white)](https://vuejs.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020.svg?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-v4-E36002.svg?style=flat-square&logo=hono&logoColor=white)](https://hono.dev/)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-v4-38B2AC.svg?style=flat-square&logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
[![WebAuthn](https://img.shields.io/badge/WebAuthn-Passkeys-4285F4.svg?style=flat-square&logo=webauthn&logoColor=white)](https://webauthn.io/)
[![Community](https://img.shields.io/badge/Community-LINUX_DO-2563eb.svg?style=flat-square&logo=linux&logoColor=white)](https://linux.do/)
[![Tests](https://img.shields.io/badge/tests-100%25_passing-brightgreen.svg?style=flat-square)]()

[English](./README.md) · [简体中文](./README.zh-CN.md) · [日本語](./README_JA.md) · [核心特性](#核心特性) · [系统架构](#系统架构全景) · [方案对比](#方案对比优势) · [快速上手](#快速开始) · [开放 API](#开放-api-与开发者生态)

<br>

<p align="center">
  <b>彻底终结在多个邮箱客户端之间反复横跳、翻找验证码以及承担高昂商业订阅的日常困扰。</b><br>
  能够把 QQ、网易 163、Gmail、Outlook 以及企业私有邮箱等各个账户，汇聚到全球毫秒响应的 Cloudflare 边缘网络当中。<br>
  集成了秒级验证码提取胶囊、AI 智能邮件要点速览、FIDO2 Passkey 生物免密登录以及全功能临时与私有域名邮箱管理中枢。
</p>

</div>

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
  外部邮箱服务商 (External Mail Providers)
  ┌───────────────┐ ┌───────────────┐ ┌────────────────┐ ┌────────────────┐
  │  QQ / 网易163  │ │ Gmail (OAuth) │ │ Outlook / 365  │ │ 自定义 IMAP/POP│
  └───────┬───────┘ └───────┬───────┘ └────────┬───────┘ └────────┬───────┘
          │                 │                  │                  │
          └─────────────────┴────────┬─────────┴──────────────────┘
                                     │ (IMAP IDLE 实时推流 / 60s 兜底轮询)
                                     ▼
                      ┌──────────────────────────────┐
                      │     VPS Python 聚合器进程     │
                      │         aggregator/          │
                      │ ──────────────────────────── │
                      │ • IMAP 首选，POP3 智能降级   │
                      │ • OAuth 令牌锁防止 RT 竞争   │
                      │ • 30MB 拦截跳过防 OOM 崩溃   │
                      │ • 幂等游标记录同步状态       │
                      └──────────────┬───────────────┘
                                     │ (HTTPS 批量摄入 / x-admin-auth)
                                     ▼
        ┌────────────────────────────────────────────────────────────┐
        │       Cloudflare 边缘 Serverless 服务后端 (worker/)        │
        │ ────────────────────────────────────────────────────────── │
        │ • 现代化 Hono v4 REST API 路由架构                         │
        │ • SimpleWebAuthn Passkeys FIDO2 生物凭据校验               │
        │ • AES-GCM-256 凭证落盘对称加解密保险库                     │
        │ • Rust WASM 高性能邮件流解析 (mail-parser-wasm)            │
        │ • Cloudflare D1 分片 SQLite 存储 + KV 缓存 + Email Routing │
        │ • 定时 90 天数据生命周期滚动淘汰                           │
        └────────────────────────────┬───────────────────────────────┘
                                     │ (JSON / Bearer Token / API Key)
                                     ▼
        ┌────────────────────────────────────────────────────────────┐
        │               现代解耦 Web 前端 (frontend/)                │
        │ ────────────────────────────────────────────────────────── │
        │ • Vue 3 + Vite + Tailwind CSS + Naive UI 毛玻璃质感交互    │
        │ • 毫秒级提取验证码胶囊，支持一键剪贴板复制                 │
        │ • AI 邮件智能速览，带客户端 LRU 本地缓存                   │
        │ • keep-alive 生命周期感知，切后台暂停轮询省 D1 读配额      │
        │ • 多语言深度链接路由 (zh / en / ja / es / pt / de)         │
        └────────────────────────────────────────────────────────────┘
```

---

## 方案对比优势

| 评估维度 | One-Mail | 传统本地桌面邮件客户端 | 商业闭源多邮箱聚合平台 |
|---|:---:|:---:|:---:|
| **部署与运维成本** | **$0 Serverless**（依托 Cloudflare 免费层额度） | 需下载安装专用笨重客户端 | 需按月支付高昂的订阅服务费 |
| **多端实时同步** | **云端全量汇聚**，任何浏览器即开即用 | 需逐台设备配置，规则与状态不同步 | 依赖其商业私有云存储中转 |
| **隐私数据自主权** | **100% 开源自托管**，凭据边缘对称加密 | 邮件明文散落于本地磁盘 | 邮件数据被迫上传至第三方服务器 |
| **免密登录体验** | **原生 Passkeys / WebAuthn 生物认证** | 仅支持单一主密码 | 传统账号密码方式 |
| **验证码提取效率** | **卡片直接外显高亮胶囊，一键秒级复制** | 必须逐封点开阅读完整长邮件 | 仅提供简易纯文本预览截断 |
| **AI 总结与洞察** | **内置 AI 邮件意图速览与待办项提取** | 无或依赖付费插件扩展 | 仅限最高阶企业会员付费专享 |
| **临时邮箱中枢** | **内置即用即抛临时邮箱与私有域名管理** | 不支持 | 不支持 |
| **抗封控自愈韧性** | **POP3 智能锁定降级与并发令牌锁** | 极易触发发信服务商频控封禁 | 策略调整黑盒，无法自定义控制 |

---

## 快速开始

One-Mail 采用经典的分层架构：**Cloudflare Worker API**、**解耦 Web 前端** 以及 **VPS Python 聚合器**。

### 1. 部署 Cloudflare Worker（边缘后端）

环境要求：**Node.js 20+** 与 **pnpm**：

```bash
# 1. 克隆代码仓库
git clone https://github.com/dengyie/one-mail.git
cd one-mail/worker

# 2. 安装依赖
pnpm install

# 3. 配置 wrangler.toml
cp wrangler.toml.template wrangler.toml
# 编辑 wrangler.toml 填入你的 Cloudflare D1 数据库 ID、KV 命名空间 ID 与 MAIL_CRED_ENCRYPTION_KEY

# 4. 执行数据库迁移脚本
pnpm wrangler d1 migrations apply DB --remote

# 5. 部署到 Cloudflare 边缘网络
pnpm deploy
```

部署完成后，将获得 Worker API 地址（例如 `https://mail-api.yourdomain.com`）。

---

### 2. 配置 VPS 聚合器（邮件同步引擎）

聚合器运行在标准 Python 3.10+ 环境下，无重度 C 依赖，常驻内存占用低于 50MB：

```bash
cd ../aggregator

# 1. 复制配置文件模板
cp config.example.json config.json
# 编辑 config.json 填入外部邮箱账号密码/OAuth 参数与 Worker API 端点

# 2. 以生产/可编辑模式安装依赖
pip install -e .

# 3. 建议使用 Supervisord 进行进程守护
# 生产配置参考 deploy/supervisor.conf
# 聚合器会自动激活 IMAP IDLE 实时监听与 60s 兜底轮询
```

---

### 3. 构建与部署 Web 前端

前端为纯静态 Vue 3 单页应用，可自由托管在 Cloudflare Pages、Nginx 或 Docker：

```bash
cd ../frontend

# 1. 安装前端依赖
pnpm install

# 2. 配置环境变量
cp .env.example .env.local
# 设置 VITE_API_BASE=https://mail-api.yourdomain.com

# 3. 本地开发调试
pnpm dev

# 4. 构建生产产物
pnpm build
# 静态打包产物输出至 dist/ 目录，可直接交付 Nginx 托管
```

#### Nginx 生产环境配置参考

```nginx
server {
    listen 80;
    server_name inbox.yourdomain.com;

    root /www/one-mail/dist;
    index index.html;

    # 单页应用路由回退
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 静态静态资源长缓存
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|wasm)$ {
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }
}
```

---

## 开放 API 与开发者生态

One-Mail 提供对开发者友好的标准 RESTful API，便于接入自定义工作流、运维机器人或自动化流水线。

### 鉴权机制

- **收件箱通用接口**：`Authorization: Bearer <api-key>`
- **管理与摄入接口**：`x-admin-auth: <ADMIN_PASSWORD>`

### 常用核心端点

```http
# 1. 分页检索与关键词过滤邮件
GET /api/unified/emails?source=gmail&limit=20&offset=0&q=invoice

# 2. 获取未读与全量邮件计数
GET /api/unified/count?unread=1

# 3. 提取指定收件地址的最新活跃验证码
GET /api/unified/verifcodes?addr=user@example.com&fresh=1

# 4. 标记单封邮件为已读
POST /api/unified/emails/:id/read

# 5. 聚合器批量推送并摄入邮件 (带 UID 幂等去重)
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

已对以下语言环境开展了完整的国际化适配工作：
- 简体中文 (`zh`)
- English (`en`)
- 日本語 (`ja`)
- Español (`es`)
- Português (`pt-BR`)
- Deutsch (`de`)

---

## 致谢：LINUX DO

[![LINUX DO](https://img.shields.io/badge/Community-LINUX%20DO-2563eb.svg?logo=linux&logoColor=white)](https://linux.do/)

> **本项目致谢 [LINUX DO](https://linux.do/) 社区。** One-Mail 从零到一的架构选型、边缘计算的实践经验，以及众多生产环境排障与优化思路，都汲取自 LINUX DO 社区佬友们的无私分享与深入探讨。致敬开源精神与纯粹的技术探索！

---

## 参与贡献

欢迎通过提交 Issue 与 Pull Request 的方式共同参与完善 One-Mail。若该项目在多邮箱管理方面带来了一定帮助，欢迎在代码仓库右上角点亮 Star 给予支持。

---

## 开源协议

本项目基于 [MIT 许可证](LICENSE) 开展开源授权。可以在保留原作者版权声明的前提下自由运用于个人或者商业项目当中。
