# one-mail 全面架构优化：重构 + monorepo 化

> 2026-08-22 · 目标：**前后端契约隔离 + worker 内部抽象分层 + 原位 monorepo（`packages/shared` 共享包）**。不改变线上行为、不移动部署目录、每阶段可回滚。
>
> **前置工作**：架构勘察子 agent 完成 100+ 文件模块图 + 耦合度分析（2026-08-22）。本设计基于勘察结论。

## 勘察结论：4 大复制粘贴缠结

### Worker 内部缠结（T1–T4）

| # | 缠结 | 现状排列 | 风险 |
|---|------|---------|------|
| T1 | **地址 JWT 签发** | 同一段 `Jwt.sign({address,address_id,exp:...}, c.env.JWT_SECRET, "HS256")` 在 5 处直接拷贝 | 改 TTL/载荷/签名算法须同步 5 处，漏一处即不一致 |
| T2 | **JWT 校验 + exp 检查** | ~10 处各自实现 `Jwt.verify(token, secret)` + 手动 `payload.exp < now` 判断，语义不一致 | `REJECT_EXPLESS_JWT` 只在 worker.ts:194 一处生效，其余 9 处尊重 exp-less 旧 token 不统一 |
| T3 | **settings 表 SQL + key 常量** | `getSetting`（`utils.ts`）与 `getJsonSettingLocal`（`quota.ts` 显式内联拷贝）双份；`'user_settings'`/`'role_address_config'` 等 key 字面量散落 | 改 schema 或 key 须同步多处 |
| T4 | **emails INSERT（17 列）** | `ingest.ts` 与 `unified_store.ts` 各自一份 17 列 INSERT，列序必须锁步；`raw_mails` 列表 SQL 在 3 处重复（`mails_crud.ts`/`parsed_mail_api.ts`/`user_mail_api.ts`） | 加列忘同步→聚合器/路由收信双双挂；改列表条件须修 3 处 |

### 前端↔后端契约面

- **4 个鉴权 wrapper 互抄**：`api/index.js` 中 `apiFetch`/`unifiedFetch`/`unifiedUserFetch`/`unifiedAuthFetch` 各自重复相同的 `status >= 300` 错误路径，镜像了 worker 多通道鉴权模型。
- **后端逻辑泄漏进前端**：`store/index.js` 把 worker 鉴权策略 1:1 复制（5 个 key 对应 5 种 header），`showAdminPage` 重实现了管理员鉴权策略。

### 聚合器→worker 脆弱约定

- ingest body 键序必须与 `toEmailInsertParams` 完全一致，任一字段 null 即整批 500。
- `AccountConfig(**a)` 字段改名会静默跳过该账号。

## 目标架构

```
one-mail/                          # 原位 monorepo（pnpm workspace）
├── package.json                   # workspace root（新建）
├── pnpm-workspace.yaml            # (新建)
├── packages/
│   └── shared/                    # 共享契约包（TS 预编译 → dist JS）
│       ├── src/
│       │   ├── types/             # 公开端点类型、请求/响应 shape
│       │   │   ├── auth.ts        # x-user-token / Bearer JWT / API-key 结构
│       │   │   ├── mail.ts        # Mail / ParsedMail / UnifiedEmail
│       │   │   ├── user.ts        # UserSettings / UserRole
│       │   │   ├── address.ts     # Address / AddressConfig
│       │   │   ├── admin.ts       # AdminConfig / Statistics
│       │   │   └── unified.ts     # IngestBody / AccountExport / AggregatorStatus
│       │   └── consts/
│       │       ├── paths.ts       # API 路径常量（API_PATHS 单源）
│       │       ├── keys.ts        # settings 表 key 常量（'user_settings' 等）
│       │       └── defaults.ts    # JWT_TTL / 配额定值 / 错误码
│       ├── dist/                  # tsc 编译产物（JS + .d.ts）
│       ├── tsconfig.json
│       └── package.json           # name: @one-mail/shared
│
├── worker/                        # 不动目录（仅改 package.json 加 workspace dep）
│   ├── src/
│   │   ├── core/                  # (新) 精炼抽象层，hono-only
│   │   │   ├── auth.ts            # signAddressJwt / verifyJwtWithExp（灭 T1+T2）
│   │   │   ├── settings.ts        # getSetting / saveSetting / getJsonSetting（灭 T3）
│   │   │   ├── ingest.ts          # insertEmail / insertEmailsBatch（灭 T4）
│   │   │   └── mail-list.ts       # listRawMails / countRawMails（灭 T4）
│   │   ├── _api/                  # 现有路由层（不动逻辑，只替换 import 为 core/）
│   │   └── worker.ts              # 入口（不动）
│   └── package.json               # 加 "@one-mail/shared": "workspace:*"
│
├── frontend/                      # 不动目录
│   ├── src/
│   │   ├── api/
│   │   │   └── index.js           # 4 wrapper → 1 createApiClient(headerInjector) 工厂
│   │   ├── store/
│   │   │   └── index.js           # 去重 showAdminPage 实现，只消费后端告知的策略
│   │   └── ...
│   └── package.json               # 加 "@one-mail/shared": "workspace:*"
│
├── aggregator/                    # 不动（Python，不加入 pnpm workspace）
├── db/                            # 不动
├── vitepress-docs/                # 不动
├── e2e/                           # 不动
└── mail-parser-wasm/              # 不动
```

