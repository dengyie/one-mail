# ADR：Phase 1 统一邮件索引迁移

- **状态：Proposed（提议，未实施）**
- **日期：** 2025-02-22
- **范围：** D1/SQLite 数据模型与增量迁移

> 本 ADR 是 Phase 1 的迁移方案，不是已完成能力的说明。当前不修改业务代码、不切换读写路径，也不承诺目标表已存在。只有迁移脚本、回填校验和真实入口验收全部通过后，才可以另行提交实施 ADR。

## 1. 决策摘要

在保留现有 `emails`、`user_mail_accounts` 和旧 API 的前提下，为每封邮件建立可解释的 provider identity，并增加 `mail_account_folders` 保存账号与源文件夹的稳定关系。Phase 1 只做结构、去重、历史回填和兼容索引；不做删除旧字段、不改变 API 响应、不把 `imap_uid` 当作跨账号全局 ID。

目标 identity 为：

```text
(mail_account_id, folder_identity, provider_message_id)
```

其中 `folder_identity` 对 IMAP 至少包括 `UIDVALIDITY + folder`；POP3 使用 UIDL；API provider 使用厂商稳定 message ID。无法获得稳定 ID 的记录必须保留可追溯的复合 source key，并进入可观测的人工/后续处理队列，不能静默猜测唯一性。

## 2. 现状、目标与非目标

### 2.1 现状

`emails` 同时承载 native 邮件和外部邮箱副本，历史记录主要依赖 `imap_uid`、地址和时间等旧语义；文件夹配置可能存在于 JSON 中，不能可靠表达源端文件夹身份。一个 `imap_uid` 只在同一 IMAP 文件夹和 UIDVALIDITY 下有意义。

### 2.2 Phase 1 目标

- 为外部副本补齐账号、provider、源文件夹和稳定消息身份；
- 让重复投递在数据库层有确定的去重依据；
- 能分批、安全、可重跑地回填历史数据；
- 保留旧查询、详情、删除和 IMAP proxy 使用的字段及行为；
- 为后续统一列表、线程和源端写操作提供可索引基础。

### 2.3 非目标

- 不在本阶段实现 provider API/IMAP 同步器或双向写操作；
- 不重建线程、不迁移附件、不删除 `imap_uid`；
- 不将缺失的 provider identity 通过 subject、发件人或时间强行合并；
- 不改变任何业务路由、鉴权或现有响应契约。

## 3. 数据模型决策

### 3.1 `emails` 新增字段

下表是 SQLite/D1 的明确类型。SQLite 没有原生 boolean/JSON 类型，因此 boolean 使用 `INTEGER`（`0/1`），JSON 使用合法 JSON 文本。

| 字段 | D1 类型与约束 | NULL 语义 |
|---|---|---|
| `provider` | `TEXT` | native/旧记录未知时为 `NULL`；已识别值为 `gmail`、`graph`、`imap`、`pop3` 或 `native` |
| `mail_account_id` | `INTEGER`（外键语义，是否真实 FK 依现有迁移能力） | native 邮件、历史无法映射账号为 `NULL`；不能填 0 或假账号 |
| `source_folder_id` | `TEXT` | 源端没有稳定 folder ID 或尚未同步为 `NULL` |
| `source_folder` | `TEXT` | 未知/无法映射为 `NULL`，不是空字符串；规范名如 `INBOX` |
| `provider_message_id` | `TEXT` | provider 没有稳定 ID 或历史缺失为 `NULL` |
| `provider_thread_id` | `TEXT` | 未提供原生 thread ID 为 `NULL`，不以空字符串表示“无线程” |
| `message_id_header` | `TEXT` | 原始邮件无 RFC Message-ID 为 `NULL` |
| `in_reply_to` | `TEXT` | 无头部为 `NULL` |
| `references_json` | `TEXT` | 无 References 或解析失败为 `NULL`；有值必须是 JSON 数组文本 |
| `source_flags_json` | `TEXT` | 未读取源 flags 为 `NULL`；读取后“空 flags”应为 `[]` |
| `has_attachments` | `INTEGER` | 未解析/历史未知为 `NULL`；确认无/有分别为 `0/1` |
| `sync_version` | `INTEGER` | 未经过本迁移规范化为 `NULL`；回填成功后写迁移版本号（例如 `1`） |
| `source_key` | `TEXT` | 只有可解释、可稳定重建的复合 identity 才写入，否则为 `NULL` |

