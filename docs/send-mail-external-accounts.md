# 设计文档：以已接入外部邮箱身份发信（外部账号发送）

> 状态：设计稿（尚未实现）
> 关联：[[send-mail-workbench.md]]（发信工作台，已上线）、[[provider-message-identity-upgrade.md]]（provider 身份）、[[unified-inbox-sharding.md]]（分片）
> 目标读者：实现 agent + review agent

## 1. 目标与范围

让统一收件箱的用户/管理员，能以**已经接入的外部邮箱**（QQ / 163 / Gmail / Outlook / Hotmail / Graph）作为发件身份发送邮件，而不是只能从本站临时地址或原生域名 Resend 发信。

**在范围内：**

- 聚合器端新增「发送」provider 写操作，复用现有 mutation 认领/执行/回写管道。
- Worker 端新增发信入口 + 出站审计（sendbox）复用。
- 按账号类型的三条发送适配器（QQ/163/自定义 IMAP、Gmail、Outlook/Graph）。

**明确不在范围内：**

- Worker 直连外部 SMTP（与现有「所有 provider 写操作都放聚合器」的架构相反，不做）。
- 自动迁移/自动给账号开通发送权限（发送开关默认关闭，管理员显式开启）。
- 恢复 Brevo、启动 SMTP2GO、新增任何第三方发信厂商（与既有限制一致）。
- 改动前端既有 API 契约（`/api/send_mail` 等已上线端点的请求/响应形状不变；新增端点独立）。

## 2. 现状盘点（已从代码坐实）

### 2.1 mutation 管道（可直接扩展）

- Worker 持有授权与队列状态，聚合器只认领短租约、执行 provider 特定写操作、上报结果（at-least-once 语义）。
- 现有操作类型：`set_read` / `set_starred` / `move` / `delete`（`worker/src/unified/mutation_jobs.ts:6`）。
- 表 `mail_mutation_jobs` 已含：`operation`、`provider`、`account_id`、`desired_value`、`target_folder`、`provider_message_id`、`source_key`、`status`、`attempts`、`lease_token/lease_until` 等。
- 认领端点 `/admin/unified/mutations/v2/claim` + 结果回写 `/admin/unified/mutations/{id}/result`（`mutation_jobs.ts:415/562`）。
- 聚合器侧 `claim_mutation_jobs` / `execute_mutation` / `process_mutation_jobs`（`aggregator/src/one_mail_agg/mutation_jobs.py`）。

### 2.2 出站审计与幂等（可直接复用）

- `sendbox` 表已存 `source / channel / provider_message_id / reservation_id / status`（`worker/src/core/sendbox_source.ts`）。
- `sendMail()` 已有完整「预约 → 幂等键 → markDispatchStarted → provider 调用 → markDispatchSucceeded/commit → 失败退额」流程（`worker/src/mails_api/send_mail_api.ts:144`）。
- 未知投递（unknown）通过 `send_mail_limit_reservations` 记录，超时不当失败重试（`SendMailDeliveryUnknownError`）。

### 2.3 凭据导出（发送复用同一通道）

- `/admin/unified/mail_accounts`（x-admin-auth 保护）解密 `cred_enc` / `oauth_enc`，把 `password` / `oauth`（含 refresh_token）返回给聚合器（`worker/src/user_api/mail_accounts.ts:464`）。
- 聚合器已通过 `fetch_user_accounts` 拉取这些账号，`AccountConfig` 含 `password` + `oauth` 字段（`aggregator/src/one_mail_agg/config.py:70`）。

### 2.4 各 provider 的发信凭据现状（关键结论）

| 账号类型 | source | 现有凭据 | 发信路径 | 是否需重新授权 |
|---|---|---|---|---|
| QQ 邮箱 | `imap_qq` | `password`（SMTP 授权码） | `smtp.qq.com:465` SSL | **否**（零新增） |
| 网易 163 | `imap_163` | `password`（SMTP 授权码） | `smtp.163.com:465` SSL | **否** |
| 自定义 IMAP | `imap_custom` | `password` | 账号自带 SMTP host/port（需新增配置项） | 视服务商 |
| Gmail | `imap_gmail` | OAuth2 refresh_token | `smtp.gmail.com:587` XOAUTH2 | **待确认 scope**（见 §2.5） |
| Outlook 组织/个人 | `imap_outlook` / `msa` | OAuth2 refresh_token | `smtp-mail.outlook.com:587` XOAUTH2 | **是**（当前 scope 纯读） |
| Graph | `graph_outlook` | OAuth2 refresh_token（Graph scope） | Graph `/me/sendMail` | **是**（需 `Mail.Send`） |

### 2.5 Gmail scope 粒度（第一步必须确认）

