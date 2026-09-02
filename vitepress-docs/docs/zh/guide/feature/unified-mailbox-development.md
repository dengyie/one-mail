# 统一邮箱开发设计文档

> 本文是 one-mail 从“外部邮箱单向聚合”演进到“一个 Mail 接管多个邮箱”的产品与工程设计文档。
>
> 文档基线：当前 `main` 分支。它同时记录**现状边界、目标架构、分阶段开发计划和验收标准**。当前实现不能被理解为已经完成了本文中的目标能力。

## 1. 产品目标与现状判断

### 1.1 设计目标

one-mail 的目标不是简单提供一个邮件列表，而是让用户可以在一个入口完成多个邮箱的核心工作：

```text
Gmail / Outlook / QQ / 163 / 自定义 IMAP 邮箱 / one-mail 地址
                         ⇅
                    one-mail 工作台
```

用户最终应该能够：

- 在一个收件箱查看所有账号的邮件；
- 按账号、来源、文件夹和状态筛选；
- 标记已读、归档、删除、移动、加星标，并回写源邮箱；
- 选择任意已连接账号的身份回复、转发和新建邮件；
- 查看和下载附件；
- 搜索跨账号的完整邮件历史；
- 在不打开原邮箱网页的情况下完成日常邮件处理。

### 1.2 当前系统是什么

当前系统已经实现的是：

```text
源邮箱 --IMAP/POP3 定时拉取--> VPS aggregator --HTTP ingest--> Worker/D1 --查询--> UnifiedInbox
```

它已经具备：

- 用户自助接入外部邮箱；
- IMAP 优先、POP3 fallback；
- 按账号水印和幂等入库；
- D1 统一存储与用户作用域隔离；
- 统一收件箱列表、详情和验证码聚合；
- 同步状态回写与失败提示；
- 临时邮箱基座原有的实时收信和发信能力。

但外部邮箱主链路仍是**单向复制**：

```text
源邮箱 → one-mail
```

而不是：

```text
源邮箱 ⇄ one-mail
```

因此当前产品定位应写作“统一收件聚合器”，不应宣传为“完整替代所有第三方邮箱客户端”。

## 2. 当前能力矩阵

| 能力 | 当前状态 | 说明 |
|---|---|---|
| IMAP 拉取 | 已有 | aggregator 定时同步 |
| POP3 拉取 | 已有 | IMAP 失败时可 fallback；POP3 天生是弱语义只读协议 |
| 用户邮箱接入 | 已有 | `user_mail_accounts`，凭据 AES-GCM 加密 |
| Gmail/Outlook OAuth | 后端部分具备 | 前端完整授权流程仍需补齐 |
| 多账号收件箱 | 已有 | 以 `to_addr` 作用域隔离 |
| 已读标记 | 仅本地 | 当前不会回写 IMAP/Gmail/Graph |
| 删除、归档、移动、星标 | 无 | 没有统一命令和 provider 写操作 |
| 回复、转发、新建 | 外部账号无 | 现有发送能力主要服务 one-mail 地址/SMTP 配置 |
| 文件夹/标签 | 不完整 | 实际常用路径以 INBOX 为主，统一行没有 folder/label 语义 |
| 线程/会话 | 无 | 没有 thread/message-reference 模型 |
| 附件下载 | 无 | 当前外部邮件主要保存附件元数据 |
| HTML 邮件完整渲染 | 降级 | UnifiedInboxDetail 目前主要显示纯文本 |
| 全文搜索 | 基础 | `LIKE` 搜索 subject/from/text，缺少 FTS 和高级条件 |
| 实时收件 | 无 | aggregator 约每 300 秒轮询一轮 |
| 立即同步/连接测试 | 无 | 用户只能等待下一轮同步 |
| 临时邮箱与外部邮箱统一操作 | 无 | 仍是两套数据模型、页面和操作链路 |

## 3. 非目标与约束

### 3.1 本阶段不做

