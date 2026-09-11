# 前端开发文档（one-mail 统一收件箱）

> [!NOTE]
> 本文针对 **one-mail 统一收件箱** 的 Vue 3 前端。本项目 `frontend/` 目录是团队自主开发的 Vue 3 前端（Vue 3 + Vite + Naive UI），并且在最近一次
> 前后端分离（commit `64f0eda`）之后，**前端是唯一通过跨域直接连接 Worker 的形态**——
> 不再有 Pages Functions 代理拓扑。

---

## 架构总览

```
浏览器（Vue 3 SPA）
   │  VITE_API_BASE 指向 Worker 自定义域名
   │  （本地开发时经 vite dev server.proxy 转发到 127.0.0.1:8787）
   ▼
Cloudflare Worker ──mail-api.mangoqwq.cc.cd
   │  ├─ /api/unified/*       统一收件箱查询（API-key 鉴权）
   │  ├─ /admin/unified/*     统一收件箱管理（x-admin-auth 鉴权）
   │  └─ /api/* · /user_api/* · /admin/*  临时邮箱基座
```

前端 `frontend/` 是一个纯静态 Vue 3 SPA：

- **技术栈**：Vue 3（Composition API） + Vite + Naive UI（`unplugin-auto-import` + `unplugin-vue-components`）；`vue-router` 4、`vue-i18n` 11、`axios`（`api/index.js`）、`@vueuse/core`（全局状态持久化）、`@fingerprintjs`（设备指纹）。
- **本地开发**：`pnpm dev` 起 Vite dev server，浏览器访问 `http://localhost:5173`；dev 时 `/api`、`/open_api`、`/user_api`、`/admin`、`/telegram`、`/external` 均经 `vite.config.js` 的 `server.proxy` 转发到 `127.0.0.1:8787`（即本地 `wrangler dev`）。
- **生产部署**：`VITE_API_BASE` 指向 Worker 自定义域名（如 `https://mail-api.mangoqwq.cc.cd`），构建产物为静态文件；由 Cloudflare Pages 托管到自定义域名，页面内所有请求跨域直连 Worker。

> [!TIP]
> 后端最小本地形态：`cd worker && pnpm install && pnpm dev`（`wrangler dev`，本地 D1/KV）。需要先有本地 D1，可参考 `cli/d1` / `ui/d1`。前端 dev 直连 `127.0.0.1:8787` 即可联调，无需 CORS 配置。

---

## 目录结构

```
frontend/
├── .env.example          # 环境变量样例（见下文「环境变量」）
├── .env.pages            # Pages 构建用 env（含线上 API 地址）
├── vite.config.js        # Vite 配置 + dev server.proxy + PWA + wasm 插件
├── package.json          # scripts：dev / build / build:pages / build:telegram ...
└── src/
    ├── main.js           # 入口：createApp + i18n + router + @unhead/vue
    ├── App.vue
    ├── router/           # 路由 + 全局前置守卫（语言/认证重定向）
    ├── store/index.js    # 全局状态（@vueuse/core createGlobalState + useLocalStorage 持久化）
    ├── i18n/             # vue-i18n 11 配置、多语言资源、locale 工具
    ├── api/index.js       # 唯一 API 封装（axios 实例 + apiFetch + 鉴权头注入）
    ├── models/index.ts   # OAuth2 / 类型定义
    ├── constant/index.ts # 常见邮件域名等常量
    ├── utils/            # headers / fingerprint / email-parser / sanitize-html ...
    ├── components/       # 通用组件（MailBox / AddressCredentialModal / Turnstile ...）
    └── views/            # 页面视图
```

---

## 关键模块

### API 层（`src/api/index.js`）

前端唯一的 API 封装。`import.meta.env.VITE_API_BASE` 为空时请求落在同源（浏览器针对
Vite dev server 的 origin，经 proxy 转发）；非空时跨域直连 Worker。

`apiFetch(path, options)` 负责：

- 注入鉴权头：`x-user-token`、`x-user-access-token`、`x-custom-auth`、`x-admin-auth`、`Authorization: Bearer <jwt>`，以及 `x-lang`、`x-fingerprint`。
- 每个请求都会检查 `safeHeaderValue` / `safeBearerHeader`（`utils/headers.js`），
  过滤掉 `undefined`/`null`、空串、字面量 `"undefined"`/`"null"`、以及含控制字符的值，
  避免 `Invalid character in header content` 崩溃（见 issue #1000）。