- Gmail 的 OAuth 授权 scope **不在代码里**。它在 D1 `settings` 表的 `OAUTH2_SETTINGS_KEY`（`UserOauth2Settings.scope`，`worker/src/models/index.ts:185`），授权时经 `getOauth2LoginUrl` 拼进 redirect URL（`worker/src/user_api/oauth2.ts:26`）。
- 聚合器刷新 token 时**不带 scope**（`gmail_access_token`，`oauth.py:36`），刷新出的 access_token 保留原授权粒度。
- 标准 Gmail 邮件 scope `https://mail.google.com/` 同时覆盖 IMAP 与 SMTP 发送；若当初授权的是该 scope，则发信**无需重新授权**；若被窄化（如只读 IMAP scope），则需要引导用户重新授权。
- **结论：第一步需读取线上 `OAUTH2_SETTINGS_KEY` 里 Gmail 的 `scope` 值，决定 Gmail 是否走「重新授权」分支。**（仓库内无法确认，属运行时数据。）

### 2.6 Outlook / Graph scope（已确定需重新授权）

- MSA / Outlook 的 scope 硬编码为 `https://outlook.office.com/IMAP.AccessAsUser.All offline_access`（`oauth.py:57/100`），**不含 `SMTP.Send`**。
- Graph scope 按卡存 `account.oauth["scope"]`，`mutation_jobs.py:359` 的 `_graph_scope_allows_write` 已能区分 `Mail.Read` vs `Mail.ReadWrite`；发信需额外 `Mail.Send`，现有卡大概率没有。
- 这两类账号发信需要一次「追加 scope 的重新授权」流程（复用现有 OAuth 登录流程 + 更新 scope 后重签 refresh_token）。

## 3. 核心架构决策

**决策 1：发送动作落在聚合器侧执行。**
与现有 provider 写操作（读/标星/移动/删除）同一层。Worker 直连外部 SMTP 需要把长期凭据放进 Worker 运行时并长期持有多类 SMTP 客户端，违背现有边界。

**决策 2：把「发送」建模为 mutation 的第 5 种 operation `send_mail`，但不复用 `mail_mutation_jobs` 表。**
理由：现有表以 `email_id`（已收邮件行）为锚，而「发送」不是对某封已收邮件的状态变更，`email_id` 无意义；其幂等键、payload（收件人/主题/正文/附件）、结果（provider_message_id）与现有列语义不同。新建独立表 `outbound_mail_jobs`，但**复用同一套 claim/lease/report 端点和 at-least-once 对账语义**，避免分裂两套租约机制。

**决策 3：发送不可逆 → 对账优先于重试。**
超时不能当作失败重发。发送适配器在 provider 调用后，若结果不明确，必须回查服务端「已发送」文件夹（QQ/163/IMAP 走 `Sent` 文件夹、Gmail 走 `[Gmail]/Sent Mail`、Outlook 走 `Sent Items`、Graph 走 `Sent Items` folderId）确认是否已落一封与本次请求匹配的邮件，再决定 succeeded / retry / failed。语义与现有 move/delete 的「outcome-unknown 必须先 recovery」一致。

**决策 4：凭据从「可读」升级为「可发」需要显式开关。**
在 `user_mail_accounts` 加 `can_send` 标志（默认 0）。管理员通过管理后台逐账号开启。只有开启的账号才会出现在发信身份候选列表，且聚合器才会为其创建发送 job。未开启的账号走发送请求时返回明确的「该账号未开通发送」而非静默降级。

**决策 5：发送结果归档复用 sendbox。**
发送成功后写 `sendbox`（`source = 外部账号`、`channel = 服务商名`、`provider_message_id` 填充），同时可选地把发出的邮件归入本地 `emails` 的「已发送」视图（通过 `provider_message_id` 串进会话线程）。

## 4. 数据模型改动

### 4.1 新表 `outbound_mail_jobs`（Worker D1）

```sql
CREATE TABLE IF NOT EXISTS outbound_mail_jobs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,            -- 外部账号 id（user_mail_accounts / config 账号）
    from_addr TEXT NOT NULL,             -- 发件身份（账号邮箱）
    to_addr TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_text TEXT,
    body_html TEXT,
    payload_json TEXT,                   -- 完整请求快照（含 to_name/from_name 等）
    request_hash TEXT NOT NULL,          -- 幂等键（见 §6）
    provider TEXT NOT NULL,              -- imap_qq | imap_163 | imap_gmail | imap_outlook | graph_outlook
    status TEXT NOT NULL,                -- pending | processing | succeeded | failed | unsupported | superseded
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER,
    provider_message_id TEXT,            -- 发送成功后的 provider 消息 id
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbound_pending
    ON outbound_mail_jobs (status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_request_hash
    ON outbound_mail_jobs (account_id, request_hash);
```

### 4.2 `user_mail_accounts` 加列

```sql
ALTER TABLE user_mail_accounts ADD COLUMN can_send INTEGER NOT NULL DEFAULT 0;
```