`NULL` 表示未知、未同步或不适用；它不表示空值，也不等同于 `0`。回填不得把未知值伪造成空字符串、0 或 `native`。

### 3.2 `mail_account_folders`

```sql
CREATE TABLE mail_account_folders (
  id INTEGER PRIMARY KEY,
  mail_account_id INTEGER NOT NULL,
  provider_folder_id TEXT,
  canonical_name TEXT NOT NULL,
  display_name TEXT,
  folder_type TEXT NOT NULL,
  last_cursor TEXT,
  last_sync_at INTEGER,
  last_error TEXT
);
```

`mail_account_id` 是 `user_mail_accounts.id` 的账号作用域；`provider_folder_id` 可空，因为 IMAP 的规范身份可能由名称与 UIDVALIDITY 共同构成。`canonical_name` 是稳定规范名，`display_name` 可随 provider/用户语言改变。`folder_type` 仅取 `inbox`、`sent`、`drafts`、`archive`、`trash`、`spam`、`custom`。游标、同步时间和错误在从未同步时为 `NULL`；成功同步的空游标仍按 provider 定义存储，不用“未知”代替。

文件夹唯一性：优先 `UNIQUE(mail_account_id, provider_folder_id)`（仅对非 NULL 值生效），并增加 `UNIQUE(mail_account_id, canonical_name)`。同账号下相同规范名必须先合并/人工判定，不能由迁移静默覆盖。

### 3.3 provider identity、唯一键与去重

- provider identity 必须绑定 `mail_account_id`；同一个 message ID 在两个账号中是两封不同邮件。
- IMAP identity 为 `provider=imap`、账号、folder、`uidvalidity`、UID 组成的 `source_key`；`imap_uid` 仅作为旧兼容字段。
- POP3 identity 使用账号 + folder（通常 inbox）+ UIDL；不把 POP3 序号当 identity。
- Gmail/Graph 使用账号 + provider + 稳定 `provider_message_id`，folder 变化不应复制出新邮件。
- native 邮件沿用现有 identity/主键，不强行套用外部 provider key。

建议在数据库支持表达式/部分索引时建立：

```sql
CREATE UNIQUE INDEX emails_provider_identity_uq
ON emails(mail_account_id, provider, provider_message_id)
WHERE mail_account_id IS NOT NULL
  AND provider IS NOT NULL
  AND provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX emails_source_key_uq
ON emails(source_key)
WHERE source_key IS NOT NULL;
```

若 D1 版本或现有数据不允许直接创建唯一索引，先创建审计表/临时重复表，按保留规则合并，再创建索引。保留规则是：不丢正文/附件引用，保留最早稳定主记录，迁移旧主键引用，记录重复行、来源和决策；任何冲突都必须使迁移失败而不是随机删除。

## 4. 历史回填与迁移顺序

迁移必须可重跑、分批（按主键范围，单批有明确上限），每一步提交后可观测。推荐顺序：

1. **备份与基线：** 导出 D1 快照；记录每张表行数、NULL/重复统计和 `PRAGMA`/索引信息。
2. **扩展表结构：** 给 `emails` 增加可空字段，创建 `mail_account_folders`，不创建会立即阻断旧写入的非空列。
3. **导入/规范化文件夹：** 从账号配置和可用同步元数据生成文件夹；冲突停在审计结果中。
4. **回填账号/provider：** 能由现有外部账号唯一映射时写入 `mail_account_id` 和 provider；native 或不确定记录保持 NULL。
5. **回填 source identity：** 按账号、文件夹、UIDVALIDITY/UID、UIDL 或 provider ID 生成 `source_key`，重跑时只补缺失字段或验证相同值。
6. **去重审计与合并：** 先输出重复组和受影响主键，再按批准规则迁移引用；禁止未经审计的 destructive delete。
7. **回填派生字段：** 解析 RFC headers、附件状态和 JSON；解析失败保留 NULL 并计数。
8. **创建索引：** 重复为零、NULL 语义检查通过后再创建唯一/查询索引；验证 query plan。
9. **验收与观察：** 用真实 API、IMAP proxy 和同步 ingest 入口验证，再决定后续 Phase 是否切换读路径。