- 返回 `response.data`；HTTP ≥ 300 时抛错；401 会根据端点判定是否弹登录/管理员窗口。

### 路由（`src/router/index.js`）

`createWebHistory` + 多语言路由（`/:lang/*`），通过 `resolveSupportedLocale` /
`getPreferredLocale` 决定当前语言，无语言前缀时重定向到默认 locale。

> [!TIP]
> 新增页面时：在 `router/index.js` 注册路由，并在 `src/views/` 添加组件；如需要
> 国际化文案，在 `i18n/locales/*` 补充。

### 全局状态（`src/store/index.js`）

基于 `@vueuse/core` 的 `createGlobalState`，将 `openSettings / settings / jwt /
userJwt / auth / adminAuth / userSettings / preferredLocale` 等做成共享响应式状态并用
`useLocalStorage` 持久化（页面刷新后保留）。

### 邮件解析（`src/utils/email-parser.js`）

`processItem(item)` 优先用 `mail-parser-wasm`（WASM）解析 `raw` → 得到 sender/subject/
body/附件；解析失败时回退到 `postal-mime`。附件以 `URL.createObjectURL` 生成 blob url，
`cid:` 引用替换为对应 blob。

> [!NOTE]
> `/api/mails` 按设计返回原始 RFC822（含 `raw`），前端在渲染前负责解析成可读字段。
> 统一收件箱 `/api/unified/emails` 返回的是已解析字段（`subject`/`from_addr` 等）。

---

## 2. 本地开发

```bash
# 1) worker（后端）
cd worker
pnpm install
pnpm dev            # wrangler dev，监听 127.0.0.1:8787

# 2) 前端（另开终端）
cd frontend
pnpm install
pnpm dev            # Vite dev server http://localhost:5173
```

浏览器打开 `http://localhost:5173` 即可联调，无需 CORS 配置（dev proxy 同源转发）。

- **让 dev 请求打到正确的 Worker**：保持 `VITE_API_BASE` 为空（或未设），这样请求落在
  同源走 proxy。若设置了非空 `VITE_API_BASE`，请求会直接跨域打向该 Worker（本地联调
  时一般不希望这样）。
- **`vite.config.js` 的 `server.proxy`** 已把 `/api`、`/open_api`、`/user_api`、`/admin`、
  `/telegram`、`/external` 转发到 `http://127.0.0.1:8787`。需要新增端点前缀时在
  该 proxy 配置里补一条。

---

## 3. 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `VITE_API_BASE` | 后端 Worker 根地址（`https://` 开头、末尾不带 `/`）。生产必填；留空 = 同源（仅本地 dev）。| 生产必填 |
| `VITE_CF_WEB_ANALY_TOKEN` | Cloudflare Web Analytics token（可选） | 否 |
| `VITE_IS_TELEGRAM` | Telegram 专属构建形态开关（`true` 时用 `build:telegram`） | 否 |

> [!WARNING]
> **不要**在仓库里提交真实密钥/token。`.env.example` / `.env.pages.example` 只存档占位符与
> 说明；`.env.pages` 已被忽略、不入 git。

> [!NOTE]
> `frontend/.env.pages` 已加入根 `.gitignore`（I1 安全加固）——它是密钥落地区，禁止提交，
> 仓库只留 `.env.pages.example` 样例。但 `pnpm build:pages` 会隐式加载 `.env.pages`
> （Vite `-m pages`），因此 pxed 部署必须在构建机执行 `build:pages` **之前**用
> `scp`/注入方式把 `frontend/.env.pages` 就位（值参考 `.env.pages.example`）。

示例：

```bash
# .env.local（本地 / 自定义环境）
VITE_API_BASE=https://mail-api.mangoqwq.cc.cd
VITE_CF_WEB_ANALY_TOKEN=
```

---

## 4. 构建 / 部署矩阵

> [!NOTE] 前置：monorepo workspace
> 仓库现为 pnpm workspace（monorepo），构建前端**前**需先在仓库根执行 `pnpm install`，并按需执行
> `pnpm --filter @one-mail/shared build`（共享契约包 dist），然后才可构建前端。

