# one-mail 开发指南

本文档面向项目维护者、本地开发者和自动化 Agent，目标是用最短路径说明 one-mail 的代码结构、开发环境、测试链路、部署边界和安全约束。

> 约定：所有开发基于最新 `main`；不要直接向 `main` push。新改动应使用独立分支和 Pull Request，并等待 required checks 通过后再合并。

## 1. 系统结构

```text
外部邮箱（QQ / 163 / Gmail / Outlook ...）
        │
        │ IMAP / POP3
        ▼
aggregator/                     Python 3.11+
        │                       VPS 侧拉取、去重、批量 ingest
        │ HTTPS + x-admin-auth
        ▼
worker/                         Cloudflare Worker + Hono + D1
        │
        ├── /api/unified/*      统一收件箱 API
        ├── /admin/unified/*    聚合器/管理 API
        ├── /user_api/*         用户侧 API
        └── /api/* /admin/*     临时邮箱基座与管理能力
        │
        ▼
frontend/                       Vue 3 + Vite + Naive UI
```

主要目录：

| 路径 | 作用 |
| --- | --- |
| `worker/` | Cloudflare Worker API、鉴权、D1 访问、邮件处理、Passkey/OTP 等核心业务 |
| `frontend/` | Vue 前端、统一收件箱与临时邮箱 UI |
| `aggregator/` | VPS 邮件聚合器，负责 IMAP/POP3 拉取与上传 |
| `packages/shared/` | Worker 与 Frontend 共用 TypeScript 包 |
| `db/` | D1 schema 与增量 SQL 迁移 |
| `e2e/` | Docker Compose 驱动的端到端测试 |
| `.github/workflows/` | CI、部署、发布和 PR 自动化 |
| `vitepress-docs/` | 对外功能文档 |
| `docs/` | 开发、设计和专项验收文档 |

## 2. 推荐开发环境

CI 当前使用：

- Node.js 24
- pnpm 10.10.0
- Python 3.11
- Docker / Docker Compose（运行 E2E 时需要）

Aggregator 的 Python 包声明要求 `>=3.11`。

建议首次进入仓库后执行：

```bash
corepack enable
pnpm --version
node --version
python3 --version
pnpm install --frozen-lockfile
```

仓库使用根目录 `pnpm-lock.yaml`。除非正在有意识地更新依赖，否则不要使用 `--no-frozen-lockfile`，也不要在 CI 中动态 `pnpm add` 生产依赖。

## 3. Node workspace

当前 pnpm workspace 包含：

```text
worker
frontend
packages/shared
```

安装全部 Node 依赖：

```bash
pnpm install --frozen-lockfile
```

构建 shared：

```bash
pnpm --filter @one-mail/shared build
```

如果改动 shared，至少同时验证 Worker 和 Frontend，因为两端都会消费它。

## 4. Worker 开发

### 4.1 配置

```bash
cd worker
cp wrangler.toml.template wrangler.toml
```

按本地或测试环境填写 D1/KV/R2 binding 与 vars。真实生产 secret 不应提交到仓库。

### 4.2 启动

```bash
pnpm --filter @one-mail/shared build
cd worker
pnpm dev
```

默认由 Wrangler 启动本地 Worker。

### 4.3 检查与构建

```bash
cd worker
pnpm lint
pnpm build
```

Worker 单测与 CI 保持一致：

```bash
cd worker
node --experimental-strip-types --test \
  src/core/*.test.mjs \
  src/unified/*.test.mjs \
  src/user_api/*.test.mjs \
  src/email/*.test.mjs
```

### 4.4 常见改动入口

| 需求 | 优先查看 |
| --- | --- |
| JWT / 地址身份鉴权 | `worker/src/core/auth.ts` 及对应 user API |
| Passkey | `worker/src/core/passkey_security.ts`、`worker/src/user_api/passkey.ts` |
| 注册验证码 / OTP | `worker/src/user_api/registration_verify_code.ts`、`worker/src/user_api/user.ts` |
| 发信状态 / 幂等 | `worker/src/mails_api/`、相关 core tests |
| 统一收件箱 | `worker/src/unified/` |
| 邮件解析 | `worker/src/email/` |

新增安全相关逻辑时，优先写靠近核心逻辑的回归测试，而不是只依赖 E2E。

## 5. Frontend 开发

### 5.1 配置