- 不重写 one-mail 临时邮箱基座；
- 不要求所有厂商都提供专用 API；没有 API 的厂商通过 IMAP/SMTP adapter 接入；
- 不把第三方密码发送到浏览器以外的非必要组件；
- 不在 Cloudflare Worker 中维持 IMAP/POP3 长连接；长连接和轮询仍由 VPS aggregator 负责；
- 不先做 AI 自动化再补基础邮件操作；基础读写闭环优先；
- 不将 POP3 宣传为支持完整双向同步。POP3 只能提供受限的接收能力。

### 3.2 兼容约束

- 保留现有 `emails` 数据和 `user_mail_accounts` 接入方式，采用增量迁移；
- 保留现有 `/api/unified/*` 查询接口，新增能力不得破坏已有前端和脚本；
- 保留现有 `x-user-token` 与 Bearer API-key 鉴权模型；
- `MAIL_CRED_ENCRYPTION_KEY` 当前按现有部署方式继续使用，不在本开发计划中轮换密钥；
- 外部账号和 one-mail 地址必须继续执行用户作用域校验；
- 所有源端写操作必须幂等、可重试，并且不能因为一个账号失败而阻塞其他账号。

## 4. 目标架构

### 4.1 分层

```text
Vue 统一工作台
      │
      ▼
Worker Unified API（鉴权、作用域、命令、任务状态）
      │
      ├── D1：统一索引、线程、操作日志、同步游标
      ├── R2：附件和可选 raw MIME
      └── Queue/Task：异步写操作与重试
              │
              ▼
VPS Aggregator / Provider Workers
      │
      ├── Gmail API adapter（OAuth）
      ├── Microsoft Graph adapter（OAuth）
      ├── IMAP/SMTP adapter（QQ、163、自定义）
      └── one-mail native adapter
```

Worker 负责短请求、权限和状态；aggregator/provider worker 负责连接外部邮件系统、执行耗时操作和处理厂商差异。

### 4.2 Provider Adapter 契约

不要在 Worker 路由和同步脚本中散落 Gmail、Outlook、QQ、163 的分支。定义统一的 provider 能力接口：

```ts
interface MailProviderAdapter {
  listFolders(ctx: ProviderContext): Promise<Folder[]>;
  listMessages(ctx: ProviderContext, cursor: SyncCursor): Promise<MessagePage>;
  getMessage(ctx: ProviderContext, id: ProviderMessageId): Promise<UnifiedMessage>;
  setRead(ctx: ProviderContext, id: ProviderMessageId, read: boolean): Promise<void>;
  move(ctx: ProviderContext, id: ProviderMessageId, destination: string): Promise<void>;
  delete(ctx: ProviderContext, id: ProviderMessageId): Promise<void>;
  setFlag(ctx: ProviderContext, id: ProviderMessageId, flag: string, value: boolean): Promise<void>;
  send(ctx: ProviderContext, message: OutgoingMessage): Promise<SendResult>;
  createDraft?(ctx: ProviderContext, message: DraftMessage): Promise<DraftResult>;
}
```

能力不是所有 provider 都必须实现。adapter 必须返回明确的 capability：

```ts
{
  read: true,
  writeState: true,
  send: true,
  drafts: false,
  folders: true,
  threads: "native" | "derived" | "none",
  attachments: "download" | "metadata" | "none"
}
```

UI 根据 capability 禁用按钮并说明原因，不能把不支持的操作伪装成成功。

## 5. 数据模型演进

当前 `emails` 更接近“邮件副本表”。目标是把它升级为“统一邮件索引 + 可追溯源端对象”。

### 5.1 `emails` 建议新增字段

字段名以最终迁移评审为准，建议至少包含：