| 目标 | 命令 | 说明 |
|------|------|------|
| 本地预览 | `pnpm dev` | Vite dev server（proxy → 8787） |
| 静态产物 | `pnpm build` | 生产构建到 `dist/` |
| Pages 部署 | `pnpm build:pages` | 生成 Pages 形态的 `dist/`（配合 `.env.pages` 的 API 地址） |
| Pages 部署（无 PWA）| `pnpm build:pages:nopwa` | 同上，禁用 Service Worker |
| Telegram 形态 | `pnpm build:telegram` | 麻雀 Telegram 单页面构建 |
| 部署到 Pages（从 CLI）| `pnpm deploy` | `build` + `wrangler pages deploy ./dist --branch production` |

完成 `build:pages` 后，将 `dist/` 上传到 Cloudflare Pages（连接仓库或手动上传），
并把自定义域绑定到对应前端域名即可。前端是纯静态，所有 API 调用都经 `VITE_API_BASE`
跨域打到 Worker，因此页面服务器不需要任何反代配置。

---

## 5. one-mail 统一收件箱 & API 鉴权

### 登录用户与 API-key 鉴权

`/api/unified/*` 支持两条鉴权通道，浏览器登录用户优先使用现有用户体系：

- 用户登录后发送 `x-user-token`（现有 `users` JWT）。具备 `ADMIN_USER_ROLE` 的用户为管理员，可查看全部归集邮件。
- 普通用户按 `users_address → address.name → emails.to_addr` 做归属过滤，只能查看自己绑定地址的邮件；没有绑定地址时 fail-closed 返回空结果。
- 没有登录用户时仍可使用 `Authorization: Bearer <apiKey>`，供聚合器或脚本程序化访问。
- API key 由 `POST /admin/unified/keys` 创建（`x-admin-auth` 保护），创建时返回一次明文 key；每个 key 可带 `role`（`readonly` / `admin`）以及 `allowed_sources` / `allowed_accounts` 白名单。
- 单封邮件读取与标记已读、验证码查询都会执行对应的行级/地址级作用域校验；API-key 行级校验对缺失或空的 `source`/`account_id` fail-closed。

### 统一收件箱 API 端点

| 端点 | 方法 | 说明 | 鉴权 |
|------|------|------|------|
| `/api/unified/emails` | GET | 分页查询邮件（支持 `source`/`account_id`/`unread` 过滤） | 用户 JWT / API-key |
| `/api/unified/emails/:id` | GET | 单封邮件（含 raw，执行归属校验） | 用户 JWT / API-key |
| `/api/unified/count` | GET | 邮件计数 | 用户 JWT / API-key |
| `/api/unified/verifcodes` | GET | 验证码邮件查询（`addr`/`fresh`，执行归属校验） | 用户 JWT / API-key |
| `/api/unified/emails/:id/read` | POST | 标记已读（执行归属校验，readonly key 被 403） | 用户 JWT / API-key |
| `/api/unified/ingest` | POST | 聚合器写入 | `x-admin-auth` |
| `/admin/unified/keys` | POST | 创建 API-key | `x-admin-auth` |

---

## 6. 统一收件箱前端页面

统一收件箱页面（顶部导航「统一收件箱」，路由 `/unified`）是 Tailwind + awesome-ui 组件
装配的独立视图，通过 `/api/unified/*` 读取聚合器归集的跨账号邮件。路由：
`/unified`（主页面）与 `/unified/:id`（单封详情）。

### Tailwind 接入

- `src/tailwind.css`：`@import "tailwindcss"` + `@custom-variant dark (&:where(.dark, .dark *))`，
  让 `dark:` 工具类跟随全站 `useDark`（class 策略，`<html class="dark">`）。
- `vite.config.js`：引入 `@tailwindcss/vite` 插件，构建产物会编译 Tailwind 工具类。
- 与 Naive UI 共存：Tailwind 的 preflight 不会覆盖 Naive 组件（组件样式优先），zinc 工具类
  只用于本页面与 awesome-ui 组件。

### 页面结构（4 个视图）

