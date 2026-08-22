# one-mail 架构重构 + monorepo 化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在原位目录结构上新增 `packages/shared` 共享契约包 + `worker/src/core/` 精炼抽象层，精准消灭 4 大复制粘贴缠结（地址 JWT 签发/校验、settings SQL、emails INSERT、raw_mails 列表），并把前端 4 个鉴权 wrapper 收敛为 1 个工厂。**线上行为零变化**。

**Architecture:** 原位 pnpm workspace（根 `package.json` + `pnpm-workspace.yaml`，顶层目录 worker/frontend 不动）。`packages/shared` 是 TS 包、`tsc` 预编译出 dist/（供 worker 的 strip-types 测试经 node_modules 解析）。worker 新增 `src/core/` 精炼层（hono-only、可测），路由层 `_api` 只是把 import 换成 core 抽象；前端 `api/index.js` 抽 `createApiClient` 工厂。

**Tech Stack:** pnpm 10 workspace · TypeScript（strip-types 直跑）· Hono `hono/utils/jwt` · Vue3 + Naive UI（JS，JSDoc 标注共享类型）· 单测 `node --experimental-strip-types --test`

**Spec:** `docs/superpowers/specs/2026-08-22-architecture-refactor-monorepo.md`

## Global Constraints

- **hono-only 测试约束**：被 `node --test` 加载的 worker 模块只引 hono（含 `hono/utils/jwt`）+ `@one-mail/shared`，**零相对 import**；若确需相对 import（如 quota→core），必须带显式 `.ts` 扩展名（`./core/settings.ts`）——node strip-types 与 esbuild 均解析。**core/ 内模块之间禁止相互相对 import**（各自自含）。
- **worker 测试命令（全量）**：`cd worker && node --experimental-strip-types --test src/core/*.test.mjs src/unified/*.test.mjs src/user_api/*.test.mjs src/email/*.test.mjs`
- **shared 必须先 build**：`pnpm --filter @one-mail/shared build`（tsc → dist/）之后 worker 测试才能 `import '@one-mail/shared'`。
- **行为零变化**：每个替换先「等价替换」，验证全绿后再继续。错误信息文本的措辞变化属可接受的 cosmetic（无逻辑依赖），须在任务说明中标注。
- **不 git commit**：子 agent 完成任务后**只报告**，由主 agent 在用户显式要求时统一 commit。
- **双语 CHANGELOG + docs**：收尾任务须同时更新 `CHANGELOG.md`（中文）+ `CHANGELOG_EN.md`（英文）`(main)` 段 + `vitepress-docs` zh/en。
- worker 包名 `cloudflare_temp_email` 与 frontend 相同 → monorepo 内必须重命名（wrangler 用 `wrangler.toml` 的 `name="one-mail"`，与 package.json name 无关，重命名安全）。`.github/workflows` 里的 `cloudflare_temp_email` 是上游 repo 名，**不要动**。

---

### Task 1: 根 workspace 脚手架 + `packages/shared` 骨架 + 解析冒烟

**Files:**
- Create: `package.json`（根）、`pnpm-workspace.yaml`、`packages/shared/package.json`、`packages/shared/tsconfig.json`、`packages/shared/src/index.ts`
- Modify: `worker/package.json`、`frontend/package.json`
- Test: `worker/src/core/resolution-smoke.test.mjs`（新建）

**Interfaces:**
- Produces: workspace `@one-mail/shared`（`SETTINGS_KEYS` / `API_PATHS` / `JWT_DEFAULTS` 常量 + dist/ 编译产物），供 Task 2/5 消费。

- [ ] **Step 1: 写失败冒烟测试** — 新建 `worker/src/core/resolution-smoke.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { SETTINGS_KEYS, JWT_DEFAULTS } from "@one-mail/shared";

test("worker test resolves @one-mail/shared workspace package", () => {
  assert.equal(SETTINGS_KEYS.USER_SETTINGS, "user_settings");
  assert.equal(SETTINGS_KEYS.ROLE_ADDRESS_CONFIG, "role_address_config");
  assert.equal(JWT_DEFAULTS.ADDRESS_TTL_DAYS, 90);
});
```

- [ ] **Step 2: 建 shared 包** — `packages/shared/package.json`：

```json
{
  "name": "@one-mail/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc -p tsconfig.json" },
  "devDependencies": { "typescript": "^5.6.0" }
}
```

`packages/shared/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "declaration": true,
    "outDir": "dist",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`packages/shared/src/index.ts`：

```ts
/** one-mail 共享契约：常量（预编译 dist/，供 worker strip-types 测试经 node_modules 解析）+ 类型（仅 `import type` 消费，strip-types 擦除） */
export const API_PATHS = {
  ADDRESS: "/api",
  USER: "/user_api",
  ADMIN: "/admin",
  OPEN: "/open_api",
  TELEGRAM: "/telegram",
  EXTERNAL: "/external",
  UNIFIED: "/api/unified",
  UNIFIED_ADMIN: "/admin/unified",
} as const;

export const SETTINGS_KEYS = {
  USER_SETTINGS: "user_settings",
  ROLE_ADDRESS_CONFIG: "role_address_config",
} as const;

export const JWT_DEFAULTS = {
  ADDRESS_TTL_DAYS: 90,
} as const;

/** 地址 JWT 载荷（核心类型，worker core/auth 与调用方共用；签名者/校验者各自按需取字段） */
export interface AddressJwtPayload {
  address: string;
  address_id: number;
  exp?: number;
}

/** 前端 API 路径前缀（createApiClient 的 JSDoc 标注用；运行时不引用） */
export type ApiPath =
  | "/api"
  | "/user_api"
  | "/admin"
  | "/open_api"
  | "/telegram"
  | "/external"
  | "/api/unified"
  | "/admin/unified";