```text
provider                 gmail / graph / imap / pop3 / native
mail_account_id          user_mail_accounts.id 或 native account id
source_folder            源文件夹规范名
source_folder_id         厂商文件夹 ID（可空）
provider_message_id      厂商稳定消息 ID
provider_thread_id       厂商线程 ID（可空）
message_id_header        RFC Message-ID
in_reply_to              RFC In-Reply-To
references_json          RFC References
source_flags_json        源端 flags/labels 快照
has_attachments          是否有附件
sync_version             归一化版本
```

兼容策略：

- 既有 `imap_uid` 不立即删除，作为旧数据和 IMAP 去重兼容字段；
- 新唯一键应按 `mail_account_id + provider_message_id` 设计；
- IMAP 使用 `uidvalidity + folder + uid`，POP3 使用 UIDL；
- provider message ID 不可靠时，保留可解释的复合 source key；
- 所有源端 ID 必须能追溯到账号和文件夹，不能只用 host + uid。

### 5.2 新增账号/文件夹表

建议增加：

```text
mail_account_folders
- id
- mail_account_id
- provider_folder_id
- canonical_name
- display_name
- folder_type: inbox/sent/drafts/archive/trash/spam/custom
- last_cursor
- last_sync_at
- last_error
```

它解决当前 `folders_json` 只能传配置、不能表达源端文件夹身份的问题。

### 5.3 线程表

```text
mail_threads
- id
- user_id / owner_scope
- normalized_subject
- last_received_at
- message_count
- unread_count
- participants_json
- created_at
- updated_at

mail_thread_messages
- thread_id
- email_id
- position
```

线程归并优先级：

1. provider 原生 thread/conversation ID；
2. `Message-ID`、`In-Reply-To`、`References`；
3. 受限的 subject + participants + 时间窗口启发式；
4. 无法确认时宁可拆线程，不要错误合并不同邮件。

### 5.4 操作任务表

所有外部写操作建议进入任务表：

```text
mail_mutation_jobs
- id
- user_id
- mail_account_id
- email_id
- operation
- payload_json
- idempotency_key
- status: pending/running/succeeded/failed/dead
- attempts
- next_retry_at
- last_error
- created_at
- updated_at
```

这样可以处理：源端暂时不可用、网络超时、OAuth token 过期和用户重复点击，而不会让 HTTP 请求长期阻塞。

## 6. API 设计

### 6.1 保留的查询接口

现有接口继续兼容：

```text
GET /api/unified/emails
GET /api/unified/emails/:id
GET /api/unified/count
GET /api/unified/verifcodes
```

后续扩展查询参数：

```text
source=
account_id=
folder=
thread_id=
unread=0|1
has_attachments=0|1
from=
to=
after=
before=
q=
```

### 6.2 统一状态操作

建议接口：

```text
POST /api/unified/emails/:id/read
POST /api/unified/emails/:id/unread
POST /api/unified/emails/:id/archive
POST /api/unified/emails/:id/trash
POST /api/unified/emails/:id/spam
POST /api/unified/emails/:id/star
POST /api/unified/emails/:id/move
```

请求示例：

```json
{
  "destination_folder": "Archive",
  "idempotency_key": "client-generated-uuid"
}
```

返回值应明确区分：

```json
{
  "status": "queued",
  "job_id": "...",
  "local_state": "pending"
}
```

不能在源端尚未成功时直接返回“已完成”。

### 6.3 回复、转发和新建邮件

建议统一使用账号身份，而不是只依赖 one-mail 地址 JWT：

```text
POST /api/unified/send
POST /api/unified/emails/:id/reply
POST /api/unified/emails/:id/forward
POST /api/unified/drafts
PATCH /api/unified/drafts/:id
POST /api/unified/drafts/:id/send
```

请求示例：

```json
{
  "mail_account_id": "account-id",
  "to": ["recipient@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "Re: original subject",
  "text": "回复内容",
  "html": null,
  "in_reply_to": "<message-id>",
  "references": ["<parent-message-id>"],
  "attachments": []
}
```

安全要求：