回填只标记成功行的 `sync_version=1`，失败行可重试且不冒充完成。新增写入在本 ADR 实施时必须同时填充 identity；但本 ADR 本身不改业务代码。

## 5. 查询索引建议

除唯一索引外，按实际查询计划建立并验证：

```sql
CREATE INDEX emails_account_received_idx
  ON emails(mail_account_id, received_at DESC, id DESC);
CREATE INDEX emails_account_folder_received_idx
  ON emails(mail_account_id, source_folder, received_at DESC, id DESC);
CREATE INDEX emails_provider_thread_idx
  ON emails(mail_account_id, provider_thread_id);
CREATE INDEX mail_account_folders_account_type_idx
  ON mail_account_folders(mail_account_id, folder_type, canonical_name);
```

索引不得取代用户/账号作用域条件；所有查询仍必须带原有 owner/address 权限过滤。若列名或时间类型与当前 schema 不同，以实际 schema 调整，不改变上述语义。

## 6. 兼容性与回滚

- 旧 `/api/unified/*` 继续读取现有字段和主键；新增列为空时响应保持原样。
- 旧 API 的分页、排序、详情和删除语义不变；不要求客户端理解 provider identity。
- IMAP proxy 继续使用 `imap_uid` 及现有 folder 逻辑；新 identity 只用于去重和后续适配，不替换协议所需字段。
- 不删除、不重命名、不改变 `imap_uid` 的类型/含义；必要时建立旧字段到新字段的可追溯映射。
- 回滚优先是停止回填/删除新增索引并恢复快照；若已经合并重复行，必须从快照恢复，不能依赖“反向猜测”恢复。
- 回滚前先停止产生新 identity 的写入（实施阶段），保存迁移日志；回滚后检查旧 API、IMAP proxy 和账号作用域。

## 7. 测试与真实入口验收

### 7.1 自动化测试

- schema：字段类型、可空性、允许的 provider/folder_type、索引存在性；
- identity：同账号同 ID 幂等、跨账号同 ID 不冲突、文件夹变化不错误复制；
- IMAP：UIDVALIDITY 变化不会把旧 UID 误判为同一邮件；POP3 序号变化不会破坏 UIDL 去重；
- NULL：unknown、empty JSON、false、zero 的语义分别验证；
- 回填：批次中断后重跑无重复、冲突可审计、解析失败可重试；
- 兼容：旧 API 响应/分页/删除和 `imap_uid` 行为回归；
- 权限：跨 user/account 查询、详情和删除均拒绝；
- 索引：代表性查询使用预期索引且不会漏掉 NULL 记录。

### 7.2 真实入口验收（必须在合并前完成）

在与生产同版本的 D1 staging 数据上，不只调用 migration helper：

1. 通过真实 `/user_api` 登录取得用户 token；
2. 通过真实外部邮箱同步 ingest/aggregator 入口导入两封具有相同 provider ID 但属于不同账号的邮件；重复投递同一封，确认只出现一条；
3. 通过真实 `/api/unified/*` 列表和详情检查邮件、账号、文件夹和旧字段；
4. 通过真实 SMTP/IMAP proxy 登录并读取，确认旧 `imap_uid` 路径仍可用；
5. 用无权限用户访问另一账号的 identity，确认返回拒绝且无数据泄露；
6. 故意中断回填后重跑，检查计数、审计记录和最终唯一性；
7. 执行回滚演练，确认旧 API、IMAP proxy 和原有 native 收信入口恢复。

验收证据至少包括迁移版本、基线/结果计数、重复审计、失败重试记录、API/IMAP 请求日志和索引 query plan。未完成真实入口验收时，状态仍为 Proposed。

## 8. 后续决策门

只有在上述迁移与验收完成后，才另行评审：统一索引读路径、线程表、源端写任务和删除旧兼容字段。任何把本 ADR 的 Proposed 内容描述成“已支持”的发布说明都不准确。