```

  （`AddressJwtPayload` 为唯一来源：`core/auth.ts` 与 `address_token.ts` 均从本包 `import type`，不再各自内联 interface。聚合器 ingest 契约的 `IngestBody` 类型化留待 Task 9 docs 以文本形式固化——其真实键序在 Task 6 的 17 列 INSERT 处 recon，且 aggregator 是独立 Python 代码库，无运行时共享，不做跨语言类型化。）

- [ ] **Step 3: 建根 workspace** — 根 `package.json`：

```json
{
  "name": "one-mail",
  "private": true,
  "packageManager": "pnpm@10.6.0",
  "devDependencies": { "typescript": "^5.6.0" }
}
```

根 `pnpm-workspace.yaml`（注意 telegraf patch 从 worker/package.json 移到这里）：

```yaml
packages:
  - "worker"
  - "frontend"
  - "packages/shared"
patchedDependencies:
  telegraf@4.16.3: worker/patches/telegraf@4.16.3.patch
```

- [ ] **Step 4: 重命名 worker/frontend 包名 + 挂 shared 依赖**
  - `worker/package.json`: `"name": "@one-mail/worker"`；**删除** `pnpm.patchedDependencies` 块（已移到根）；`dependencies` 加 `"@one-mail/shared": "workspace:*"`。
  - `frontend/package.json`: `"name": "@one-mail/frontend"`；`devDependencies` 加 `"@one-mail/shared": "workspace:*"`。
  - 验证：`grep -rn "cloudflare_temp_email" worker/package.json frontend/package.json` → 无命中（`.github` 里的上游名不动）。

- [ ] **Step 5: 根安装 + 构建 shared + 跑冒烟**
  - 根执行 `pnpm install`（会把 workspace 各包 link 进 node_modules，telegraf patch 生效）。
  - `pnpm --filter @one-mail/shared build` → `packages/shared/dist/index.js` 与 `.d.ts` 出现。
  - `cd worker && node --experimental-strip-types --test src/core/resolution-smoke.test.mjs` → PASS（证明 node 经 worker/node_modules 符号链接解析到 shared/dist）。
  - `cd worker && pnpm build`（wrangler dry-run）→ 无错（证明 esbuild 也解析 shared）。
  - `cd frontend && pnpm build:pages` → 无错（vite 容忍未使用的 devDep）。

- [ ] **Step 6: 报告** — 记录：install/build 结果、冒烟 PASS 输出、telegraf patch 迁移是否生效（`ls node_modules/.pnpm | grep telegraf` 出现 patched 标记）。**不 commit**。

---

### Task 2: `core/auth.ts` — 地址 JWT 签发/校验抽象 + 单测

**Files:**
- Create: `worker/src/core/auth.ts`、`worker/src/core/auth.test.mjs`
- Modify: `worker/src/unified/address_token.ts`（改为 re-export）

**Interfaces:**
- Produces: `signAddressJwt(c, {address, address_id}) => Promise<string>`、`verifyAddressJwt(c, token) => Promise<AddressJwtPayload | null>`、`addressJwtExpSeconds(c) => number`。Task 3/4 消费。
- Consumes: `@one-mail/shared` 的 `JWT_DEFAULTS`（不引 utils/address_token，防循环）。

- [ ] **Step 1: 写失败单测** — `worker/src/core/auth.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { Jwt } from "hono/utils/jwt";
import { addressJwtExpSeconds, signAddressJwt, verifyAddressJwt } from "./auth.ts";

const daySec = 86400;

test("addressJwtExpSeconds: no env → ~now+90d", () => {
  const before = Math.floor(Date.now() / 1000);
  const exp = addressJwtExpSeconds({ env: {} });
  const after = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(exp - (before + 90 * daySec)) <= 2, `exp=${exp} before=${before}`);
  assert.ok(exp <= after + 90 * daySec + 2);
});

test("addressJwtExpSeconds: ADDRESS_JWT_TTL_DAYS=30 → ~now+30d", () => {
  const exp = addressJwtExpSeconds({ env: { ADDRESS_JWT_TTL_DAYS: "30" } });
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(exp - (now + 30 * daySec)) <= 2);
});

test("signAddressJwt → verifyAddressJwt roundtrip", async () => {
  const c = { env: { JWT_SECRET: "test-secret", ADDRESS_JWT_TTL_DAYS: "30" } };
  const token = await signAddressJwt(c, { address: "test@example.com", address_id: 7 });
  const payload = await verifyAddressJwt(c, token);
  assert.equal(payload.address, "test@example.com");
  assert.equal(payload.address_id, 7);
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));
});

test("verifyAddressJwt: garbage token → null", async () => {
  const c = { env: { JWT_SECRET: "test-secret" } };
  assert.equal(await verifyAddressJwt(c, "not-a-jwt"), null);
});

test("verifyAddressJwt: wrong secret → null", async () => {
  const token = await signAddressJwt({ env: { JWT_SECRET: "a" } }, { address: "x", address_id: 1 });
  assert.equal(await verifyAddressJwt({ env: { JWT_SECRET: "b" } }, token), null);
});

test("verifyAddressJwt: REJECT_EXPLESS_JWT=true rejects exp-less, false accepts", async () => {
  const token = await Jwt.sign({ address: "x", address_id: 1 }, "test-secret", "HS256");
  const strict = { env: { JWT_SECRET: "test-secret", REJECT_EXPLESS_JWT: "true" } };
  assert.equal(await verifyAddressJwt(strict, token), null);
  const lenient = { env: { JWT_SECRET: "test-secret" } };
  assert.equal((await verifyAddressJwt(lenient, token)).address, "x");
});
```

- [ ] **Step 2: 跑测试确认失败** — `cd worker && node --experimental-strip-types --test src/core/auth.test.mjs` → FAIL（auth.ts 不存在）。

- [ ] **Step 3: 实现 `core/auth.ts`**：

```ts
import { Context } from "hono";
import { Jwt } from "hono/utils/jwt";
import type { AddressJwtPayload } from "@one-mail/shared";
import { JWT_DEFAULTS } from "@one-mail/shared";