- `mail_account_id` 必须属于当前用户；
- 普通用户不能任意伪造 `From`；From 从账号记录推导；
- SMTP/API 凭据只能在 provider adapter 内使用；
- 附件大小、收件人数和发送频率必须限流；
- 发送成功后应同步或写入 Sent 索引，不能只在 UI 显示“发送成功”。

## 7. 同步与实时性设计

### 7.1 第一阶段：可靠轮询

在引入推送前，先完成：

- 每账号独立 cursor；
- 每文件夹独立 cursor；
- 增量同步和全量重建可区分；
- 单账号失败不影响其他账号；
- unknown size、超大邮件、坏 MIME 都必须有 dropped 指标；
- 同步状态、耗时、抓取数、写入数、跳过数可观测；
- 用户可点击“立即同步”。

### 7.2 第二阶段：按 provider 提升实时性

优先级建议：

1. Gmail Pub/Sub（OAuth 账号）；
2. Microsoft Graph webhook（OAuth 账号）；
3. IMAP IDLE（VPS 长连接，需连接上限和断线重连）；
4. 其他邮箱继续轮询。

推送只负责触发同步，不直接把厂商 payload 当作完整邮件。收到事件后仍应通过 adapter 拉取真实消息并经过统一去重。

### 7.3 前端刷新

在统一 Inbox 中增加：

- 手动刷新；
- 最近同步时间；
- 增量刷新提示；
- 可选 SSE/WebSocket 或短轮询；
- 任务完成后更新本地列表，而不是整页刷新。

## 8. 附件和正文

### 8.1 附件

外部邮件附件不能只保存文件名、大小和 MIME。目标链路：

```text
provider → aggregator → R2
                    ↘ D1 attachment metadata
```

D1 保存：

```text
attachment_id, email_id, filename, mime_type, size, r2_key, checksum
```

下载接口必须：

- 检查邮件作用域；
- 使用短时签名 URL 或 Worker 流式代理；
- 限制单文件大小和下载频率；
- 不把源端凭据暴露给浏览器。

### 8.2 HTML 邮件

统一收件箱详情必须复用项目已有的 `sanitizeHtmlMail` 和远程资源策略：

- 默认清洗脚本、事件属性、危险 URL 和主动加载资源；
- 允许用户对当前邮件单次加载远程图片；
- 清洗逻辑必须在组件内部完成，不能依赖每个调用方“记得先清洗”；
- `text_body` 作为无 HTML 时的 fallback；
- 不用简单正则删除 HTML 标签替代邮件渲染。

## 9. 分阶段开发计划

### Phase 0：基线和可观测性

目标：让现有单向聚合可诊断、可回滚。

任务：

- 补齐 POP3 host/port/SSL 和 folders 配置模型；
- 前端增加连接测试、立即同步和同步历史；
- 统一外部邮件 HTML 渲染和附件元数据展示；
- 记录 provider、account、folder、source key；
- 增加同步指标和告警；
- 确认线上域名、Worker API 和 Pages 构建使用同一版本。

验收：错误密码能在账号页显示；单账号失败不影响其他账号；重复同步不产生重复行；用户能知道邮件最后同步时间。

### Phase 1：统一邮件索引

目标：收件体验达到可长期使用。

任务：

- `emails` 增加源端身份、folder、Message-ID、attachment 标识；
- 建立 folder 映射；
- 完成 Gmail/Outlook OAuth 前端授权；
- 附件上传 R2 并提供下载；
- 全文搜索或 FTS5；
- 统一临时邮箱和外部邮箱列表/详情展示。

验收：用户可以按账号、文件夹、附件、发件人和日期搜索；打开附件不需要回源邮箱；OAuth 过期会提示重新授权。

### Phase 2：状态双向同步

目标：one-mail 的处理动作能改变源邮箱。

任务：

- read/unread；
- archive；
- trash/delete；
- move folder；
- star/flag；
- 异步 mutation job、幂等键和重试；
- 本地 pending/succeeded/failed 状态；
- provider capability 差异处理。