### 架构原则

1. **原位 monorepo**：不移动任何现有目录——worker/frontend/aggregator 部署路径、wrangler 配置、CI 路径均不变。仅新增根 workspace 配置 + `packages/shared` 包。
2. **hono-only 测试约束**：`core/` 中每个模块只引 hono，零相对 import（`import type { X } from '@one-mail/shared'` 由 strip-types 擦除，安全）。`shared` 包预编译 dist JS 供测试引用。
3. **行为零变化**：每个抽象层先做到「行为等价替换」，再考虑后续优化。`verifyJwtWithExp` 默认保留无 exp 旧 token 的既有行为（`REJECT_EXPLESS_JWT` 仍为 false）。
4. **每阶段可独立部署 + 可回滚**：部署等价替换后再删旧代码，保证任一阶段出问题可回退到上一阶段。

## 组件设计

### 1. `packages/shared` 共享契约包

| 面 | 内容 |
|----|------|
| `types/` | 公开端点请求/响应 TypeScript 类型定义。仅类型（`interface`/`type`），不含运行时逻辑。`import type { X } from '@one-mail/shared'` 在 strip-types 下被擦除。 |
| `consts/` | 运行时常量（路径、key 字面量、定值）。需要预编译 JS 供 worker 测试引用。 |
| 编译 | `tsc` → `dist/`（JS + .d.ts）。`package.json` `"main": "dist/index.js"` + `"types": "dist/index.d.ts"`。 |
| 消费方 | worker（TS → `import { ... }` 或 `import type`）；frontend（JS → JSDoc 标注 `@type {import('@one-mail/shared').X}`）。 |

### 2. `worker/src/core/` 精炼抽象层

每个模块独立测试且 **hono-only**（实验用例见 `quota.ts`/`webhook_url.ts` 范式）。

#### 2a. `core/auth.ts` — 灭 T1+T2

```ts
// 签名（替换 5 处）
signAddressJwt(c: Context, payload: { address: string; address_id: number }): Promise<string>
// 校验（替换 ~10 处）
verifyAddressJwt(c: Context, token: string): Promise<{ address: string; address_id: number; exp?: number } | null>
// 外部无 exp 旧 token 处理：verify 返回 null 时调用方决定行为；
// REJECT_EXPLESS_JWT=true 时统一拒掉无 exp token
verifyJwtWithExpCheck(c: Context, token: string): Promise<AddressJwtPayload | null>
```

- `signAddressJwt` 统一读 `ADDRESS_JWT_TTL_DAYS`（默认 90），内部计算 `exp`。
- `verifyJwtWithExpCheck` 统一读 `REJECT_EXPLESS_JWT`，所有 ~10 处调用方替换为此函数 → T2 语义一致。
- **测试**：`core/auth.test.mjs`（hono-only mock Context JWT_SECRET）
  - 签发的 token 可被 verify 解开
  - exp 值 = now + 90d（±1s）
  - REJECT_EXPLESS_JWT=true 拒无 exp token
  - REJECT_EXPLESS_JWT=false 接受无 exp token（默认兼容）

#### 2b. `core/settings.ts` — 灭 T3

```ts
getSetting(c: Context, key: string): Promise<string | null>
saveSetting(c: Context, key: string, value: string): Promise<void>
getJsonSetting<T>(c: Context, key: string): Promise<T | null>
```

- 唯一内核 SQL（`SELECT value FROM settings WHERE key = ?` / `INSERT OR REPLACE`）。
- 常量 key 从 `@one-mail/shared/consts/keys` 导入（不重复写字面量）。
- `quota.ts` 的 `getJsonSettingLocal` 改为调用 `getJsonSetting` 或仍然内联（Hono-only 约束下 `quota.ts` 本就不引 `utils.ts`），但 key 常量统一。
- 注：`utils.ts` 的 `getSetting`/`saveSetting` **重定向到 `core/settings.ts`**（`utils.ts` 不跑 `node --test`，无 strip-types 约束，可引 core/）。`core/settings.ts` 绝不反向引 `utils.ts`。方向：`old_utils` → `new_core`。

#### 2c. `core/ingest.ts` — 灭 T4（email INSERT 部分）

```ts
insertEmail(c: Context, email: EmailInsertParams): Promise<boolean>
insertEmailsBatch(c: Context, emails: EmailInsertParams[]): Promise<number>
```

- `EmailInsertParams` 类型由 `@one-mail/shared` 定义。
- 替换 `ingest.ts:30-34` 与 `unified_store.ts:53-63` 的独立 INSERT SQL。
- 列序由类型定义集中维护——加列只需改类型 + core/ingest.ts 一处。

#### 2d. `core/mail-list.ts` — 灭 T4（raw_mails 列表部分）

