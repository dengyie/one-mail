# one-mail 前后端分离设计（修订：线上真相）

> 2026-08-21 · 目标：把「前台页面（frontend/pages）」与「后台 API（worker）」改造成标准化的前后端分离基线 —— 前端命中即直连 worker、删 Pages 代理拓扑、路径契约单一来源。
>
> **修订说明**：原版设计假设线上是 Pages Functions 形态需要迁移。CF API 实测推翻了这一假设 —— **线上根本没有部署任何前端**（见下），因此本任务从「迁移线上拓扑」降级为「改造仓库默认部署形态 + 铲除未来踩坑点」。

## 线上拓扑（CF API 实测，2026-08-21）

| 资源 | 线上实体 | 说明 |
|---|---|---|
| Worker `one-mail` | `mail-api.mangoqwq.cc.cd/*` HTTP route | **one-mail 纯 API**（聚合器打这里）。无 ASSETS。 |
| Worker `cf-temp-mail` | 3 个 zone 的 Email Routing catch-all → 该 worker | **另一套独立收信 worker**（旧临时邮箱），非 one-mail，无 ASSETS、无前端。 |
| Pages projects | **count = 0** | 线上无任何 Pages 部署。 |
| frontend/ + pages/ | 仓库目录，**从未部署** | 三种形态（Pages 代理 / 直连 / ASSETS 一体）线上一条都没跑。 |

**含义**：`pages/functions/_middleware.js` + `pages/wrangler.toml` 的 `[[services]] BACKEND` + `service="one-mail"`（与线上 worker 名 one-mail 不匹配）是**从未生效的空转配置**。「前后端分离」的正确落地 = 面向首次部署：把仓库改成「前端一上线就直连 worker」，而不是迁移一个不存在的线上拓扑。

## 现状耦合点（源码 + 线上实测）

1. **Pages 代理拓扑空转**：`pages/wrangler.toml:7` `service="one-mail"` 在 CF 上查无此名（线上 worker 是 `one-mail`）。`_middleware.js` + service binding 从未被部署使用，维护它就是纯负担。
2. **`API_PATHS` 双份重复**：`worker/src/worker.ts:21-28` 与 `pages/functions/_middleware.js:1-8` 逐字重复 6 前缀，改路径须人肉同步。
3. **前端默认形态是 Pages 代理**：`frontend/.env.pages` 的 `VITE_API_BASE=` 空 + `build:pages` + `frontend_pagefunction_deploy.yaml`（用 `PAGE_TOML`）构成「同源依赖代理」的默认，与直连 worker 的 `frontend_deploy.yaml` 双体系并存。
4. **本地 dev 缺代理**：`frontend/vite.config.js` 无 `server.proxy`，裸 `pnpm dev` 下 `/api/*` 404。
5. **响应体契约**（非 bug，跨进程天然耦合）：前端硬解码 worker 25+ settings 字段、`{results,count}` 信封、`new_user_token` 轮换、SHA-256 密码哈希。改 worker 响应结构需前端同步。
6. **聚合器（pxed）已直连 worker**：`mail-api.mangoqwq.cc.cd`，与 Pages 无关——这部分分离度已经最高。

## 目标架构

```
浏览器
 ├─ 静态 UI        → frontend （纯静态托管：Pages 静态 或 任意静态 host）
 └─ API 请求       → worker（mail-api.mangoqwq.cc.cd/*）
                      ├─ /api/* /open_api/* /user_api/* /admin/* /telegram/ /external/* （临时邮箱基座）
                      └─ /api/unified/* /admin/unified/ingest （one-mail 聚合收件箱）
VPS 聚合器 (pxed)
 └─ IMAP/POP3 → 直接 POST worker（mail-api.mangoqwq.cc.cd，已如此）
```

- 前端 `VITE_API_BASE` 指向 worker 域名，跨域直连（worker `app.use('/*', cors())` 已放行）。
- `pages/` 保留为「可选的纯静态托管」，**删除 Functions + service binding**。
- `worker` 的 `API_PATHS` 成为唯一来源（不再有第二份）。
- `cf-temp-mail` / `mango9502.cc.cd` 等旧临时邮箱是独立系统，不在本任务范围。

## 改动清单（bounded，全部仓库内）

| 文件 | 改动 |
|---|---|
| `frontend/.env.pages` | `VITE_API_BASE=https://mail-api.mangoqwq.cc.cd`（删空值；指向 worker） |
| `frontend/.env.example` | 补注释：明确直连 worker 为唯一形态 |
| `frontend/vite.config.js` | 加 `server.proxy`（dev 时 `/api /open_api /user_api /admin /telegram /external` → `http://127.0.0.1:8787`），让 `pnpm dev` 即插即用 |
| `pages/functions/_middleware.js` | **删除**（代理拓扑废弃） |
| `pages/wrangler.toml` | 移除 `[[services]] BACKEND`，`pages_build_output_dir` 保留纯静态 |
| `pages/package.json` / `.gitignore` | 删多余 Functions 依赖（如有） |
| `frontend/src/api/index.js` | 无改动（`VITE_API_BASE` 已支持绝对 URL） |
| `.github/workflows/frontend_pagefunction_deploy.yaml` | **删除**或标注废弃（不再有 page function） |
| `worker` | 无代码改动；`API_PATHS` 已是唯一来源（Pages 侧删除后无第二份）。可选：抽 `worker/src/api-paths.ts` 仍由 worker 导出（YAGNI，先不动） |
| `docs` / `vitepress-docs` | 更新 ukraine 部署文档：前端直连 worker、删除 Pages 代理说明、聚合器不变 |

## 决策点（呈送用户确认）

- **A. whica `frontend_pagefunction_deploy.yaml` 删除还是标注废弃**：从仓库角度看，page function 方案已废弃，建议**删除 workflow**避免误导未来部署；若需保留旧兼容，则仅加注释标注废弃。
- **B. `pages/` 目录去留**：彻底分离下，`pages/` 成为可选的纯静态托管壳（无 Functions）。是否保留作为「静态托管模板」由用户定；保留零成本。
- **C. 是否补 `worker/src/api-paths.ts` 单源**：删 Pages 侧后只有 `worker.ts` 一份，暂无第二种消费方 → YAGNI，不抽。除非未来要加 Pages/edge 转发。

## 验收

- `pnpm build`（frontend）+ `pnpm dev` 本地起 worker 后可测通 `/api/settings`（非 404）。
- `git grep` 确认仓库内 `API_PATHS` 只剩 `worker/src/worker.ts` 一处；`service="one-mail"` 无残留。
- `pages/functions/` 目录删除；`wrangler.toml` 无 `[[services]]`。
- 线上 worker `mail-api.mangoqwq.cc.cd/*` 鉴权矩阵、聚合器 upload 不受影响（本任务不触碰线上 worker）。