/**
 * 地址 JWT（邮箱客户端长期凭据）签发/校验统一抽象（架构重构 P2，灭 T1+T2）。
 * 仅引 hono + @one-mail/shared，零相对 import（项目测试约束）。
 * AddressJwtPayload 类型来自 @one-mail/shared（唯一来源，不在此内联）。
 *
 * 与原实现行为等价：
 *  - addressJwtExpSeconds 逻辑自 unified/address_token.ts 迁入（该文件改为 re-export）
 *  - REJECT_EXPLESS_JWT 语义与 worker.ts 中间件一致（getBooleanValue：true/"true"→真）
 *  - verify 内部 try/catch → 失效返回 null；调用方按 null 处理（与原 catch 语义等价）
 */

const boolEnv = (v: unknown): boolean =>
  typeof v === "boolean" ? v : typeof v === "string" ? v === "true" : false;

export const addressJwtExpSeconds = (c: Context): number => {
  const daysRaw = (c.env as any)?.ADDRESS_JWT_TTL_DAYS;
  const days = typeof daysRaw === "number" ? daysRaw
    : typeof daysRaw === "string" && daysRaw.trim() ? Number(daysRaw)
    : JWT_DEFAULTS.ADDRESS_TTL_DAYS;
  const validDays = (typeof days === "number" && days > 0 && Number.isFinite(days))
    ? days : JWT_DEFAULTS.ADDRESS_TTL_DAYS;
  return Math.floor(Date.now() / 1000) + Math.floor(validDays * 86400);
};

export const signAddressJwt = async (
  c: Context,
  payload: { address: string; address_id: number },
): Promise<string> => {
  return await Jwt.sign({ ...payload, exp: addressJwtExpSeconds(c) }, c.env.JWT_SECRET, "HS256");
};

export const verifyAddressJwt = async (
  c: Context,
  token: string,
): Promise<AddressJwtPayload | null> => {
  try {
    const payload = await Jwt.verify(token, c.env.JWT_SECRET, "HS256");
    if (boolEnv((c.env as any)?.REJECT_EXPLESS_JWT) && !payload.exp) return null;
    return payload as AddressJwtPayload;
  } catch {
    return null;
  }
};
```

- [ ] **Step 4: 把 `address_token.ts` 改成 re-export**（保留文档注释）— `worker/src/unified/address_token.ts` 全文替换为：

```ts
import { Context } from "hono";
// 地址 JWT 过期时间的实现与测试已迁至 core/auth.ts（架构重构 P2）。
// 本文件保留为 re-export，避免改动 address_token.test.mjs；清理阶段可删除。
export { addressJwtExpSeconds } from "../core/auth.ts";
// 让 callers 的 `import { addressJwtExpSeconds } from './address_token'` 的
// 类型推断仍带 Context 参数（re-export 即够）。保留一行防未使用 import 告警：
export type { Context };
```

- [ ] **Step 5: 跑测试确认全绿** — `cd worker && node --experimental-strip-types --test src/core/auth.test.mjs src/unified/address_token.test.mjs` → 全 PASS（新 6 测 + 原 address_token 2 测）。

- [ ] **Step 6: 报告** — 记录：auth.test 6 项 PASS、address_token.test 仍绿、`pnpm build` 通过。**不 commit**。

---

### Task 3: 替换 4 处地址 JWT 签发点（sign → core/auth）

**Files:**
- Modify: `worker/src/common.ts:449`、`worker/src/mails_api/address_auth.ts:77`、`worker/src/user_api/bind_address.ts:173`、`worker/src/admin_api/address_api.ts:154`

**Interfaces:**
- Consumes: `signAddressJwt`（Task 2）。

- [ ] **Step 1: common.ts** — 将 `import { addressJwtExpSeconds } from './unified/address_token'` 改为 `import { signAddressJwt } from './core/auth'`；`const jwt = await Jwt.sign({ address, address_id, exp: addressJwtExpSeconds(c) }, c.env.JWT_SECRET, "HS256")` 改为 `const jwt = await signAddressJwt(c, { address, address_id })`；确认该文件不再用 `Jwt`/`addressJwtExpSeconds` 则删对应 import（`Jwt` 若无其它用途一并删 `import { Jwt } from 'hono/utils/jwt'`）。
- [ ] **Step 2: address_auth.ts** — import 加 `signAddressJwt`；`const jwt = await Jwt.sign({ address: address.name, address_id: address.id, exp: addressJwtExpSeconds(c) }, c.env.JWT_SECRET, "HS256")` → `const jwt = await signAddressJwt(c, { address: address.name, address_id: address.id })`；删 `addressJwtExpSeconds`/`Jwt` 若不再用。
- [ ] **Step 3: bind_address.ts** — 同上，`{ address: name, address_id }`（name 是 `SELECT name FROM address` 的标量）。
- [ ] **Step 4: address_api.ts** — 同上，`{ address: name, address_id: id }`。
- [ ] **Step 5: 验证** — `grep -rn "Jwt.sign" worker/src --include="*.ts"` 应**只剩** user/role/passkey/oauth2 的非地址 JWT（settings.ts / passkey.ts / oauth2.ts / user.ts），地址 4 处清零。`cd worker && pnpm build` 通过。
- [ ] **Step 6: 报告** — 记录每处改动 + grep 结果。**不 commit**。

---

### Task 4: 替换 6 处地址 JWT 校验点（verify → core/auth）

**Files:**
- Modify: `worker/src/worker.ts:190-197`、`worker/src/telegram_api/common.ts:66,90,115`、`worker/src/telegram_api/miniapp.ts:72`、`worker/src/mails_api/send_mail_api.ts:267`

**Interfaces:**
- Consumes: `verifyAddressJwt`（Task 2）。语义：失效/被 REJECT_EXPLESS 拒 → `null`；调用方把原 `catch`/无 address 分支统一映射到 `null` 分支。

- [ ] **Step 1: worker.ts 地址中间件（:174-197）** — 保留头部解析（Authorization 头、Bearer 格式），把 `const payload = await Jwt.verify(parts[1], c.env.JWT_SECRET, "HS256"); if (getBooleanValue(c.env.REJECT_EXPLESS_JWT) && !payload.exp) {...401}` 整段替换为：

```ts
		const payload = await verifyAddressJwt(c, parts[1]);
		if (!payload) {
			const lang = c.get("lang") || c.env.DEFAULT_LANG;
			const msgs = i18n.getMessages(lang);
			return c.text(msgs.InvalidAddressCredentialMsg, 401);
		}
		c.set("jwtPayload", payload as JwtPayload);
		await next();
		return;