```bash
cd frontend
cp .env.example .env.local
```

最常用变量：

```text
VITE_API_BASE=http://127.0.0.1:8787
```

实际值以当前环境为准。

### 5.2 启动

```bash
pnpm --filter @one-mail/frontend dev
```

### 5.3 测试与构建

```bash
pnpm --filter @one-mail/frontend test
pnpm --filter @one-mail/frontend build
pnpm --filter @one-mail/frontend build:pages
```

生产构建和 Pages 构建都应通过后再认为前端改动完整。

## 6. Aggregator 开发

Aggregator 是独立 Python 项目，Python 要求 `>=3.11`。

### 6.1 安装

推荐使用隔离环境：

```bash
cd aggregator
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -e ".[dev]"
```

如果使用 `uv`，仓库也已提交 `aggregator/uv.lock`，应保持 lockfile 与依赖声明一致。

### 6.2 配置

```bash
cp config.example.json config.json
```

不要提交真实邮箱密码、OAuth refresh token、Worker admin secret 等凭据。

### 6.3 测试

```bash
cd aggregator
pytest
```

### 6.4 网络安全边界

Aggregator 接收用户控制的 IMAP/POP3 地址，因此网络目标是安全边界的一部分。

当前实现要求：

- 域名/IP 预检查拒绝私网、loopback、link-local、metadata 等非公网目标；
- 实际 socket connect 阶段再次校验目标地址，用于收口 DNS rebinding / TOCTOU；
- 如使用本地 SOCKS，仅允许项目明确需要的本地代理路径，不得泛化为允许整个 loopback 网段。

项目当前主动接受“不额外部署 VPS 主机级 egress firewall”的残余风险，因此不要删除或弱化进程内 connect-time guard。

## 7. E2E

E2E 位于 `e2e/`，通过 Docker Compose 拉起完整测试环境。

```bash
cd e2e
npm test
```

清理：

```bash
npm run test:down
```

如果改动以下边界，应优先增加/更新 E2E：

- Origin / RP ID / Passkey
- JWT 与用户身份
- 邮件收发主链路
- Worker 与 Frontend 契约
- 聚合器 ingest 契约

不要为了让 E2E 变绿而放宽生产安全规则。测试环境需要特殊 Origin、RP ID 或 host 时，应显式配置测试环境 allowlist。

## 8. 本地提交前的最小验证

普通改动不必每次手动跑所有任务，但提交 PR 前至少覆盖受影响组件。

全量 CI 等价核心命令：

```bash
pnpm install --frozen-lockfile
pnpm --filter @one-mail/shared build

cd worker
node --experimental-strip-types --test src/core/*.test.mjs src/unified/*.test.mjs src/user_api/*.test.mjs src/email/*.test.mjs
cd ..

pnpm --filter @one-mail/frontend test

cd aggregator
python -m pip install --upgrade pip
pip install -e ".[dev]"
pytest
cd ..

printf 'VITE_API_BASE=https://mail-api.mangoqwq.cc.cd\n' > frontend/.env.pages
printf 'VITE_API_BASE=https://mail-api.mangoqwq.cc.cd\n' > frontend/.env.production
pnpm --filter @one-mail/frontend build
pnpm --filter @one-mail/frontend build:pages
```

安全或跨组件改动再运行：

```bash
cd e2e
npm test
```

## 9. 数据库迁移

`db/` 内的 SQL 是生产数据结构的一部分。

规则：

1. 不要静默修改已经在生产执行过的 migration；新增迁移文件。
2. 迁移必须可以解释升级前后的 schema 变化。
3. 涉及删除、重命名、唯一索引或不可逆数据修改时，先明确备份和回滚策略。
4. PR 中同时提交使用新 schema 的代码和验证测试。
5. 生产执行 migration 前先备份 D1。

## 10. 安全不变量

下面这些是当前主线已经建立的安全边界，后续开发不得无意回退：

### 10.1 用户身份与 JWT

- 地址 Bearer token 必须经过 active-address/live binding 校验；
- 不要仅验证 JWT 签名后就信任地址身份；
- 需要 `exp` 的 token 不得改成永久 token。

### 10.2 Passkey

- trusted Origin 与 RP ID 必须由服务端决定；
- request body 不能成为信任锚点；
- challenge 必须随机、有限 TTL、服务端持久化、用途绑定且一次消费；
- 并发消费最多一个请求成功。