```ts
listRawMails(c: Context, address: string, opts?: { limit?: number; offset?: number }): Promise<RawMail[]>
countRawMails(c: Context, address: string): Promise<number>
```

- 替换 `mails_crud.ts`、`parsed_mail_api.ts`、`user_mail_api.ts` 三处的 `SELECT * FROM raw_mails WHERE address = ?` + `SELECT COUNT(*)`。
- 返回类型由 `@one-mail/shared` 定义。

### 3. 前端 api/index.js 收敛

```js
// 现状：4 个 wrapper → 目标：1 个工厂函数
createApiClient(headerInjector: () => Record<string, string>)
// 用法：
const api = createApiClient(() => ({ 'x-user-token': userJwt.value }))
await api.get('/user_api/settings')
// api.get/post/put/delete 自动处理 status >= 300，统一错误路径
```

- `headerInjector` 是一个函数，每次请求调用获取当前 auth 头（reactive 值在 .value 中）。
- 4 个场景（x-user-token、Authorization Bearer、x-admin-auth、Bearer API-key）各自传入不同 injector。
- 共享类型：`api.get<P extends Path, R extends ResponseType>(path, params?)` 由 `@one-mail/shared` 类型驱动（JSDoc 标注）。

### 4. 聚合器脆弱约定

- 不改变数据传输格式（线上正在运行，不能改 ingest 键序）。
- 将 `toEmailInsertParams` 的契约（键序 + 每字段非 null 约束）文档化到 `packages/shared` 的类型定义中。
- `uploader.py` 与 `ingest.ts` 各自仍用自己的实现，但共享类型是唯一参考来源。

## 阶段划分

| 阶段 | 内容 | 新文件 | 单测 |
|------|------|--------|------|
| **P1** | 根 workspace 配置 + `packages/shared` 包骨架（类型 + 常量 + tsc 编译） | `package.json`、`pnpm-workspace.yaml`、`packages/shared/` | shared tsc build 通过 |
| **P2** | `core/auth.ts` 签名/校验抽象 + 替换 5 处签发 + ~10 处校验 | `core/auth.ts` + test | 新单测 + 原 62 测试绿 |
| **P3** | `core/settings.ts` + key 常量共享 + 替换 utils.ts/quota.ts 双份 | `core/settings.ts` + test | 同上 |
| **P4** | `core/ingest.ts` + `core/mail-list.ts` + 替换 5 处 SQL | `core/ingest.ts`、`core/mail-list.ts` + tests | 同上 |
| **P5** | FE api/index.js 4 wrapper → 1 工厂 + shared 类型 JSDoc 标注 | 改 `api/index.js`、`store/index.js` | `pnpm build:pages` 绿 |
| **P6** | 收尾：清理旧代码（`utils.ts` 重定向去重、旧 JWT 校验函数删除）、双语 CHANGELOG + docs 更新 | 改 `utils.ts`、`common.ts`、`CHANGELOG*.md`、`vitepress-docs/` | 全量测试绿 |

每阶段独立可部署：P1 只是新增文件不影响任何线上逻辑；P2–P4 是行为等价替换；P5 单独上线；P6 是清理+文档。

## 决策记录（已确认）

| 决策 | 选项 | 拍板 |
|------|------|------|
| Monorepo 布局 | 原位 + 新增 `packages/shared` / 全量 apps/ 重组 / 先抽象后重组 | **原位 + 新增 shared 包** |
| 前端 TS 化 | FE 保持 JS（JSDoc 标注） / FE 转 TS | **FE 保持 JS** |
| 线上校验 | 局部自验（每阶段单测绿 + 部署） | **局部自验（默认）** |
| 子 agent 分工 | 分析→方案→分阶段实现 | **已确认** |

## 未变的事项

- `emails` 表结构、`resolveScope`/`checkRowAccess` 隔离逻辑不变。
- 外部邮箱 `username` 格式/域名校验不变。
- admin `config.json` 聚合账号、`AccountConfig` 字段不变。
- 聚合器传输协议（ingest body 键序、mail_accounts 导出格式、status 回写）不变——仅文档化。
- 前端 `VITE_API_BASE` 跨域直连 worker 的部署形态不变。

## 验收

- **P1**：`pnpm install` 在根级成功；`packages/shared` 可 `tsc` 编译产出 dist/；worker 可 `import { ... } from '@one-mail/shared'`（`pnpm build` 通过）。
- **P2–P4**：`cd worker && node --experimental-strip-types --test src/core/*.test.mjs` 新测试全绿 + `node --experimental-strip-types --test src/unified/*.test.mjs` 原 62 测试全绿。
- **P5**：`cd frontend && pnpm build:pages` 构建通过；`index.html` 包引用正常。
- **P6**：`git grep` 确认旧 JWT 签发/校验函数无残留引用；`utils.ts` 中 `getSetting`/`saveSetting` 已重定向到 `core/settings.ts`（或反之）。
- **全阶段**：`cd worker && pnpm lint && pnpm build` 无错误；每一阶段线上 worker 可正常响应（部署后 ping 200 + 鉴权 401 正常）。