| Tab | 说明 |
|-----|------|
| 邮件列表 | 分页（`limit`/`offset`）+ `source`/`account_id`/`unread` 过滤 + `q` 关键词搜索；点击行进入详情 |
| 验证码 | 输入收件地址 + `fresh` 时间窗（10min/1h/24h），卡片高亮 `code` 并一键复制 |
| 聚合器状态 | 从 `/api/unified/count` + 列表推导「总数 / 未读 / 来源 / 账号」（前端视图；实际 IMAP/POP3 抓取由 Python 聚合器完成） |
| API 设置 | 粘贴/保存 API-key（仅存 localStorage）；「测试连接」；管理员密码可新建 key（明文仅显示一次） |

### 关键实现点

- `src/api/index.js`：登录用户优先由 `unifiedUserFetch` 注入 `x-user-token`；未登录时回退到
  `unifiedFetch` 的 `Authorization: Bearer <unifiedApiKey>`，两者都不触发全局 loading；`buildUnifiedQuery`
  负责把 `source`/`account_id` 数组拼成逗号多值。
- 页面未登录且未配置 API-key 时显示登录入口；登录后无需 API-key，管理员看全部，普通用户由 Worker 自动限制到绑定地址。
- `UnifiedInboxDetail.vue` 直接深链接打开时也执行同一鉴权选择，单封邮件和标记已读不会绕过 Worker 作用域。
- `src/store/index.js`：`unifiedApiKey`（`useLocalStorage`）保存 key。
- `src/components/ai/`：从 awesome-ui 复制的纯 Tailwind 组件（`StatusIndicator` 等，
  `<script setup lang="ts">` 无需改动即可使用）。
- 正文渲染：优先 `text_body`；仅有 `html_body` 时做最小转纯文本，**绝不使用 `v-html`**。
- 国际化：`src/i18n/message-registry.ts` 新增 `unified` namespace，页面用
  `useScopedI18n('unified')` 取文案。

### 构建验证

`pnpm build` 产出 `UnifiedInbox` / `UnifiedInboxDetail` 两个独立 chunk，Tailwind 样式编译进
`index-*.css`。本地联调：`worker` 用 `pnpm dev`（本地 D1），前端 `pnpm dev`（proxy 到
`127.0.0.1:8787`），在设置页粘贴 API-key 后各视图即可取数。

---

## 7. 代码风格与参考

- 入口：`src/main.js`
- 全局路由守卫：`src/router/index.js`（locale 重定向 + `jwt` query 处理）
- 唯一 API 层：`src/api/index.js`
- 全局状态：`src/store/index.js`
- 组件都在 `src/components/`，页面在 `src/views/`
- `src/utils/` 放纯函数/工具（headers / fingerprint / email-parser / sanitize-html 等）

尽量保持：

- ESM 语法（`type: module`）。
- Vue 3 Composition API（`<script setup>`）。
- Naive UI 组件由 `unplugin-vue-components` 自动按需导入，不要手动把 `NButton` 等
  import 进每个文件。
- 公共常量放 `src/constant/`，类型放 `src/models/`，国际化文案放 `src/i18n/`。

---

## 8. 常见问题

**Q: dev 时接口 404 / CORS**
: 确认 `VITE_API_BASE` 为空（走 proxy），工作 worker 在 `127.0.0.1:8787`。若设了非空
  `VITE_API_BASE` 且本地 worker 未监听对应地址，请求会打到远端。

**Q: 改了 `vite.config.js` 需要重启**
: Vite 对 `vite.config.*` 的改动会自动重启 dev server。

**Q: `access_token` 或 token 含异常字符，请求直接崩**
`utils/headers.js` 的 `safeHeaderValue` 会过滤掉含控制字符/空串的 token，如果你在
`Auth` header（token 带 `\n`/空格）出现 `Invalid character`, 先检查 localStorage 里
的值是否被污染。

**Q: 生产页面没有数据（接口 401/403）**
检查 `VITE_API_BASE` 是否指向正确的 Worker、`x-custom-auth`/Bearer 是否有效、以及
API key 白名单是否覆盖目标 `source`/`account_id`。

---

> 本文约定与仓库 CHANGELOG 保持一致（zh：`CHANGELOG.md`、en：`CHANGELOG_EN.md`），
> 前端一应变更需双语言记录。