### 10.3 注册 OTP

- 禁止使用 `Math.random()` 生成安全验证码；
- OTP 使用 Web Crypto CSPRNG；
- 持久化值不得长期保存明文 OTP；
- 必须有 TTL 和原子 single-use consume。

### 10.4 发信未知状态

外部邮件服务发生 timeout 时，不能假设邮件一定未发送。

- 使用同一个 `x-idempotency-key` 重试；
- unknown 状态不得自动释放额度；
- 管理端明确 resolve 为 `sent` 或 `rejected` 后再终结状态。

### 10.5 SSRF

- IMAP/POP3 用户输入不能直接传给 socket；
- 保留 resolve-time + connect-time 两层目标检查；
- 不要用“测试需要”为理由允许 RFC1918、loopback、link-local 或 metadata 地址。

### 10.6 CI 与 secrets

- GitHub Actions 的第三方 action 使用 immutable commit SHA；
- install/build step 不应无必要持有部署 secrets；
- SSH 部署必须 `StrictHostKeyChecking=yes`；
- `PXED_SSH_KNOWN_HOSTS` 缺失或非法时必须 fail closed；
- 不要恢复运行时 `ssh-keyscan` TOFU。

## 11. Git / PR 工作流

`main` 已由 Repository Ruleset 保护。推荐流程：

```bash
git switch main
git pull --ff-only
git switch -c feat/<topic>
# 修改、测试
git add ...
git commit -m "feat: ..."
git push -u origin feat/<topic>
```

PR 原则：

- 一个主题一个 PR；
- diff 尽量小，不顺手格式化无关文件；
- 合并前同步最新 `main`；
- required checks 全绿后才 merge；
- 不通过 `skip test`、`|| true`、删断言或放宽安全边界解决 CI failure。

安全修复建议提交回归测试，测试名称应描述被修复的失败模式。

## 12. CI / Deploy 说明

主线 workflow `.github/workflows/deploy.yml` 在 PR 和 `main` push 上运行核心 Test & Build：

1. `pnpm install --frozen-lockfile`
2. shared build
3. Worker tests
4. Frontend tests
5. Aggregator tests
6. Frontend production + Pages build

只有 `main` 才继续部署前端到 pxed，并进行线上 health check。

此外仓库还有独立的 backend/frontend/docs/tag/E2E 等 workflows。修改 workflow 时保持：

- 最小 `permissions`；
- immutable action SHA；
- secret 最小暴露范围；
- 失败必须真实返回 non-zero；
- 发布 artifact 与当前 commit/tag 绑定，避免 `releases/latest` 造成版本错配。

## 13. 给自动化 Agent 的执行规则

Agent 在本仓库开发时应遵守：

1. 先读取最新 `main` 和受影响文件，不从旧上下文猜实现。
2. 先定位现有测试，再修改实现。
3. 不重复已经进入主线的 hardening。
4. 不为了绿灯降低鉴权、Origin、RP ID、OTP、SSRF、SSH 等安全边界。
5. 发现额外问题时，只有与当前任务强相关才一并修；否则记录为独立 TODO/issue。
6. 每次提交前检查 `git diff`，确保无无关文件。
7. PR 合并前确认最新 head 的 CI，而不是引用旧 commit 的绿灯。

## 14. 快速定位问题

```bash
# 找 Worker 路由/实现
rg "bind_address|send_mail|passkey|registration" worker/src

# 找 aggregator 网络调用
rg "IMAP|POP3|socket|connect" aggregator/src

# 找 mutable / 动态 CI 行为
rg "uses:|ssh-keyscan|StrictHostKeyChecking|no-frozen-lockfile|pnpm add|releases/latest" .github/workflows

# 找数据库迁移
ls -1 db

# 找测试
find worker/src aggregator/tests frontend/src e2e -type f | grep -E 'test|spec'
```

## 15. 完成定义

一个开发任务只有在以下条件满足后才算完成：

- 实现符合当前架构，不建立第二套控制面；
- 受影响组件测试通过；
- 必要的安全回归测试已补；
- build 通过；
- PR diff 无无关改动；
- required CI checks 对当前 PR head 全绿；
- 文档或配置在行为改变时同步更新。

对于生产安全相关改动，优先选择 fail-closed，而不是静默 fallback。
