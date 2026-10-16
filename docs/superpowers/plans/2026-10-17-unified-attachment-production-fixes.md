# Unified Attachment Production Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 修复附件下载与生产部署 review 中确认的部署失败、清理泄漏、容量失控、分片配置缺失和联邦下载覆盖不足问题。

**Architecture:** 保持现有 Worker → Nginx → VPS storage 架构。部署 workflow 继续使用远端 staging 和 rollback，但统一负责 staging 清理并使用 merge-aware 变更检测。VPS storage 增加可配置的剩余空间保护和明确的 507 响应；shard 模板补齐同一附件存储契约。

**Tech Stack:** GitHub Actions YAML、Bash、Python 3.11、Cloudflare Worker TypeScript、Node test runner、pytest。

## Global Constraints

- 不引入 R2。
- 不修改主 worktree `/Users/mango/project/one-mail`。
- 所有文件 UTF-8 无 BOM。
- 保留已有 `r2_key` schema migration 兼容逻辑。
- 只做根因修复，不增加无调用的兼容层或大规模重构。
- 每项修复必须有可重放的失败证据和新鲜验证。

---

### Task 1: 修复前端部署 sparse checkout

**Files:**
- Modify: `.github/workflows/deploy.yml:125-129`
- Test: `tests/test_deploy_workflows.py`

- [x] 写静态回归测试，断言 deploy-pxed sparse checkout 同时包含 Nginx 配置和 `deploy/pxed-local-config.sh`。
- [x] 先运行测试，确认当前 checkout 配置缺少 helper。
- [x] 将 helper 加入 sparse checkout 列表。
- [x] 重新运行测试并确认通过。

### Task 2: 修复远端 staging/token 清理和 merge commit 检测

**Files:**
- Modify: `.github/workflows/aggregator_deploy.yaml:94-115,177-227,346-350`
- Modify: `.github/workflows/deploy.yml:183-213`
- Test: `tests/test_deploy_workflows.py`

- [x] 写回归断言，要求 aggregator workflow 在创建 staging 后具备失败清理，并使用 `git diff-tree -m` 或等价 merge-aware 检测。
- [x] 先运行测试确认当前文本不满足要求。
- [x] 在 runner 侧创建 staging 后注册 cleanup；在远端 rollback trap 中同时清理 `REMOTE_STAGE`；前端 workflow 也注册 staging cleanup。
- [x] 将 aggregator 变更检测改为 merge-aware。
- [x] 重新运行静态测试。

### Task 3: 增加 VPS storage 容量保护和 ENOSPC 处理

**Files:**
- Modify: `aggregator/src/one_mail_agg/storage_server.py:22-221`
- Modify: `aggregator/deploy/attachment-storage.sh:1-18`
- Modify: `aggregator/deploy/README.md`
- Test: `aggregator/tests/test_storage_server.py`

- [x] 增加失败测试：剩余空间不足时 PUT 返回 507，health 不返回 healthy。
- [x] 增加失败测试：对象替换发生 ENOSPC 时返回 507 且临时文件被清理。
- [x] 增加回归测试：首次创建上传目录发生 ENOSPC 时仍返回 507。
- [x] 为 storage server 增加可配置 `min_free_bytes`、上传 reservation、容量 health 检查和 ENOSPC 映射。
- [x] 在启动脚本通过 `ATTACHMENT_STORAGE_MIN_FREE_BYTES` 配置默认 512 MiB 的保留空间。
- [x] 更新部署文档和运行时检查说明。
- [x] 运行 storage server pytest。

### Task 4: 补齐 shard 附件存储配置

**Files:**
- Modify: `worker/wrangler.shard1.toml.example:18-30`
- Modify: `vitepress-docs/docs/en/guide/worker-vars.md`
- Modify: `vitepress-docs/docs/zh/guide/worker-vars.md`
- Test: `tests/test_deploy_workflows.py`

- [x] 写断言确认 shard 模板声明 `ATTACHMENT_STORAGE_URL` 并说明 `ATTACHMENT_STORAGE_TOKEN` secret。
- [x] 补齐模板和中英文配置文档。
- [x] 重新运行静态配置检查。

### Task 5: 修复 CORS 文件名响应头并补联邦下载测试

**Files:**
- Modify: `worker/src/worker.ts:47-55`
- Modify: `worker/src/unified/federation.test.mjs`
- Test: `worker/src/unified/federation.test.mjs`

- [x] 增加 gateway → shard attachment download 成功、404、403/503 和取消路径测试。
- [x] 在 CORS 中暴露 `Content-Disposition`。
- [x] 运行相关 Worker 测试和 TypeScript 检查。

### Task 6: 全量验证

**Files:**
- No new files.

- [x] 运行部署静态检查。
- [x] 运行 storage server pytest。
- [x] 运行 Worker unified attachment/federation/shard tests。
- [x] 运行 Worker typecheck、lint 和 build。
- [x] 检查 `git diff --check`、工作区状态和最终 diff。