### 4.3 静态 config 账号（QQ/163 等已在 pxed config.json 的账号）

- 这些账号不入 `user_mail_accounts` 表，发送开关放 `AccountConfig` 的新字段 `can_send: bool = False`。
- 开关来源由聚合器读 `config.json`；管理员对静态账号的开关变更走「改 config.json + 重启聚合器」的既有流程，不新增 Worker 端点。

## 5. Worker 侧改动

### 5.1 发信入口（新增，独立于既有 `/api/send_mail`）

- `POST /api/send_mail/external`（用户鉴权，`x-user-token`）
- 请求体：`{ account_id, to_mail, to_name?, subject, content, is_html }`
- 行为：
  1. 校验账号属于当前用户（或当前用户是管理员）、`can_send = 1`。
  2. 生成 `request_hash`（幂等键，见 §6）。
  3. 校验失败 → 400 + 释放；否则写入 `outbound_mail_jobs`（status=pending）。
  4. 同步写一条 `sendbox` 记录（status 标记为「排队中」），前端立即可见。
  5. 返回 `202 { status: "queued", job_id }`。

- **不变动**既有 `/api/send_mail` / `/external/api/send_mail` / `/admin/send_mail` 的契约。

### 5.2 认领/回写端点（复用语义，新增路径）

- `POST /admin/unified/outbound/claim`（x-admin-auth）：从 `outbound_mail_jobs` 认领 pending job，打 lease（复用 `LEASE_MS=60s`、恢复 crashed worker、幂等键去重）。
- `POST /admin/unified/outbound/{id}/result`：聚合器回写 `succeeded/retry/failed/unsupported` + 可选 `provider_message_id` + `error`。重试退避复用现有指数退避 + 上限。

> 设计上可选：复用现有 `/mutations/v2/claim` 端点、把 `send_mail` 也作为该端点的返回类型。**推荐**独立端点——发送 job 的 payload 与现有 job 差异大，独立端点避免污染现有契约与迁移。

### 5.3 sendbox 归档

- 发送成功 → 更新对应 sendbox 行 status=`sent`、`provider_message_id`。
- 发送失败/不支持 → sendbox 行 status 标记失败原因，不重复扣额（外部账号发送不占用本站发送额度，但记录审计）。

## 6. 幂等与对账（发送不可逆的核心）

### 6.1 幂等键

- `request_hash = HMAC-SHA256(account_id + from_addr + to_addr + subject + content)`，与现有 `hashSendMailRequest` 思想一致（`send_mail_limit_utils.ts`）。
- 前端发信请求带 `x-idempotency-key`；无 key 时按请求内容哈希。相同 `request_hash` 二次提交 → 直接返回已有 job 的 `provider_message_id`（replay），不再触发第二次发送。

### 6.2 超时对账

发送适配器执行 `provider.send()` 后，若抛超时/连接错误（结果未知），**不得**上报 `failed`。聚合器必须进入「对账」：

1. 连接服务端「已发送」文件夹，按 `subject + 收件人 + 发送时间窗` 检索是否已存在本次邮件。
2. 找到 → 上报 `succeeded` + 该邮件的 `provider_message_id`（可能是服务端分配的新 id）。
3. 明确不存在且服务端返回确定结果 → 上报 `failed`（可安全重试）。
4. 无法确认（又超时）→ 上报 `retry`，退避重试，直到对账得到确定结果（对账类操作不设最大尝试上限，与 move/delete 的 ordering barrier 同理）。

## 7. 聚合器侧改动

### 7.1 新模块 `smtp_sender.py`

通用 SMTP 发送适配器（QQ / 163 / 自定义 IMAP），封装：

- `build_smtp_client(account)`：按 `source`/`host` 选 `SMTP_SSL(465)` 或 `STARTTLS(587)`。
- `send(account, payload)`：构建 MIME（复用现有 `normalize`/MIME 构建逻辑），返回 provider 分配的消息 id 或抛可分类异常。
- `reconcile_sent(account, payload)`：连接「已发送」文件夹对账（§6.2）。

### 7.2 新模块 `gmail_sender.py` / `outlook_sender.py`

OAuth2 + XOAUTH2 发送适配器：

- 用现有 `oauth_client_factory` / `gmail_access_token` / `cached_msa_access_token` 拿 access_token（已在 `redemption_lock` 内做 RT 轮换防并发）。
- `smtplib` + `auth('XOAUTH2', ...)` 走 `smtp.gmail.com:587` / `smtp-mail.outlook.com:587`。

### 7.3 Graph 发送

- 在 `graph_source.py` / `mutation_jobs.py` 的 Graph 分支补 `send` 操作：`POST https://graph.microsoft.com/v1.0/me/sendMail`（body 用 `message` 对象 + `saveToSentItems=true`）。
- 复用 `graph_access_token` 与 `_graph_headers`。