验收：每个动作都能在源邮箱验证；网络失败不会假报成功；重复点击不会重复执行；任务最终失败有可见错误和重试入口。

### Phase 3：统一发信

目标：用户能用外部邮箱身份完成通信。

任务：

- Gmail API/SMTP adapter；
- Graph Send Mail adapter；
- 通用 IMAP/SMTP adapter；
- 回复、全部回复、转发、新建和草稿；
- MIME、引用、Message-ID、附件；
- Sent 文件夹回写；
- 账号选择和 From 校验。

验收：从 Gmail 身份回复的邮件出现在 Gmail Sent；QQ/163 SMTP 失败有明确错误；回复邮件能够被正确归入线程。

### Phase 4：线程、规则与实时化

目标：形成完整邮箱工作台。

任务：

- 原生 thread/conversation + RFC header 线程归并；
- Gmail Pub/Sub、Graph webhook、IMAP IDLE；
- 批量操作；
- 标签和规则；
- AI 摘要、分类和自动化；
- 数据导出和账号解绑清理策略。

验收：同一会话跨账号展示稳定；新邮件在 provider 能力允许时接近实时；批量操作有逐项结果，不因一封失败吞掉全批次。

## 10. 测试策略

### 单元测试

- provider message ID 和去重键生成；
- folder 映射；
- thread 归并；
- capability 判断；
- scope 校验；
- mutation 幂等键；
- 重试退避；
- HTML/附件安全策略。

### 集成测试

至少覆盖：

- Gmail OAuth token 过期与刷新；
- IMAP read/archive/move/delete；
- POP3 只读能力被正确限制；
- SMTP 发送和 Sent 回写；
- 一个账号失败而其他账号继续；
- 同一消息重复 webhook/轮询不重复入库；
- 跨用户不能读取、下载或操作外部邮件；
- 附件下载 URL 过期和越权；
- 源端成功但回写超时的最终一致性。

### 发布前检查

```bash
pnpm --dir worker lint
pnpm --dir worker build
pnpm --dir frontend test -- --run
pnpm --dir frontend build
git diff --check
```

新增 provider 或 schema 后，必须补充对应测试并在测试环境执行真实入口验证；不能只凭 TypeScript 编译通过宣称已完成。

## 11. 技术债与已知风险

- 当前 aggregator 约每 300 秒轮询，验证码等场景存在分钟级延迟；
- POP3 无法提供完整文件夹、已读和线程语义；
- 既有 D1 行缺少完整源端身份，迁移前不能假定历史数据可无损归并；
- R2 未绑定时附件能力不可宣称为已完成；
- 统一收件箱和临时邮箱仍有两套 UI/API，需要渐进式收敛，不能一次性删除旧接口；
- 外部账号凭据当前按既有部署模型管理，未来多人/公开部署应迁移到 Wrangler Secrets 或更安全的凭据服务，并制定密钥轮换方案；
- 线上部署必须确认域名指向当前 Worker/API 和最新前端构建，避免源码、文档和线上行为不一致。

## 12. Definition of Done

只有同时满足以下条件，才能把产品描述为“支持统一接管外部邮箱”：

- 至少 Gmail、Outlook 和一个通用 IMAP/SMTP provider 完成读写闭环；
- 已读、归档、删除、移动至少四种状态操作可以回写源端；
- 回复、转发、新建邮件可以选择外部账号身份；
- Sent、线程和附件具备可验证的一致性；
- 账号和邮件的跨用户隔离有自动化回归测试；
- provider 不可用时 UI 显示能力限制和最终错误；
- 同步、写操作和发送均有重试、幂等和可观察状态；
- 线上构建、Worker 路由、aggregator 配置和文档已对齐。

在此之前，推荐使用更准确的产品描述：

> one-mail 提供多邮箱统一收件与验证码聚合，并正在建设外部邮箱的双向管理能力。