```

  删掉原 `try/catch` 里的 `Jwt.verify`+`console.warn`（verifyAddressJwt 已内部 catch 返回 null）；保留 try/catch 外壳则改为空 catch 或整体去掉——以不再出现 `Jwt.verify` 为准。worker.ts 顶部 `import { verifyAddressJwt } from './core/auth'`。

- [ ] **Step 2: telegram_api/common.ts:66（jwtListToAddressData）** — `const { address, address_id } = await Jwt.verify(jwt, c.env.JWT_SECRET, "HS256");` 改为：

```ts
			const payload = await verifyAddressJwt(c, jwt);
			if (!payload) {
				addressList.push(msgs.TgInvalidCredentialMsg);
				invalidJwtList.push(jwt);
				continue;
			}
			const { address, address_id } = payload;
```

- [ ] **Step 3: telegram_api/common.ts:90（bindTelegramAddress）** — 改为：

```ts
	const payload = await verifyAddressJwt(c, jwt);
	if (!payload || !payload.address) {
		throw Error(msgs.TgInvalidCredentialMsg);
	}
	const { address } = payload;
```

- [ ] **Step 4: telegram_api/common.ts:115（unbindTelegramAddress）** — try/catch 内的 `const { address: kvAddress } = await Jwt.verify(jwt, ...); if (kvAddress == address) continue;` 改为：

```ts
		const payload = await verifyAddressJwt(c, jwt);
		if (payload && payload.address == address) {
			continue;
		}
```

  （`!payload` 落到下方 `newJwtList.push(jwt)`，与原 catch→push 等价。）

- [ ] **Step 5: miniapp.ts:72** — `const { address } = await Jwt.verify(jwt, ...); res.push({ address, jwt });` 改为：

```ts
				const payload = await verifyAddressJwt(c, jwt);
				if (!payload) continue;
				res.push({ address: payload.address, jwt });
```

- [ ] **Step 6: send_mail_api.ts:267（/external/api/send_mail）** — try 内改为：

```ts
		const payload = await verifyAddressJwt(c, token);
		if (!payload) {
			throw new Error(msgs.AddressNotFoundMsg);
		}
		const { address } = payload;
```

  （失效 token 进 catch 返回 `Failed to send mail ...` 400——消息措辞变化，语义同原 catch。）

- [ ] **Step 7: 验证** — `grep -rn "Jwt.verify" worker/src --include="*.ts"` 应只剩 user/role/passkey/challenge/credential 的非地址校验（worker.ts:115,134,229,265、passkey.ts、unified/index.ts:23、open_api/auth.ts:77）。地址校验点清零。`cd worker && pnpm build` 通过。

- [ ] **Step 8: 报告** — 记录 6 处改动 + grep 结果 + 任何消息措辞变化。**不 commit**。

---

### Task 5: `core/settings.ts` — settings 读写单源 + 接入 utils/quota

**Files:**
- Create: `worker/src/core/settings.ts`、`worker/src/core/settings.test.mjs`
- Modify: `worker/src/utils.ts`、`worker/src/quota.ts`

**Interfaces:**
- Produces: `getSetting(c, key) => Promise<string|null>`、`saveSetting(c, key, value) => Promise<void>`、`deleteSetting(c, key) => Promise<void>`、`getJsonSetting<T>(c, key) => Promise<T|null>`。
- Consumes: 无相对 import（仅 hono）。`quota.ts` 以 `./core/settings.ts` 显式扩展名相对 import（Global Constraints 允许）。

- [ ] **Step 1: 写失败单测** — `worker/src/core/settings.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { getSetting, saveSetting, getJsonSetting, deleteSetting } from "./settings.ts";

const makeDb = (rows = {}) => {
  const calls = [];
  const prepare = (sql) => ({
    bind: (...args) => ({
      first: async (col) => { calls.push({ sql, args }); return rows[col] ?? null; },
      run: async () => { calls.push({ sql, args }); return { success: true }; },
    }),
  });
  return { db: { prepare }, calls };
};

test("getSetting returns value row", async () => {
  const { db } = makeDb({ value: "hello" });
  assert.equal(await getSetting({ env: { DB: db } }, "user_settings"), "hello");
});

test("getSetting missing → null", async () => {
  const { db } = makeDb({});
  assert.equal(await getSetting({ env: { DB: db } }, "missing"), null);
});

test("getJsonSetting parses JSON", async () => {
  const { db } = makeDb({ value: '{"maxAddressCount":5}' });
  assert.deepEqual(await getJsonSetting({ env: { DB: db } }, "user_settings"), { maxAddressCount: 5 });
});

test("getJsonSetting bad JSON → null", async () => {
  const { db } = makeDb({ value: "{oops" });
  assert.equal(await getJsonSetting({ env: { DB: db } }, "user_settings"), null);
});