### 7.4 `execute_mutation` 扩展

- `execute_outbound`（或直接在 `execute_mutation` 内加 `send_mail` 分支）按 `provider` 分发到上述适配器。
- 新增 `process_outbound_jobs`（与 `process_mutation_jobs` 同构），被 `main.py` 的 daemon 循环与 `mutation_main.py` 一起调度。

### 7.5 调度

- `main.py` 的 daemon tick 在现有「60s 增量拉取 + 5s mutation 排空」之外，把 outbound 排空并入同频（5s 排空窗口），或独立一个更慢的窗口（发送非高频）。推荐并入 mutation 排空窗口，复用同一 `redemption_lock`。

## 8. 发送开关与权限

- **用户账号**（`user_mail_accounts`）：`can_send` 列，管理员在 `Admin.vue` 的「邮箱账户管理」加开关。
- **静态账号**（config.json）：`AccountConfig.can_send`，改 config + 重启聚合器。
- **权限校验**（Worker 发信入口）：非管理员用户只能用自己的账号发；管理员可指定任意已开 `can_send` 的账号。
- **网络安全**：发送目标复用现有 `network_guard.assert_public_user_account` / egress 白名单策略（发信目标不应比收信目标更宽松）。

## 9. 前端改动

- 发信工作台 `/sendmail`「写新邮件」tab 的发件身份下拉，追加「已开通发送的外部账号」列表（数据来自新的轻量列表端点，复用 `user_mail_accounts` 已返回的账号元数据，前端只多一个 `can_send` 过滤）。
- 提交时走 `POST /api/send_mail/external`，其余 UI（进度、错误提示、sendbox 记录）复用现有发信工作台。
- **不新增路由**，不改变既有发信 tab 的契约。

## 10. 分阶段实施计划

| 阶段 | 内容 | 门禁 |
|---|---|---|
| P0 | 读线上 `OAUTH2_SETTINGS_KEY` 确认 Gmail scope；确认 QQ/163 静态账号 SMTP host/port | 结论落文档 |
| P1 | 建表 + Worker 发信入口 + 认领/回写端点 + 幂等 | Worker typecheck + 单测 + 远程 schema 自愈步骤 |
| P2 | 聚合器 `smtp_sender`（QQ/163/自定义）+ `gmail_sender` | Mailpit/loopback E2E + 单测 |
| P3 | 聚合器 Outlook/Graph 发送 + 对账 recovery | 单测 + 合约测试 |
| P4 | 前端发件身份下拉 + sendbox 归档展示 | frontend vitest + build:pages |
| P5 | 生产灰度：单个 QQ 账号开启 can_send，真实发一封自测 | 线上验收 |

## 11. 测试计划

- **Worker 单测**：发信入口鉴权（非本人账号 403 / can_send=0 拒绝）、幂等 replay、claim/result 租约 fence、request_hash 唯一索引冲突。
- **聚合器单测**：
  - `smtp_sender`：SSL/STARTTLS 选型、auth 失败分类、对账检索。
  - `gmail_sender`：XOAUTH2 auth 串格式、RT 轮换回调。
  - Graph `sendMail`：`saveToSentItems`、scope 拒绝分支。
  - 对账：超时后回查「已发送」命中/未命中/再超时三态。
- **合约测试**：Worker ↔ 聚合器 claim/result 的 JSON 形状（无需真实 SMTP）。
- **Mailpit E2E**：loopback 无 TLS SMTP 路径（仅测试豁免，生产强制 TLS），与现有 SMTP 测试一致。

## 12. 边界、约束、不做的事

- 不恢复 Brevo、不启动 SMTP2GO、不新增第三方发信厂商。
- 不设全局 `RESEND_TOKEN`；不改根 MX；`ENABLE_AUTO_REPLY` 保持 false。
- 不动既有 `/api/send_mail` 等已上线端点契约。
- 不自动给任何账号开发送（`can_send` 默认 0，人工开启）。
- 生产 `wrangler.toml`（gitignored）与 secret 值不提交；新增 D1 表必须在 deploy workflow 加远程 schema 自愈步骤（既有铁律）。
- 发送目标与收信目标同受 `network_guard` / egress 白名单约束，不得放宽。

## 13. 开放问题（实现前需确认）

1. **Gmail 线上 scope 实际值**（决定 P0 走「免重新授权」还是「重新授权」分支）——需读 D1 `OAUTH2_SETTINGS_KEY`。
2. **自定义 IMAP 的 SMTP host/port** 是否需要用户自助配置，还是仅支持已知服务商（QQ/163）——影响 `AccountConfig` 字段设计。
3. **发出的邮件是否要本地归档进 `emails` 的「已发送」**（决策 5 的可选项）——涉及前端「我发出的」tab 是否合并展示外部账号发送。
