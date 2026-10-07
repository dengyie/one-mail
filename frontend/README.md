# one-mail 前端 (frontend)

Vue 3 + Naive UI 前端，直连 Cloudflare Worker（前后端分离）。详见仓库根 `README.md`。

## 本地开发

```sh
npm install
npm run dev
```

## 构建

```sh
npm run build
```

## 质量检查

在仓库根安装 workspace 依赖后运行：

```sh
pnpm --dir frontend typecheck
pnpm --dir frontend test
pnpm --dir frontend build
pnpm --dir frontend build:pages
```

前端继续采用 Vue + JavaScript/JSDoc；API 传输契约位于 `src/api/contracts.ts`。TypeScript 检查已有 TS 模块和显式开启 `@ts-check` 的 JS 模块，Vue 模板与 SFC 编译由 Vite 构建验证。

只验收 UI 时可使用 `scripts/workspace-preview.mjs` 的 Playwright 请求拦截器。它支持分页、部分分片失败、列表失败及变更失败，使用合成邮件数据，不向实际邮件服务发出请求。详见 `../docs/superpowers/plans/2026-10-07-onemail-ui-redesign.md`。

统一邮件读写由 `src/api/index.js` 的同一客户端负责鉴权、401 和取消信号。`createUnifiedMutationApi` 在 API 构造时组合所有写操作；外部邮件必须等待任务终态，轮询共用凭据快照和可取消的 45 秒截止时间。页面离开只结束本地等待，已经入队的服务端任务仍可能执行。筛选条件受操作影响时回到第一页重新获取计数和 cursor，不依赖最新邮件指纹发现状态变化。