test("saveSetting runs INSERT OR REPLACE", async () => {
  const { db, calls } = makeDb();
  await saveSetting({ env: { DB: db } }, "k", "v");
  assert.ok(calls[0].sql.includes("INSERT or REPLACE INTO settings"));
});
```

- [ ] **Step 2: 跑测试确认失败** — `cd worker && node --experimental-strip-types --test src/core/settings.test.mjs` → FAIL。

- [ ] **Step 3: 实现 `core/settings.ts`**（SQL 与 utils.ts 现状逐字一致）：

```ts
import { Context } from "hono";

/**
 * settings 表读写唯一实现（架构重构 P3，灭 T3）。
 * 仅引 hono、零相对 import。utils.ts 原实现改为 re-export 本模块；
 * quota.ts 以显式 .ts 扩展名相对 import 复用。
 * 行为与 utils.ts 原实现等价（含 DB 错→null 的 fail-soft）。
 */

export const getSetting = async (
  c: Context,
  key: string,
): Promise<string | null> => {
  try {
    const value = await c.env.DB.prepare(
      `SELECT value FROM settings where key = ?`,
    ).bind(key).first<string>("value");
    return value;
  } catch (error) {
    console.error(`GetSetting: Failed to get ${key}`, error);
    return null;
  }
};

