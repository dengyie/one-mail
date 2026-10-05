# 发信工作台

仓库规格镜像。权威产品叙述在 vault `Note/Project/one-mail/one-mail 发信工作台开发文档.md`。运维仍以 `Note/Infra/one-mail 架构与部署运维.md` 为准。

## 状态（2026-10-04）

Phase A + B + C + D **已实现**，分支 `feat/send-mail-workbench`（从 `origin/main` 切出）。合入后 Deploy Backend 会先加 sendbox `source`/`channel`/`provider_message_id` 列，再发 Worker；前端随 `CI and Deploy pxed` 上 `inbox.mangoqwq.com`。

验证（合入前本地）：

- worker `src/core/*.test.mjs` 等 glob：247 pass
- frontend vitest：27 files / 188 pass
- aggregator `test_render_sendbox_source_migration.py`：5 pass

出站走 Resend 三域 + `SEND_MAIL`。不接 SMTP2GO。不设全局 `RESEND_TOKEN`。不改 gitignored `wrangler.toml`。`ENABLE_AUTO_REPLY` 保持 false。根 MX 仍在 Cloudflare Email Routing。

## 产品

侧栏只留一个「发信」入口，进 `/sendmail`：

| tab | 查询 | 数据 |
|---|---|---|
| compose | `?tab=compose` | 现有 `SendMail.vue` 表单 |
| self | `?tab=self` | `GET /api/sendbox?source=user_ui` |
| system | `?tab=system` | `source=user_api,external_api,smtp_proxy,admin`（不含 OTP） |

芯片「全部已发」把 `source` 清空（含 unknown 旧行），不是第四个 tab。`/sendbox` 重定向到 `/sendmail?tab=self`。回复/转发仍落到 compose。

管理员：

- `/admin/sendbox` 全站出站（含 `system_otp`，正文默认折叠）
- `/admin/send-unknown` 未知投递（预约表，不是 sendbox）
- `/admin/sendmail`、`/admin/sender-access` 保留

## 打标

正交字段：`source`（谁调用）vs `channel`（哪家通道）。`isAdmin` 只管额度。

```ts
type SendMailSource =
  | "user_ui" | "user_api" | "external_api" | "smtp_proxy"
  | "admin" | "admin_binding" | "system_otp" | "unknown"

type SendMailChannel = "resend" | "smtp" | "binding" | "verified_binding"
```

`x-one-mail-client` 只认 `web` → `user_ui`、`smtp-proxy` → `smtp_proxy`。其它头忽略。路径默认：`/api/send_mail` → `user_api`，`/external/api/send_mail` → `external_api`。客户端头可伪造，不是安全边界。

raw 仍是 v2，追加 keys。禁止 v3，禁止改名 `to_mail/content/is_html`。旧行 `source IS NULL` 显示为 `unknown`，禁止用 `from_name` 回填。

`q` 最长 80；含 `%` `_` `\` 或控制符 → 空结果，不 400。

## Phase D 行为

- 我发出的 / 系统代发 tab 角标：`GET /api/sendbox?...&limit=1` 的 `count`，30s 刷新；瞬时失败保留上次数字
- 历史列表 15s 安静刷新：`quietRefreshKey`，不把该 key 放进 SendBox `:key`（避免翻页/选中被重置）；安静失败不 toast
- 列表展示 `provider_message_id`（SQL 列优先，raw 回填）
- 未知投递页读 `send_mail_limit_reservations`（`status=active AND dispatch_state=unknown`）。`sent` 保留额度，`rejected` 释放预约并退额。503 / 失败发送仍不 INSERT sendbox

## Schema

`db/2026-10-04-sendbox-source.sql` 加 `source` / `channel` / `provider_message_id` 列与索引。`db/*.sql` 不会被 Deploy Backend 自动执行，workflow 有显式 D1 步骤；全新库 render 输出空 SQL。同步 `db/schema.sql` 与 `db_api.ts` `ensureColumn`。

## 关键文件

- `worker/src/core/sendbox_source.ts`
- `worker/src/mails_api/send_mail_api.ts`
- `frontend/src/views/index/SendWorkbench.vue`
- `frontend/src/components/SendHistoryPane.vue`
- `frontend/src/views/admin/UnknownSendMail.vue`
- `db/2026-10-04-sendbox-source.sql`

## 验收对照

- 网页发 → self
- curl `/external/api/send_mail` → system
- OTP 不进用户 system
- `/sendbox` → self
- 回复仍 compose
- v1 raw 仍渲染
- 未知投递不出现在 sendbox 列表