export const saveSetting = async (
  c: Context,
  key: string,
  value: string,
): Promise<void> => {
  await c.env.DB.prepare(
    `INSERT or REPLACE INTO settings (key, value) VALUES (?, ?)`
      + ` ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
  ).bind(key, value, value).run();
};

export const deleteSetting = async (
  c: Context,
  key: string,
): Promise<void> => {
  await c.env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(key).run();
};

export const getJsonSetting = async <T = any>(
  c: Context,
  key: string,
): Promise<T | null> => {
  const value = await getSetting(c, key);
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch (e) {
    console.error(`GetJsonSetting: Failed to parse ${key}`, e);
    return null;
  }
};
```

- [ ] **Step 4: utils.ts 改为 re-export** — `import { getSetting, saveSetting, getJsonSetting, deleteSetting } from './core/settings.ts'`（显式扩展名）；**删除** utils.ts 里 4 个同名函数体（getSetting/saveSetting/deleteSetting/getJsonSetting）；`export default {...}` 对象保留引用（`getSetting, saveSetting, getJsonSetting` 已是 import 进来的名字，default 对象照用）。确认 `getJsonObjectValue` 仍在（它没动）。
- [ ] **Step 5: quota.ts 复用 core** — 顶部 `import { getJsonSetting } from './core/settings.ts';`（显式扩展名）；**删除** `getJsonSettingLocal` 定义与 `ROLE_ADDRESS_CONFIG_KEY`/`USER_SETTINGS_KEY` 内联字面量；`getMaxAddressCount`/`getMaxMailAccountCount` 里 `getJsonSettingLocal(c, ROLE_ADDRESS_CONFIG_KEY)` 改为 `getJsonSetting(c, ROLE_ADDRESS_CONFIG_KEY)`，`ROLE_ADDRESS_CONFIG_KEY` 从 `@one-mail/shared` 的 `SETTINGS_KEYS` import。保留 quota.ts 顶部注释里「内联常量须与 constants 同步」的提醒改为「键值以 @one-mail/shared 为准」。
- [ ] **Step 6: 验证** — `cd worker && node --experimental-strip-types --test src/core/settings.test.mjs src/unified/utils_quota.test.mjs` → 全 PASS（settings 新 5 测 + 原 quota 回归）。`grep -rn "SELECT value FROM settings" worker/src --include="*.ts"` 应只剩 `core/settings.ts` 一处。`cd worker && pnpm build` 通过。
- [ ] **Step 7: 报告** — 记录：utils/quota 改动、SQL 单源确认、quota 测试未破坏。**不 commit**。

---

### Task 6: `core/ingest.ts` + `core/mail-list.ts` — emails INSERT 与 raw_mails 列表单源

**Files:**
- Create: `worker/src/core/ingest.ts`、`worker/src/core/mail-list.ts`、`worker/src/core/ingest.test.mjs`
- Modify: `worker/src/unified/ingest.ts`、`worker/src/unified/unified_store.ts`、`worker/src/mails_api/mails_crud.ts`、`worker/src/mails_api/parsed_mail_api.ts`、`worker/src/user_api/user_mail_api.ts`

**Interfaces:**
- Produces: `INSERT_EMAIL_SQL`（17 列，与现存两处 INSERT 逐字一致）、`insertEmail(c, params: unknown[]) => Promise<void>`、`listRawMails(c, address, opts?: {limit?:number; offset?:number}) => Promise<any[]>`、`countRawMails(c, address) => Promise<number>`。

- [ ] **Step 1: 读现状确认列清单** — 逐字对比 `worker/src/unified/ingest.ts` 的 INSERT_SQL 与 `worker/src/unified/unified_store.ts` 的 INSERT SQL：**两者 17 列与参数顺序必须完全一致**。若有差异，以两者共同子集为准并在报告中标明（预期一致）。
- [ ] **Step 2: 写失败单测** — `worker/src/core/ingest.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { INSERT_EMAIL_SQL, insertEmail } from "./ingest.ts";

test("INSERT_EMAIL_SQL has 17 placeholders", () => {
  const placeholders = (INSERT_EMAIL_SQL.match(/\?/g) || []).length;
  assert.equal(placeholders, 17);
});

test("insertEmail binds params in order", async () => {
  const calls = [];
  const db = { prepare: (sql) => ({ bind: (...args) => { calls.push({ sql, args }); return { run: async () => ({ success: true }) }; } }) };
  const params = Array.from({ length: 17 }, (_, i) => `p${i}`);
  await insertEmail({ env: { DB: db } }, params);
  assert.equal(calls[0].args.length, 17);
  assert.equal(calls[0].args[0], "p0");
  assert.equal(calls[0].args[16], "p16");
});
```

- [ ] **Step 3: 实现 `core/ingest.ts`**：

```ts
import { Context } from "hono";

/** emails 17 列 INSERT 唯一实现（架构重构 P4，灭 T4）。列清单须与统一收件箱行结构锁步。 */
export const INSERT_EMAIL_SQL = `INSERT INTO emails
  (id, source, account_id, from_addr, to_addr, subject, text_body, html_body,
   received_at, internal_date, headers_json, is_read, flags_json, attachments_json,
   raw_ref, imap_uid, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export const insertEmail = async (
  c: Context,
  params: unknown[],
): Promise<void> => {
  await c.env.DB.prepare(INSERT_EMAIL_SQL).bind(...params).run();
};
```

- [ ] **Step 4: 接入两处 INSERT**
  - `worker/src/unified/ingest.ts`：删其 `INSERT_SQL` 常量；`c.env.DB.prepare(INSERT_SQL).bind(...params).run()` → `await insertEmail(c, params)`；加 `import { insertEmail } from '../core/ingest.ts'`。
  - `worker/src/unified/unified_store.ts`：删其 INSERT SQL；调用处 → `await insertEmail(c, params)`（params 为 17 元顺序数组，来自 buildUnifiedEmailRow 转换）；加同 import。
  - 两处调用点确认不破坏 `toEmailInsertParams`（ingest）与 `buildUnifiedEmailRow`（store）的既有输出——它们仍是纯函数，只把「执行 INSERT」的 SQL 换成 core 的。
- [ ] **Step 5: 实现 `core/mail-list.ts`**：

```ts
import { Context } from "hono";

/** raw_mails 列表/计数唯一实现（架构重构 P4，灭 T4）。 */
export const listRawMails = async (
  c: Context,
  address: string,
  opts?: { limit?: number; offset?: number },
): Promise<any[]> => {
  if (opts?.limit) {
    const rows = await c.env.DB.prepare(
      `SELECT * FROM raw_mails WHERE address = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).bind(address, opts.limit, opts.offset ?? 0).all();
    return rows.results;
  }
  const rows = await c.env.DB.prepare(
    `SELECT * FROM raw_mails WHERE address = ? ORDER BY id DESC`,
  ).bind(address).all();
  return rows.results;
};

export const countRawMails = async (
  c: Context,
  address: string,
): Promise<number> => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM raw_mails WHERE address = ?`,
  ).bind(address).first<{ c: number }>();
  return row?.c ?? 0;
};
```

- [ ] **Step 6: 接入 3 处 raw_mails** — 逐一读 `mails_crud.ts:17-18`、`parsed_mail_api.ts:31-32`、`user_mail_api.ts`（列表+count 两段），把各自 `SELECT * FROM raw_mails WHERE address = ?` + count 换成 `listRawMails(c, address, {limit})`/`countRawMails(c, address)`。**若某处原 SQL 的 ORDER BY / 分页与 core 不一致**：以 opts 覆盖；若仍无法等价，保留该处原 SQL 并在报告中标明（不强行替换）。
- [ ] **Step 7: 验证** — `cd worker && node --experimental-strip-types --test src/core/ingest.test.mjs src/unified/ingest.test.mjs src/unified/unified_store.test.mjs` → 全 PASS。`grep -rn "INSERT INTO emails" worker/src --include="*.ts"` 应只剩 `core/ingest.ts` 一处。`grep -rn "FROM raw_mails" worker/src --include="*.ts"` 应只剩 `core/mail-list.ts`。`cd worker && pnpm build` 通过。
- [ ] **Step 8: 报告** — 记录：列清单比对结果、5 处接入、SQL 单源 grep 确认。**不 commit**。

---

### Task 7: 前端 `api/index.js` — 4 wrapper 收敛为 `createApiClient` 工厂

**Files:**
- Modify: `frontend/src/api/index.js`

**Interfaces:**
- Produces: 内部 `createApiClient(headerInjector, hooks)` 工厂；`api` 导出形状不变（所有 view 的 `import { api }` 不受影响）。

- [ ] **Step 1: 定义工厂** — 在 `instance` 定义后插入（替换 4 个 wrapper 的公共骨架）：

```js
// 统一请求核心（架构重构 P5）：4 个 wrapper 收敛为 1 个工厂。
// headerInjector: () => headers（每次请求调用，取 .value 现值）；
// hooks: { onRequest?, onDone?, onUnauthorized? }（apiFetch 专用 loading/401 弹窗行为）。
const createApiClient = (headerInjector, hooks = {}) => {
  const request = async (path, options = {}) => {
    hooks.onRequest && hooks.onRequest();
    try {
      const headers = {
        'Content-Type': 'application/json',
        ...(headerInjector() || {}),
        ...(options.headers || {}),
      };
      const response = await instance.request(path, {
        method: options.method || 'GET',
        data: options.body || null,
        headers,
      });
      if (response.status === 401 && hooks.onUnauthorized) {
        hooks.onUnauthorized(response);
      }
      if (response.status >= 300) {
        const detail = response.data && typeof response.data === 'object'
          ? response.data.error || JSON.stringify(response.data)
          : response.data;
        throw new Error(`Code ${response.status}: ${detail || "error"}`);
      }
      return response.data;
    } finally {
      hooks.onDone && hooks.onDone();
    }
  };
  return {
    get: (p, o) => request(p, { ...o, method: 'GET' }),
    post: (p, o) => request(p, { ...o, method: 'POST' }),
    put: (p, o) => request(p, { ...o, method: 'PUT' }),
    delete: (p, o) => request(p, { ...o, method: 'DELETE' }),
    request,
  };
};
```

- [ ] **Step 2: 定义 4 个 client** — 用现有 store 值构造：

```js
// apiFetch：全通道（x-user-token / x-user-access-token / x-custom-auth / x-admin-auth / Authorization）+ loading + 401 弹窗。
// 注：指纹是异步获取、只在此通道用——siteClient 不挂指纹，fingerprint 由 Step 3 的 apiFetch 包装层注入。
const siteClient = createApiClient(() => {
  const h = { 'x-lang': i18n.global.locale.value };
  const put = (k, v) => { const s = safeHeaderValue(v); if (s) h[k] = s; };
  put('x-user-token', userJwt.value);
  put('x-user-access-token', userSettings.value.access_token);
  put('x-custom-auth', auth.value);
  put('x-admin-auth', adminAuth.value);
  const authz = safeBearerHeader(jwt.value);
  if (authz) h['Authorization'] = authz;
  return h;
}, {
  onRequest: () => { loading.value = true; },
  onDone: () => { loading.value = false; },
  onUnauthorized: (r) => {
    if (r.config.url && r.config.url.startsWith("/admin")) showAdminAuth.value = true;
    if (openSettings.value.needAuth) showAuth.value = true;
  },
});
// unified（Bearer API-key 单通道）
const unifiedClient = createApiClient(() => {
  const b = safeBearerHeader(unifiedApiKey.value);
  if (!b) throw new Error("unified api key not set");
  return { 'Authorization': b };
});
// unified user（x-user-token 单通道）
const unifiedUserClient = createApiClient(() => {
  const t = safeHeaderValue(userJwt.value);
  if (!t) throw new Error("not logged in");
  return { 'x-user-token': t };
});
// unified 双通道派发
const unifiedAuthClient = createApiClient(() => safeHeaderValue(userJwt.value)
  ? unifiedUserClient.headers() : unifiedClient.headers());
```

  **fingerprint 处理**：`getFingerprint()` 是异步的、只在 apiFetch 用。把指纹获取放到 `siteClient` 的 headerInjector 外——方案：`siteClient` 包一层 async 包装（见 Step 3 的 `apiFetch` 改写），保持 `await getFingerprint()` 后再发请求的原行为。

- [ ] **Step 3: 重写 `apiFetch`** — 保留原函数名与导出（`api.fetch = apiFetch`），函数体替换为：

```js
const apiFetch = async (path, options = {}) => {
  loading.value = true;
  try {
    const fingerprint = await getFingerprint();
    const headers = {
      'x-lang': i18n.global.locale.value,
      'x-fingerprint': fingerprint,
      'Content-Type': 'application/json',
    };
    const put = (k, v) => { const s = safeHeaderValue(v); if (s) headers[k] = s; };
    put('x-user-token', options.userJwt || userJwt.value);
    put('x-user-access-token', userSettings.value.access_token);
    put('x-custom-auth', auth.value);
    put('x-admin-auth', adminAuth.value);
    const authz = safeBearerHeader(jwt.value);
    if (authz) headers['Authorization'] = authz;
    return await siteClient.request(path, { ...options, headers });
  } finally {
    loading.value = false;
  }
};
```

  （`siteClient.request` 内部不再重复 loading/401——那些 hooks 仅在直接调 `siteClient.get/post/...` 时生效；`apiFetch` 保持原 loading/fingerprint 语义。）
- [ ] **Step 4: 重写 `unifiedFetch` / `unifiedUserFetch` / `unifiedAuthFetch`** — 三者为纯转发：

```js
const unifiedFetch = (path, options = {}) => unifiedClient.request(path, options);
const unifiedUserFetch = (path, options = {}) => unifiedUserClient.request(path, options);
const unifiedAuthFetch = (path, options = {}) =>
  safeHeaderValue(userJwt.value)
    ? unifiedUserFetch(path, options)
    : unifiedFetch(path, options);
```

  注意 `unifiedFetch` 原语义：无 API-key → `throw new Error("unified api key not set")`（已迁进 `unifiedClient` 的 headerInjector）；`unifiedUserFetch` 无登录 → `throw new Error("not logged in")`（已迁进 `unifiedUserClient`）。
- [ ] **Step 5: 全部方法换用 client** — `export const api = {...}` 里每个方法：`apiFetch('/x', {method:'DELETE'})` → `siteClient.delete('/x')`；`apiFetch('/x', {method:'POST'})` → `siteClient.post('/x')`；`apiFetch('/x', {method:'PUT'})` → `siteClient.put('/x')`；`apiFetch('/x')` → `siteClient.get('/x')`。`unified.*` 方法改用 `unifiedClient` / `unifiedUserClient` / `unifiedAuthClient`（按 header 语义选择，或沿用 `unifiedAuthFetch`/`unifiedUserFetch`/`unifiedFetch` 转发函数）。保持 `api.fetch = apiFetch` 不动。
- [ ] **Step 6: 验证** — `grep -n "instance.request" frontend/src/api/index.js` 应只剩工厂内 1 处；`grep -n "status >= 300" frontend/src/api/index.js` 应只剩工厂内 1 处。`cd frontend && pnpm build:pages` 通过；`node --check frontend/src/api/index.js` 通过。
- [ ] **Step 7: 报告** — 记录：工厂代码、4 client 定义、方法映射表、grep 单源确认、build 结果。**不 commit**。

---

### Task 8: 前端 store 管理页判定收敛 + api/index.js 挂共享类型 JSDoc

**Files:**
- Modify: `frontend/src/store/index.js`、`frontend/src/api/index.js`

**Interfaces:**
- Consumes: `@one-mail/shared`（JSDoc 类型标注，运行时零引用）。

- [ ] **Step 1: store 管理页判定** — 读 `store/index.js:138-142` 的 `showAdminPage`。把「表达式就地」改为具名判断函数并加注释说明来源：

```js
// 管理面板可见性：后端告知的策略信号（adminAuth=已输管理密码；is_admin=角色；disableAdminPasswordCheck=后端开关）。
// 表达式集中于一处，避免多处重演（架构重构 P5）。
const showAdminPage = computed(() =>
  !!adminAuth.value
  || userSettings.value.is_admin === true
  || openSettings.value.disableAdminPasswordCheck === true
);
```

  **行为零变化**：仅补 `=== true` 显式比较（原 truthy 判断语义等价），不新增/删减任一条件。
- [ ] **Step 2: api/index.js 挂共享类型** — 文件顶部加：

```js
// 契约类型来自 @one-mail/shared（架构重构 P5）：运行时零引用，仅供 JSDoc 标注。
// ApiPath 已由 shared 导出（Task 1 定义），此处引用即可，勿重新声明。
```

  并在 `createApiClient` 的 `request` 参数上补 JSDoc：

```js
/** @param {import('@one-mail/shared').ApiPath} path 请求路径 */
```

  （可选，不强求 `ApiPath` 全量标注——FE 保持 JS 且不转 TS；标注目的仅是让 IDE 提示可用前缀。）
- [ ] **Step 3: 验证** — `cd frontend && pnpm build:pages` 通过；dev 打开任一页管理面板切换不回归（人工/浏览器冒烟可选）。
- [ ] **Step 4: 报告** — 记录 store 改动 diff + build 结果。**不 commit**。

---

### Task 9: 清理残留 + 双语 CHANGELOG + docs

**Files:**
- Modify: `worker/src/utils.ts`（如有死 re-export）、`worker/src/common.ts`（如残留 `addressJwtExpSeconds` import）、`CHANGELOG.md`、`CHANGELOG_EN.md`、`vitepress-docs/docs/zh/guide/worker-vars.md`、`vitepress-docs/docs/en/guide/worker-vars.md`、`vitepress-docs/docs/zh/guide/ui/frontend-dev.md`、`vitepress-docs/docs/en/guide/ui/frontend-dev.md`

- [ ] **Step 1: 残留 grep** — 确认：
  - `grep -rn "Jwt.sign\|Jwt.verify" worker/src --include="*.ts"` 只剩非地址 JWT（Task 3/4 验收过的清单）。
  - `grep -rn "getJsonSettingLocal" worker/src --include="*.ts"` → 0 命中。
  - `grep -rn "SELECT value FROM settings\|INSERT INTO emails\|FROM raw_mails" worker/src --include="*.ts"` 各只剩 core 单源。
  - `grep -rn "addressJwtExpSeconds" worker/src --include="*.ts"`：应只剩 core/auth.ts + address_token.ts re-export + 各 sign 调用点（若 Task 3 已改用 signAddressJwt，sign 点不再直接引 addressJwtExpSeconds——按实际确认）。
  - 若 `worker/src/unified/address_token.ts` 已无生产调用方（仅测试引用），**删除该文件 + 其 test**，测试并入 core/auth.test.mjs（确认无遗漏引用后）。
- [ ] **Step 2: 清理死 import** — `common.ts`/`address_auth.ts` 等如残留未用的 `Jwt`/`addressJwtExpSeconds` import，删除（`pnpm lint` 会揪出）。
- [ ] **Step 3: CHANGELOG** — `CHANGELOG.md`（中文）+ `CHANGELOG_EN.md`（英文）`(main)` 段各加一条：

```markdown
- refactor: |架构| 原位 monorepo（pnpm workspace + packages/shared 共享契约包）；worker 抽 core/ 精炼层（地址 JWT 签发/校验、settings 读写、emails INSERT、raw_mails 列表单源）；前端 4 个鉴权 wrapper 收敛为 createApiClient 工厂（线上行为零变化）
```

- [ ] **Step 4: docs** — `worker-vars.md` zh/en：`REJECT_EXPLESS_JWT` 与 `ADDRESS_JWT_TTL_DAYS` 的说明补一句「校验逻辑统一在 worker core/auth（原散落多处）」；`frontend-dev.md` zh/en：构建前置补「需先在仓库根 `pnpm install`（monorepo workspace），`pnpm --filter @one-mail/shared build` 后再构建前端」。
- [ ] **Step 5: 全量验证** — `cd worker && pnpm lint && pnpm build`；`node --experimental-strip-types --test src/core/*.test.mjs src/unified/*.test.mjs src/user_api/*.test.mjs src/email/*.test.mjs` 全绿（14 原测 + 新 core 测）；`cd frontend && pnpm build:pages` 通过；`cd aggregator && .venv/bin/python -m pytest tests/ -q` 全绿（确认未破坏聚合器）。
- [ ] **Step 6: 报告** — 全量结果 + 残留 grep 汇总 + 是否删了 address_token.ts 的决策。**不 commit**。

---

## 验证矩阵（全计划完成后）

| 检查 | 命令/方式 | 预期 |
|------|----------|------|
| worker 全测 | `cd worker && node --experimental-strip-types --test src/core/*.test.mjs src/unified/*.test.mjs src/user_api/*.test.mjs src/email/*.test.mjs` | 全 PASS（原 14 项 + 新增 core 项） |
| worker lint/build | `cd worker && pnpm lint && pnpm build` | 无错 |
| 前端构建 | `cd frontend && pnpm build:pages` | 通过 |
| 聚合器回归 | `cd aggregator && .venv/bin/python -m pytest tests/ -q` | 全绿 |
| shared 可解析 | `cd worker && node --experimental-strip-types --test src/core/resolution-smoke.test.mjs` | PASS |
| T1/T2 灭除 | `grep -rn "Jwt.sign\|Jwt.verify" worker/src --include="*.ts"` | 只剩非地址 JWT |
| T3 灭除 | `grep -rn "SELECT value FROM settings" worker/src --include="*.ts"` | 只 core/settings.ts |
| T4 灭除 | `grep -rn "INSERT INTO emails\|FROM raw_mails" worker/src --include="*.ts"` | 只 core/ingest.ts + core/mail-list.ts |
| FE 单源 | `grep -n "instance.request\|status >= 300" frontend/src/api/index.js` | 各 1 处（工厂内） |
