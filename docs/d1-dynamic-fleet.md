# one-mail D1 动态分片与百人服务开发规范

> 状态：分阶段实现中；目标协议仍待完整验收，不是已上线能力。版本：0.2，日期：2026-10-08。
>
> 开发进度：观测采集、配额清理、registry 核心与 observe HTTP 接口、查询有界化已落盘。自动分配、所有写者的事务级 gate、受控迁移和百人灰度尚未完成；运行时只接受 legacy-static / observe。详见[实现检查点与验证记录](d1-fleet-implementation.md)。
>
> 规划口径：保留现有 2 个 Cloudflare 账户，再接入 10 个新账户，最多 12 个账户；每个账户第一阶段配置 1 个 D1。账户数是可配置的容量上限，不要求一次启用全部账户，不代表已经创建或验证这些账户。
>
> 结论：保留现有主站与按外部邮箱分片的架构，先实现统一路由控制、可靠遥测和新邮箱自动分配，再交付带写入隔离的迁移任务。100 人服务必须同时通过 D1、入口 Worker、聚合器、邮箱提供商和存储增长预算，不能仅凭 12 个库宣布容量达标。

## 1. 文档地位、基准与阅读顺序

本文件是动态分片目标行为的仓库规格源；Obsidian《one-mail D1 动态分片与百人服务开发规范》为镜像。生产事实以 Obsidian《one-mail 架构与部署运维》的最新核验记录为准。实现、生产状态、未来目标分别记录，禁止把本文件中的拟建 API、表或阈值当成当前代码。

阅读顺序：

1. [现有静态分片与迁移规范](unified-inbox-sharding.md)：当前已实现合同。
2. 本文件：动态模式的目标合同；只有某阶段完成验收并启用后，才替代该阶段对应的静态行为。
3. [首批分片迁移准备（PR #92 分支）](https://github.com/dengyie/one-mail/blob/ops/shard1-load-distribution/docs/superpowers/plans/2026-10-08-shard1-load-distribution.md)：试迁前检查、配额预算与维护窗口；该文件尚未进入本文的 main 基线。
4. [PR #92](https://github.com/dengyie/one-mail/pull/92)：迁移验证分页优化；截至本文基准尚未合并，动态迁移开发依赖其合入或等价修复，不能假设 main 已包含。

规格创建时的代码阅读基线为 main 的 29f3c17；实现分支基于更新后的 84066cb。下表记录规格创建时的现状，最新实现差异见实现检查点。分片 B 的准备版本和线上邮件数据来自 2026-10-08 已记录的核验；本文没有重新扫描生产邮件。

| 模块 | 当前代码依据 | 当前行为与扩展缺口 |
| --- | --- | --- |
| 分片表 | [shard_map.ts](../worker/src/unified/shard_map.ts) | v1，邮箱到分片映射；KV + isolate 60 秒缓存；有 generation 校验，没有动态分配事务 |
| 联邦查询 | [federation.ts](../worker/src/unified/federation.ts) | 列表按权限筛选分片；详情及部分操作仍涉及全分片探测 |
| 远程调用 | [shard_client.ts](../worker/src/unified/shard_client.ts) | HTTPS、独立 token、3 秒超时、单响应最多 16 MiB；不是 12 分片总内存预算 |
| 排序归并 | [shard_merge.ts](../worker/src/unified/shard_merge.ts) | O(K × L) 选择归并；offset 上限 500 |
| 计量 | [d1_quota.ts](../worker/src/core/d1_quota.ts)、[quota DO](../worker/src/core/d1_quota_coordinator_do.ts) | 包装 D1 结果计量；可选 DO 聚合；不覆盖账户内全部外部管理查询 |
| 管理端配额视图 | [quota_report.ts](../worker/src/unified/quota_report.ts) | 主库 + 已注册分片逐库扇出 `/shard/quota`；远程报文经 `isD1QuotaView` 校验，不符或不可达按原因码上报；空 `SHARD_MAP` 单卡且零 D1 读 |
| 管理端统计 | [statistics_api.ts](../worker/src/admin_api/statistics_api.ts) | 六条 `COUNT(*)` 合并为单次 `DB.batch()`(该页恰在 D1 读配额吃紧时打开)；配额卡片复用同一 `d1QuotaByShard` |
| 管理端库维护 | [db_api.ts](../worker/src/admin_api/db_api.ts) | 初始化与迁移共用同一有序 `repairSchema()`(CREATE IF NOT EXISTS + 逐列补全),避免两条路径修复序列静默分叉;状态读取失败先于任何 DDL 停止 |
| 薄分片 schema | [shard_schema.ts](../worker/src/unified/shard_schema.ts)、[schema.sql](../db/shard-schema.sql) | 邮件、文件夹、操作任务、清理任务及生命周期表；没有路由写入隔离表 |
| 账号生命周期 | [account_lifecycle_schema.ts](../worker/src/unified/account_lifecycle_schema.ts) | deleting/purged 防止删除后恢复；不是迁移锁 |
| 聚合器 | [config.py](../aggregator/src/one_mail_agg/config.py)、[uploader.py](../aggregator/src/one_mail_agg/uploader.py) | 本地配置单独保存分片；按目的地批量上传；失败不应推进同步水位 |
| 提供商操作 | [mutation_jobs.py](../aggregator/src/one_mail_agg/mutation_jobs.py)、[mutation_jobs.ts](../worker/src/unified/mutation_jobs.ts) | claim/lease/result；迁移要同时考虑提供商副作用与本地状态投影 |
| 迁移工具 | [backfill_shard.mjs](../db/backfill_shard.mjs) | copy/delta/verify/delete、检查点、实际写入预算；要求真实 quiescence |

技术栈维持 Node 24、pnpm 10.10.0、TypeScript 5.6 系列、Hono 4、Wrangler 4、Vue 3/Naive UI、Python >=3.11 和现有 requests/imapclient。文档不要求安装 ORM、通用分库中间件、Redis、Kafka 或 Kubernetes。Python 现有阻塞 I/O 只能在有界工作线程/进程中运行；本项目不为分片重写整个提供商生态。

## 2. 现状与目标边界

### 2.1 已核验现状

| 项目 | 当前事实 |
| --- | --- |
| 主库 | one_mail_db，承担全部生产邮件路由 |
| 分片 B | one_mail_shard1，已部署并补表，邮件数仍为 0 |
| 路由 | 主 KV 的 one-mail:shard-map 尚未配置；聚合器 shards 为空 |
| 主库快照 | 24,569 封邮件，190,537,728 bytes，约 182 MiB |
| 流量集中 | qq-main 20,317 封，约占邮件数 83%；邮件数量不等于实际读写负载 |
| 配额快照 | 2026-10-07 UTC 的中途观测：主账户读 3,055,780 行、写 20,621 行；不是完整日结，含后台及核查操作 |
| 迁移 | 尚未复制、切流、删除源邮件；首批维护窗口尚待安排 |

不得用“当前总用量 / 猜测的当前用户数 × 100”做容量结论。历史 received_at 分布也不能代替当天实际入库量。

### 2.2 目标与非目标

目标：

- 当前无远程映射时行为不变；静态模式可长期运行。
- 新邮箱首次同步前完成幂等自动分配，已有邮箱保持稳定归属。
- 支持最多 12 个已登记账户、第一阶段 12 个数据库；主库保留中心业务，最多 11 个远程分片承载外部邮件。
- 100 注册用户、100 日活用户、100 同时在线分别建模并验收；以 100 日活、20 常态并发、100 突发并发作为规划场景，不视作已测容量。
- 迁移可暂停、续跑、审计；任何可见成功写入只能归属于一个有效 owner。
- 任一分片故障不会被伪装成空邮箱或成功写入。

非目标：

- 不做随机 SQL 路由、跨库 JOIN 引擎、跨账户分布式事务或自动双主。
- 不把旧库残留当成实时副本，不承诺分片失联后无损即时切到空库。
- 不自动注册 Cloudflare 账户、升级付费套餐或无限创建数据库。
- 不改变现有发信、OAuth/refresh token 轮换、权限归属和原生域名收信路径。
- 初版不做无停写在线搬迁；已有邮箱迁移仍需要该邮箱的受控写入窗口。

原生 cf_routing 邮件固定主库是本项目的部署决策。Cloudflare 域名归属约束接收入口，不等于平台从技术上禁止转发入站内容；本阶段不引入这条额外转发链。

## 3. Cloudflare 配额、容量与百人模型

### 3.1 配额作用域

官方资料核对日期为 2026-10-08；部署前应重新读取账户面板及官方限制，不能把本表当成永久配额。

| 资源 | 免费限制 | 调度作用域 |
| --- | --- | --- |
| D1 rows_read | 5,000,000 行/UTC 日 | 同一 CF 账户所有 D1 合计 |
| D1 rows_written | 100,000 行/UTC 日 | 同一 CF 账户所有 D1 合计，含索引与 DELETE |
| D1 单库 | 500 MB | 每个数据库 |
| D1 库数/总容量 | 10 个 / 5 GB | 每个账户；本方案初期只使用 1 个 |
| Workers 请求 | 100,000 次/日 | 账户级预算；主入口不会因增加分片获得更多入口额度 |
| Workers CPU | 10 ms/调用 | 每次调用；不等于网络请求只能持续 10 ms |
| D1 查询数 | 50 次/Worker 调用 | 每个 Worker 调用 |
| D1 SQL | 最多 100 个绑定参数、单查询最长 30 秒 | 每条 SQL；REST batch 也有整体时限 |
| D1 行/字符串/BLOB | 最多 2,000,000 bytes | 不是附件存储容量 |
| KV | 每日 100,000 读、1,000 写；删除/列举另有额度 | 账户级共享，不能每封信写一个路由或统计键 |
| Time Travel | 7 天 | 恢复能力，不是跨账户实时备库 |

每天 00:00 UTC，即北京时间 08:00 重置。读写超额会导致查询报错；代码层不主动熔断 ingest，也无法绕过平台配额墙。

12 账户各 1 库的账面上限为 6 GB 存储、每天 6,000 万行读/120 万行写；新增 10 个账户贡献的账面上限为 5 GB、5,000 万行读/100 万行写。这些数字不能作为统一额度池使用。

为中心业务保留主账户后，11 个远程库的容量硬上限合计为 5.5 GB。按每库 350 MB 规划，外部邮件目标容量合计为 3.85 GB。账户额度必须逐个满足，热点邮箱不能通过其它账户的空闲额度自动变小。

### 3.2 预算算法

统一使用 bytes、整数行数和 UTC 日。展示单位 MB 按 1,000,000 bytes 计算；MiB 按 1,048,576 bytes。容量上限还须核对 API 返回值，不能混用单位决定是否继续写入。

初始运营参数是可调整的工程预算，不是 Cloudflare 官方限制：

- 日常预计消耗目标：每账户 reads <= 3,500,000、writes <= 70,000，即官方额度的 70%。
- 每库常规容量目标：350,000,000 bytes。
- 剩余 30% 用于突发、后台清理、测量误差及迁移；不能把这部分同时重复预订。
- 迁移另设显式 reservation；账户可用额度 = 官方上限 - 已观察消耗 - 未观察消耗保守值 - 已保留预算 - 剩余日常流量预算。
- 多库同账户时先聚合账户读写/Worker/KV消耗，再评估单库容量，不按库数重复发放读写额度。

容量下界：

~~~text
按容量需要的库数 = ceil(预计保留物理数据 bytes / 350,000,000)
按读取需要的账户数下界 = ceil(预计每日扫描行数 / 3,500,000)
按写入需要的账户数下界 = ceil(预计每日写入行数 / 70,000)
~~~

这些只是理论下界；还要验证不可拆邮箱、主库固定业务、路由扇出、账户已有其它项目、迁移预算和提供商限流。

### 3.3 100 人的示例模型

以下均为合成规划输入，不能冒充测量。每人邮件量是其所有邮箱合计；每封物理大小是假设包括索引后的平均大小。完整保留 30 天仅用于演算；当前正文清理会保留元数据、星标可能长期保存，所以真实长期数据量可能更高。

| 场景 | 人均邮件/日 | 总邮件/日 | 假设平均物理大小 | 30 天数据 | 350 MB 目标下库数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 轻量 | 20 | 2,000 | 12 KiB | 737.28 MB | 3 |
| 常规 | 50 | 5,000 | 12 KiB | 1,843.20 MB | 6 |
| 大量 | 100 | 10,000 | 20 KiB | 6,144 MB | 18 |

大量场景已经超过初期 12 库的容量规划；不能靠自动调度解决。应先调整经产品确认的保留策略，或在现有账户增加数据库；后者只增加容量/执行实例，不增加每日读写额度。

若假设每封入库消耗 20 行写，上述三档分别为 40,000、100,000、200,000 行/日，还未计入已读、星标、移动、任务、清理和迁移。上线前须用 D1 meta 实测每类操作的写放大，替换假设。

容量报告至少包含：过去 7 个完整 UTC 日的逐账户读写、逐类操作消耗、库体积增长、正常/星标邮件占比、正文清理效果、30/90/180 天预测、最大邮箱体积、附件对象存储用量和同步积压。

### 3.4 入口 Worker 与轮询预算

100 人每天各打开页面 8 小时，单次刷新周期的 HTTP 请求数为 r：

| 周期 | 刷新周期数/日 | r=1 请求数 | r=2 请求数 |
| --- | ---: | ---: | ---: |
| 30 秒 | 96,000 | 96,000 | 192,000 |
| 60 秒 | 48,000 | 48,000 | 96,000 |
| 120 秒 | 24,000 | 24,000 | 48,000 |
| 300 秒 | 9,600 | 9,600 | 19,200 |

这还没有计入登录、打开详情、手动刷新、发信、管理和内部接口。全免费百人模式的建议起点为可见页 120 秒探测、隐藏页暂停、失败指数退避至 300 秒并加入抖动；手动刷新合并并限速。这是待产品验收的行为变化，不能悄悄覆盖现有 30 秒下限配置。

浏览器可保持现有一个 API 入口；聚合器直接访问所属分片。若实测主入口预计请求超过日预算，应先优化请求合并、页面可见性和后台访问，暂停扩大活跃用户，不能宣称“12 个账户可以自动承载 120 万次主站请求”。

## 4. 架构与部署拓扑

~~~mermaid
flowchart TD
    UI["Vue 前端"] --> GW["主账户 Worker：鉴权 / 用户 / 发信 / 联邦网关"]
    GW --> PRIMARY["主 D1：中心数据 / cf_routing"]
    GW --> S1["分片 B Worker + D1"]
    GW --> SN["新增分片 Worker + D1，最多 10 组"]
    AGG["pxed 聚合器：有界提供商任务"] --> S1
    AGG --> SN
    GW --> REG["主账户 FleetRegistry DO：唯一归属与调度状态"]
    REG --> KV["KV：只读路由快照"]
    CTRL["pxed fleet 控制进程"] --> REG
    CTRL --> S1
    CTRL --> SN
    CTRL --> METRICS["Cloudflare 账户级计量 API"]
~~~

FleetRegistry DO 是拟建控制面，负责低频分配、状态转换和预算预订，不参与每封邮件的 SQL 转发。现有 D1QuotaCoordinator DO 继续负责计量，禁止混合两者职责。

主账户仍是鉴权和入口依赖；主 D1、主 Worker 或 registry 所在账户故障不会被其它分片自动接管。此设计提供邮件分片隔离，不宣称全站跨账户高可用。

### 4.1 数据归属

| 数据 | 归属与约束 |
| --- | --- |
| 用户、权限、地址、API key、OAuth 状态、邮箱凭据、发信工作流 | 主库；凭据不复制到其它账户的 D1 |
| cf_routing 邮件及 raw_mails | 主库；现有事务与收信路径保持 |
| 外部 emails、mail_account_folders | 按 mail_account.account_id 整体归属 |
| mail_mutation_jobs | 与对应邮件同库；租约和结果回写遵循相同路由代次 |
| lifecycle tombstone | 主站及相关分片持久化；删除优先于迁移，不允许恢复已删邮箱 |
| attachment_gc | 对象所属存储域；不能把源邮件物理搬走误当作附件逻辑删除 |
| route owner、迁移任务、预算 reservation | FleetRegistry DO 持久化；KV 为可重建快照 |
| 迁移检查点与快照 | pxed 私有持久化目录；与任务 ID 绑定，不包含访问令牌 |

附件引用必须保留 storage locator；跨库搬迁邮件不隐式搬迁 R2 对象。访问附件仍经鉴权；旧存储凭据至少保留到引用清理完成。若现有 raw_ref/attachments_json 无法唯一标识对象所属存储，自动迁移资格检查必须拒绝该邮箱，先补显式 locator 和验收。

### 4.2 务实的模块边界

- 纯策略函数只接收类型化快照、当前时间和配置，输出分配/迁移建议；不访问 Hono、D1、DO、网络或随机源。
- DO storage、分片 HTTPS、Cloudflare Metrics、检查点文件分别是外部 I/O 边界；为它们提供可替换测试接口。
- 网关负责鉴权、作用域与响应；控制进程负责执行持久化任务，策略不直接发起迁移。
- 复用现有 HTTP 客户端、分片 schema、迁移投影校验、mutation lease 和 provider identity。
- 不给每个单实现函数增加 interface/facade，不引入第二套邮件模型或通用 SQL 解析器。

## 5. 配置与数据契约（拟建）

### 5.1 模式

| 模式 | 行为 |
| --- | --- |
| legacy-static | 当前 v1 映射及空映射本地语义；不开自动分配 |
| observe | 读取统一注册表、收集指标、输出计划；不写 owner |
| allocate | 新邮箱自动分配；已有邮箱不自动搬迁 |
| rebalance | 只在批准的策略与维护窗口内执行合资格迁移 |

模式是部署级开关，迁移中的邮箱状态另行管理。进入 v2 后路由缺失必须返回明确错误，不允许回退主库；只有已验证从未启用 federation 的 legacy-static 才能解释为空 map。

### 5.2 类型字段

以下为目标开发合同，当前已落盘的严格类型以 worker/src/fleet/contracts.ts 与实现检查点为准；表中迁移实体尚未接入运行时。跨语言 JSON 字段使用 snake_case；容量/计量为安全整数，超过 Number.MAX_SAFE_INTEGER 拒绝解析并报计量溢出；代次是十进制字符串，在服务端按整数比较。所有 API 时间用 UTC ISO-8601；既有邮件时间字段按原合同保留，迁移不改时间基准。

| 实体 | 必需字段 |
| --- | --- |
| CloudAccount | account_key、provider_account_id、enabled、credential_ref、daily_read_limit、daily_write_limit、worker_request_limit、metrics_observed_at |
| Shard | shard_id、account_key、database_id、base_url、credential_ref、state、schema_version、protocol_version、storage_limit_bytes、observed_size_bytes |
| MailboxRoute | mail_account_id、owner_shard_id、epoch、state、migration_id（可空）、updated_at |
| FleetSnapshot | v=2、revision、published_at、mailbox_routes、shards（仅非敏感字段） |
| MetricSnapshot | account_key、utc_date、observed_at、source、rows_read、rows_written、worker_requests、confidence、shard_sizes |
| BudgetReservation | id、task_id、account_key、utc_date、reserved_read、reserved_write、reserved_bytes、state、expires_at |
| MigrationTask | id、mail_account_id、source、target、source_epoch、target_epoch、state、checkpoint_ref、manifest_digest、lease_owner、lease_expires_at、controller_term、deadline_at、error_code |

Shard.state 为 prepared/healthy/draining/degraded/exhausted/disabled。MailboxRoute.state 为 active/frozen/deleting；具体迁移进度由 MigrationTask 表达，避免两个独立迁移状态源。MetricSnapshot.confidence 为 authoritative/partial/stale；authoritative 表示账户 API 来源，仍有观测延迟，不代表实时余额。

credential_ref 仅由可信服务解析；浏览器、公共接口和 KV 路由快照均不得出现真实 token。现有 v1 中随端点存放的 token 在迁入 v2 时转存服务端私有凭据仓，不在新旧两处长期保存。

路由公共字段的 TypeScript 目标合同如下；当前 contracts.ts 的分配返回值还区分 pending 与已确认 route，避免把预算预订误当成可同步状态。合同仅表达数据边界，不引入框架依赖：

~~~typescript
export type Epoch = string;
export type UtcInstant = string;
export type FleetMode = "legacy-static" | "observe" | "allocate" | "rebalance";
export type ShardState =
  | "prepared" | "healthy" | "draining" | "degraded" | "exhausted" | "disabled";
export type RouteState = "active" | "frozen" | "deleting";
export type Confidence = "authoritative" | "partial" | "stale";
export type MigrationState =
  | "PLANNED" | "PRECHECK" | "FREEZING" | "COPYING" | "VERIFYING"
  | "SWITCHING" | "CLEANING" | "ACTIVATING" | "COMPLETED"
  | "PAUSED" | "ABORTED" | "FAILED_REQUIRES_RECONCILIATION";

export interface PublicShard {
  readonly shard_id: string;
  readonly account_key: string;
  readonly base_url: string;
  readonly state: ShardState;
  readonly schema_version: number;
  readonly protocol_version: number;
  readonly storage_limit_bytes: number;
  readonly observed_size_bytes: number;
}

export interface MailboxRoute {
  readonly mail_account_id: string;
  readonly owner_shard_id: string;
  readonly epoch: Epoch;
  readonly state: RouteState;
  readonly migration_id: string | null;
  readonly updated_at: UtcInstant;
}

export interface FleetSnapshot {
  readonly v: 2;
  readonly revision: Epoch;
  readonly published_at: UtcInstant;
  readonly mailbox_routes: Readonly<Record<string, MailboxRoute>>;
  readonly shards: Readonly<Record<string, PublicShard>>;
}

export interface MetricSnapshot {
  readonly account_key: string;
  readonly utc_date: string;
  readonly observed_at: UtcInstant;
  readonly source: "cloudflare_graphql" | "application_meta" | "reconciled";
  readonly rows_read: number;
  readonly rows_written: number;
  readonly worker_requests: number;
  readonly confidence: Confidence;
  readonly shard_sizes: Readonly<Record<string, number>>;
}

export interface AllocateRequest {
  readonly mail_account_id: string;
  readonly idempotency_key: string;
  readonly expected_revision: Epoch;
}

export type AllocationDecision =
  | { readonly ok: true; readonly route: MailboxRoute; readonly revision: Epoch }
  | {
      readonly ok: false;
      readonly error_code: "NO_CAPACITY" | "STALE_METRICS" | "REVISION_CONFLICT";
      readonly retryable: boolean;
    };
~~~

运行时校验不能由类型别名替代：epoch/revision 只接受规范十进制字符串，范围0到2^64-1，禁止前导零；UTC日期必须是真实日历日期，Instant必须以Z结尾；计量/容量必须为非负安全整数；shard_id与account ID限制长度并禁止路径字符；mailbox ID必须来自已授权主站元数据，不要求历史ID都是UUID。response中映射键必须与对象ID相等，所有owner必须引用已注册分片。

公共路由中不包含数据库ID与credential_ref；内部CloudAccount/Shard配置保存在DO和运维清单。网关token解析自专用Worker secret，聚合器/控制进程解析自权限0600的私有配置；不为动态配置把密钥回写KV。密钥轮换以credential版本发布，短期双版本只服务正在升级的节点，节点确认后撤销旧版本。

### 5.3 单一事实源与初始化

1. v2 首次登记必须遍历现有元数据、静态聚合器账号和 v1 map；每个现有邮箱显式登记 owner，包括仍在 primary 的邮箱。
2. 非空邮件邮箱不能走“新邮箱自动分配”，必须导入已有 owner 或迁移。
3. FleetRegistry DO 事务是唯一分配提交点；幂等键绑定 mailbox ID 与请求内容，相同键不同内容返回 409。
4. registry revision 与 mailbox epoch 各自单调递增；回滚也是新 epoch，禁止恢复旧数值。
5. KV、网关缓存及聚合器磁盘缓存都是有版本的派生快照；KV 丢失可重建，不能重新决定归属。
6. 聚合器动态模式从 registry 拉取 owner，配置文件只保存服务地址和凭据引用；禁止同时手工维护一份可独立变化的 account_ids 分配表。
7. 静态迁移到动态采用显式导入工具和模式切换；禁止通过“配置读取失败就自动创建新路由”自愈。

新建邮箱涉及主D1元数据与registry，不能假装是一个原子事务。主库先以固定mailbox ID记录provisioning操作，新增routing_status=pending/ready/failed，原enabled字段继续表示用户意图；聚合器只同步enabled且routing_status=ready的记录。分配和目标gate完成后标ready；中途崩溃由同一操作ID恢复。无容量保留failed及明确错误，用户可重试或删除，不偷偷重新创建邮箱。现有邮箱在导入owner和gate核验完成后才标ready；静态模式保持原读取条件。

待建邮箱的有限重试不能保存无限失败记录；管理员列表显示待配置原因。完成删除时先写tombstone并终止对应provisioning任务，再清理元数据，使晚到分配响应不能重新激活邮箱。

### 5.4 内部 API

所有拟建内部 API 使用独立服务身份；fleet 控制权限与普通 ingest 权限分离。管理用户只能通过主站鉴权后的管理接口使用。跨账户 HTTPS 禁止任意 URL、重定向和客户端传入认证头；目标 origin 必须在受管清单中。

| 接口 | 请求与关键结果 | 幂等/权限 |
| --- | --- | --- |
| GET /internal/fleet/snapshot | ETag/revision；返回调用方可见非敏感路由 | 网关/聚合器只读身份 |
| POST /internal/fleet/allocate | mail_account_id、idempotency_key、expected_revision；返回 owner、epoch 或无容量原因 | 创建邮箱编排服务；原子首次分配 |
| POST /internal/fleet/plan | 指标快照版本与目标；返回预计收益、成本、拒绝原因 | 只读计划，不改变 owner |
| POST /internal/fleet/migrations | 计划 ID、幂等键、维护策略 ID、expected_epoch | fleet 管理权限；持久化任务 |
| GET /internal/fleet/migrations/:id | 阶段、进度、预算、错误、下一步 | 不返回邮件正文/令牌 |
| POST /internal/fleet/migrations/:id/pause | 在完成当前原子块后暂停 | 幂等；不自动解除 fence |
| POST /internal/fleet/migrations/:id/resume | expected task version | 重做预算、lease 和 fence 检查 |
| POST /internal/fleet/migrations/:id/abort | expected task version | 按迁移阶段判断能否撤销 |
| POST /shard/control/route | mail_account_id、epoch、mode、migration_id | 仅控制服务；持久化本地 gate |
| GET /shard/control/status | schema/protocol、gate、健康、计量时间 | 仅控制服务 |

所有批量 ID 请求最多 100 个，超限返回 400，不静默截断。5 秒内没有形成分配结果返回 503，调用方用同一幂等键重试；不得让邮箱进入正常同步状态。未知邮箱返回 404；版本冲突/旧代次 409；停写中的邮箱 423；超配额 429；控制面不可达或目标暂不可用 503。服务端返回稳定 error_code、request_id、retryable 和适当 Retry-After，正文不含底层密钥或 SQL 参数。

## 6. 遥测与新邮箱自动分配

### 6.1 可靠计量

- D1 meta 在当前执行链聚合，用于操作成本画像；已有计量 DO 对重复 delta 去重。isolate 未 flush 就退出仍可能漏计，不能据此承诺硬余额。
- Cloudflare GraphQL 账户级日累计每 5 分钟采集，覆盖其它库、管理查询及迁移等消耗；初期先验证账号 token 权限和 API 限流。
- 同一口径的累计计数不能将 meta 和 GraphQL 简单相加。使用较大累计估计值，并加上最新观测之后的保守流量预算；差异过大标记 partial。
- 指标超过 15 分钟未更新、日期不匹配或计数倒退，不分配新邮箱、不启动迁移；已有路由仍可服务。
- 启动后至少取得连续 3 份有效样本再自动分配；不足 7 天的邮箱不能以短期均值认定有低迁移成本。
- 单账户 KV 快照最多每 5 分钟一写，即 288 次/日；现有 120 秒计量发布如保留约 720 次/日，必须合并或替换，不能再叠加 288 次突破 1,000 写额度。
- 配额 DO 的 delta 去重记录必须按有限天数分批清理并验证重放窗口，禁止形成无限增长集合。
- 无邮件正文、收发件人、OAuth token进入遥测；按匿名 mailbox ID 记录操作计数即可。

### 6.2 分配算法

每次分配对受管 S 个分片扫描一次，S 初期 <=12，O(S)；稳定请求通过 Map 按 mailbox ID 查找 O(1)。不为 12 个节点引入调度堆或复杂全局排序。

1. 去除 disabled/draining、schema/protocol 不匹配、健康失败、指标过期的分片。
2. 默认不向 primary 分配新的外部邮箱；全部候选不可用时返回 NO_CAPACITY，不回退主库。
3. 依据账户预计日读写与该库预计保留大小预留容量；同账户多个库共享账户 reservation。
4. 对新邮箱没有画像时，使用运营配置中的 initial_history_limit、预估日收信量、首次同步最大批量和实际采样的保守写放大。默认沿用现有首次同步窗口，禁止无界历史回灌。
5. 主评分取读、写、存储、Worker 请求预计占用比例中的最大值，避免某一个已接近上限的资源被其它空闲资源平均掉。
6. 若多个候选的主评分相差 <=5 个百分点，优先同一用户已有分片，减少日常列表扇出；最终按 shard_id 稳定决胜。亲和性不是强约束，不能压过容量门槛。
7. 在同一个 registry 事务内校验快照版本、扣除 reservation、写入首次 owner；竞争失败重算，不能两个执行器各分配一次。
8. 先在目标写入 ACTIVE gate，再发布 owner；收到目标确认后才允许首次同步。超时用幂等任务查询恢复，不重复创建 mailbox。

启用分配前应使大多数普通用户涉及的远程分片数 <=2；这是优化目标，不是硬性邮箱数限制。容量模型按每人最多 3 个外部邮箱做压测，不据此悄悄限制已存在账号。

### 6.3 再平衡触发与收益门槛

初始建议阈值：

- 预计日用量或库体积 >=70%：停止向该分片分配新邮箱，生成容量告警。
- >=80%，且连续 3 个有效样本成立：生成迁移候选。
- >=90% 或已经耗尽：进入降级与恢复流程，不启动大规模迁移抢救。
- 低于 60% 并持续 30 分钟才恢复接收新邮箱，避免抖动。
- 同一邮箱迁移冷却期至少 7 天；全系统一次只运行 1 个迁移；同一源/目标账户不能同时执行其它大清理或回灌。

可迁移条件：有可靠历史画像、没有生命周期删除、没有未决提供商副作用、附件引用可解析、预计 copy+verify+cleanup 的双边预算和维护时间可满足，并且预计未来 7 天节省的源库读写大于迁移成本。容量即将不足可作为独立理由，但仍不能绕过预算和一致性。

候选按“缓解最紧张资源的收益 / 迁移成本”排序，邮箱数量有上限时 O(M log M)。持续最热的单个大邮箱不拆到多个分片；先检查慢查询、保留策略或为它分配独立库。

MaintenancePolicy至少包含enabled（默认false）、允许的UTC窗口、max_pause_seconds、单任务读写/bytes预算和最大邮箱规模。没有经过测量填写的维护时间预算时，只生成计划，不执行。reservation到期只有在证明相关块从未执行时才能释放；响应未知、进程失联或已开始清理不能按TTL自动归还余额。

## 7. 写入隔离与路由一致性

### 7.1 不能把 KV 当锁

现有 60 秒缓存和 KV 的最终一致性不能提供瞬时切换。动态模式要求每个拥有过该邮箱的数据库保存持久化 route gate；即使网关使用旧快照，源库也能拒绝旧写入。

拟建 mail_account_route_gate：

| 字段 | 约束 |
| --- | --- |
| account_id | TEXT PRIMARY KEY |
| epoch | 非负十进制字符串；服务端校验范围，禁止字典序比较 |
| mode | active / frozen / moved / deleted |
| migration_id | 当前迁移任务或空 |
| owner_shard_id | 当前应归属的分片 |
| updated_at | UTC 时间 |

网关、聚合器与内部 mutation 请求携带 mailbox ID、epoch、request ID；可信服务 token 仍须校验调用权限，epoch 不是鉴权令牌。

所有正常 ingest、文件夹更新、已读/星标/移动/删除、retention、mutation claim/result、账号级清理，都必须在**与业务写入相同的本地 D1 事务中**验证 gate 为 active 且 epoch 匹配。不能先读 gate、返回到应用后再独立写入。逻辑删除先取得生命周期/迁移互斥权，再以专用删除身份推进gate；不能通过普通业务接口绕过frozen。

迁移导入使用单独权限和 migration_id，只能写目标 frozen gate 对应的暂存数据；物理清理身份只能删除该任务已验证的源行。源 gate 变为 frozen 后，后续已在网络中的请求也必须失败；已完成事务的写入包含在后续扫描中。源gate=moved后普通读也返回路由冲突，不能让旧缓存从残留副本读出过期内容。

### 7.2 分配与业务写入的职责

registry 只决定 owner，不持有邮件内容。D1 gate 是执行这一决定的本地屏障，不是第二个可自行变更的 owner 源。gate 只能由受控状态机按更高 epoch 推进；控制面重放低 epoch 必须拒绝。

全局 registry 事务不能覆盖远程 D1，因此使用持久化状态机逐步执行、逐步确认，而非声明跨库事务。任何网络超时都视为“结果未知”，查询持久化状态后恢复，不通过重置任务或降低 epoch 消除错误。

旧 route 响应最多触发一次强制刷新并重试；写请求必须复用原始幂等键。持续 409 返回可重试错误，不向其它分片广播写入。

控制执行器也要隔离旧实例：MigrationTask增加单调递增controller_term；控制命令携带term与幂等op_id，分片gate持久化已接受term。同任务接管者先在registry取得新term，再让双边gate确认新term，之后才能继续复制/清理；未获双边确认不得推进。旧term命令与业务写入一样在本地事务内被拒绝，不能仅凭“执行器lease已过期”假设旧进程停止。

初始执行器lease为60秒、20秒续约；失去续约即停止发起新块。重启/接管重做双边gate与检查点核验。时钟用于超时，term用于隔离，不能把跨主机本地时间精度当成并发正确性的唯一依据。

### 7.3 提供商操作与并发删除

迁移前暂停该邮箱的新 claim，等待现有 mutation/outbound 任务完成；租约过期不证明远端 IMAP/Graph 操作没有执行。存在投递未知或副作用未知时必须对账后再进入复制，不自动重发。

账号删除与迁移共享同一 mailbox lease。deleting/purged 优先：未切流迁移停止；已切流由新 owner 执行逻辑删除并清理所有暂存副本。每个阶段都复核 tombstone，禁止 import 恢复已删除邮箱。

retention 不得跨过 frozen gate。已有全库 SQL 清理必须排除 frozen/moved 邮箱，不能只暂停聚合器就声称已经停写。

## 8. 已有邮箱迁移状态机

### 8.1 状态与持久化

~~~mermaid
stateDiagram-v2
    [*] --> PLANNED
    PLANNED --> PRECHECK
    PRECHECK --> FREEZING
    FREEZING --> COPYING
    COPYING --> VERIFYING
    VERIFYING --> SWITCHING
    SWITCHING --> CLEANING
    CLEANING --> ACTIVATING
    ACTIVATING --> COMPLETED
    PRECHECK --> PAUSED
    FREEZING --> PAUSED
    COPYING --> PAUSED
    VERIFYING --> PAUSED
    SWITCHING --> PAUSED
    CLEANING --> PAUSED
    ACTIVATING --> PAUSED
    PAUSED --> PRECHECK
~~~

PAUSED 记录原阶段和 checkpoint；从 PRECHECK 重新核验后回到原阶段，不能重置 owner、epoch 或已使用预算。任意阶段发生冲突进入 FAILED_REQUIRES_RECONCILIATION，禁止自动解冻。撤销只在按§8.4完成恢复后进入ABORTED，COMPLETED/ABORTED为终态。任务 lease 过期仅允许新执行器接管同一任务，不允许另起迁移。

### 8.2 原子阶段合同

| 阶段 | 必须完成的动作 | 进入下一阶段的凭据 |
| --- | --- | --- |
| PLANNED | 固定源/目标、成本估计、指标版本、维护策略、截止时间 | 审计计划与幂等任务 ID |
| PRECHECK | schema/protocol、源/目标权限、附件、生命周期、未决任务、双边配额、备份可恢复性 | 全部检查通过且预算 reservation 生效 |
| FREEZING | 暂停该邮箱同步及提供商任务，排空在途业务事务；源/目标 gate=frozen；所有相关写者确认 | 双边持久化 gate、聚合器确认、无未决副作用 |
| COPYING | 有界 keyset 复制 emails 与 folders；保留全部业务列/ID/时间/provider identity；目标冲突即停 | 每块 target durable acknowledgment 与检查点 |
| VERIFYING | 从头完整对账，不能仅用 received_at 水位；逐字段/摘要、集合与空文件夹核验 | 固定源快照 manifest 与目标精确匹配 |
| SWITCHING | registry CAS 提交 target owner 与新 epoch；源 gate=moved；目标仍 frozen，读可按已验证结果访问 | registry 提交记录、源拒绝旧写证明、目标数据证明 |
| CLEANING | 双边正常写者继续冻结；按实际配额删除已验证源邮件；核对目录与任务残留的清理条件 | 源邮件清理完成；无附件误删；检查点与账本一致 |
| ACTIVATING | 目标 gate=active，发布快照，聚合器确认新 epoch，恢复该邮箱同步 | 新写入/读取/操作回写 smoke 与积压恢复 |
| COMPLETED | 释放剩余 reservation，保留有限期审计与备份 | 完成摘要与下一次冷却时间 |

初版动态迁移有意让目标业务写入在源清理后恢复，以保留现有工具“清理时双边既有行稳定”的安全门槛。若窗口或预算无法覆盖全过程，不自动迁移该邮箱；继续静态归属并停止向该库新增邮箱。

暂停/失败后，不得为了恢复服务跳过删除保护、把“冻结”标志改成 true 或把目标直接视为成功。控制台必须明确显示该邮箱处于维护态。若确需先恢复目标、延期清理，需实现和独立验收基于不可变迁移快照与提交凭据的清理协议；本版不把它作为已支持捷径。

### 8.3 分页、校验与配额

- 复制使用源 (received_at,id) keyset；这个键只用于稳定遍历，不替代 UI 的 effective date 排序。
- 每块受行数、序列化 bytes、D1 绑定数、剩余时间四个预算约束；默认沿用现有小批量，不能以 1,000 行通用建议覆盖 100 绑定参数限制。
- 校验读取目标按源主键集合查询；完整列投影比较，不用 count 相同替代内容正确。
- 目标初始不能有不明来源的同邮箱记录。仅允许同 migration_id 已确认的重试数据；普通迁移不允许静默覆盖。
- 完整 delta reconciliation 保留，用于发现迟到时间戳、历史补录或不符合冻结约定的写者。严格冻结后仍出现差异，应停止并定位，不自动选一边覆盖。
- mutation jobs 不当作普通邮件复制；必须先排空活动任务，再根据保留策略处理终态审计。旧源 lease/token 在新 owner 不生效。
- 迁移开始前持久化 UTC 日预算；每次实际执行按 rows_read/rows_written 结算。响应丢失保留最坏预算 reservation，直到对账确认；跨 UTC 日只重置新日预算，不丢旧账。
- 源邮件物理清理不能触发附件 GC；源 gate 和迁移 tombstone 不随邮件删除，以阻断过期客户端。
- 原生 cf_routing 不进入该工具；没有 account_id 的历史孤立行先人工归属核验。

### 8.4 回滚矩阵

| 状态 | 安全动作 |
| --- | --- |
| owner 未切换、源未删除 | 确认目标没有正常业务写入后撤销暂存，源按更高 epoch 解冻 |
| owner 已切换、源未删除、目标仍冻结 | 对账后以更高 epoch 重新归属源；不能恢复旧 KV revision |
| 源已部分删除、目标仍冻结 | 优先续完同一任务；若回源，先从完整目标恢复被删源行并完整对账，再切 owner |
| 目标已恢复业务写入 | 新建反向迁移，合并新增/变更/删除事实；禁止直接改回旧 map |
| 源不可达且复制未验证完整 | 停止迁移；不能把目标半份数据作为完整邮箱 |

Time Travel 恢复后先隔离该库，核验 route epoch、删除 tombstone、提供商水位与 mutation 终态，避免恢复出旧 owner 或重新执行已完成的副作用。

## 9. 查询、路由与性能预算

### 9.1 避免 12 路常态扇出

- 普通列表只访问权限作用域内邮箱实际归属的分片，预先构建 mailbox→shard 与 shard→mailboxes 索引；不在每个分片遍历全部映射。
- 列表/详情响应提供非敏感 mailbox_id 路由提示，操作请求携带该值；服务器重新做授权和 email ID 归属校验，不能信任客户端提示。
- 现有 /emails/:id 直接链接继续可读：本地命中后缓存 ID→mailbox；未知 ID 只允许在用户有权限的分片内进行有界只读定位。定位成功后写操作只发给一个 owner，禁止探测式广播 mutation。
- ID 定位缓存只用有界内存或已有应用缓存，不为每封邮件创建一个 KV 写；缓存失效不能改变 owner。
- 管理员全量统计改成有界后台作业/分页快照，不让每个浏览器轮询对所有库做 COUNT 或全表搜索。

### 9.2 复杂度与资源上限

| 操作 | 目标 |
| --- | --- |
| 稳定邮箱路由 | Map 查询 O(1) |
| 单次分配 | O(S)，S<=12 |
| 用户权限与分片分组 | O(A)，A为本次授权邮箱数，单批<=100 |
| K 路列表归并 | 最小/最大堆按既有排序键取 L 条，O(K + L log K)，不全量排序 |
| 迁移复制/验证 | O(N) 行遍历 + 有界主键查验，不重复全邮箱排序 |
| 迁移候选 | O(M log M)，只在低频控制循环执行 |

保持现有 SQL effective date = COALESCE(internal_date,received_at) 与 UUID 的全序合同；参照 unified_list/cursor 的投影，不只看字段名。迁移期间只读取一个有效 owner，UUID 本身不能防止复制中的同一邮件出现两份。

交互请求总截止时间初值 3 秒；分片并发最多 4 个，排队也计入同一截止时间；原始请求取消应传到子请求。一个请求不无限重试。后台统计任务采用独立分页与检查点，不延长交互请求到几十秒。

目标资源预算：

- 单个远程列表响应最多 512 KiB，列表不携带完整正文；每页最多 100 条。
- 单个详情最多 8 MiB 解码响应，超限给出明确错误/受控导出入口，不静默截断正文。
- 一次交互请求分片缓冲总量 <=8 MiB，并发数与缓冲 bytes 双重限制；不能把旧 16 MiB 上限乘以 12。
- offset<=500 保留当前约束，超过使用 cursor；不允许查询每片 offset+limit 后无限丢弃。
- 不为单次用户请求发出超过 50 次 D1 查询；主站鉴权、定位与业务调用一并计量，留出余量。

### 9.3 部分失败与分页

列表部分分片超时可以返回已获得内容，但必须给出完整性状态及 unavailable mailbox 列表；count 只有全部相关分片成功时才代表精确总数。

部分结果不能生成可跨过缺失分片数据的“正常下一页”。返回 incomplete=true、next_cursor=null，前端保留当前已显示数据并提示重试；恢复后从同一已确认游标重新读取和按 ID 去重。权限变化、owner revision 变化时也必须重新验证 cursor 上下文。

详情/写入不能在所属分片失败时返回 404/成功空结果。不存在是 404；无法确认是 503；部分成功的批量操作返回逐项状态，不能整体伪报成功。

## 10. 聚合器与提供商容量

100 人并不等于 100 条 IMAP 连接。压测至少覆盖 300 个配置邮箱，其中活跃 IDLE 数、轮询数、OAuth 刷新数分别记录。

- 复用现有提供商实现与 token_store 唯一持久化路径，不能为每个 CF 账户启动一整套扫描所有邮箱的聚合器。
- 每个 mailbox 的同步与提供商 mutation 仍受同一串行生命周期保护；同一 refresh token 不并发兑换。
- 全局并发、每提供商并发、每邮箱在途任务分别有硬上限。初值由 pxed CPU/RSS/文件描述符和提供商实测决定，未压测前不自动拉满 300 个 IDLE。
- 网络调用有超时和终止信号；阻塞 requests 运行于有界执行器，不阻塞所有邮箱调度。
- 分片超额时保留同步水位，仅延迟对应邮箱；上传局部成功后重试依靠 provider identity 幂等。禁止失败仍推进 last_uid/seen。
- 需要落盘缓冲时使用现有持久目录并设置总 bytes、单邮箱 bytes、最大保留时间和磁盘告警；不能无限缓存正文。
- 外部邮箱仍有原件且未被提供商删除时可补拉；“不推进水位”不能保证第三方永久保留邮件。原生收信失败也须保留真实失败和重试机制，不承诺零丢失。
- status/refresh_token 继续回主站，合并低价值状态更新；这部分主账户请求量纳入预算。

## 11. 运维、安全、故障与恢复

### 11.1 账户与部署清单

受管 fleet 清单按 account_key 分组保存非敏感元数据；每个 shard_id 对应一个 Worker 与 D1。新增账户逐个完成身份、API权限、D1/KV/DO可用性与配额核验后才登记 prepared。10 个新账户不是部署前提，也不是自动注册任务。

每账户使用最小权限 API token；部署、指标读取、运行时 shard token分离。密钥只在私有凭据仓/CI secret/Worker secret；公共 GitHub 仓库不得包含账户登录凭据、Global API Key、导出邮件或 token。跨账户新增服务优先复用当前 HTTPS 协议，不依赖跨账户 Service Binding。

所有分片发布同一源码版本，记录 schema_version/protocol_version；先 prepared 节点验证，再激活。CI 检测目标 account_key 与 database_id，禁止把主站 BACKEND_TOML 覆盖成分片配置。失败不继续批量发布后续账户。

静态模式与 v2 的过渡兼容只为现有部署服务：完成全 fleet 升级且无 v1 调用后，下一版本删除 v1 写入适配和聚合器静态账户分配配置；保留静态运行模式作为明确产品能力，不保留两个可同时写 owner 的控制源。

### 11.2 故障矩阵

| 故障 | 应有行为 |
| --- | --- |
| 一个分片 429/耗尽 | 停止给它新增邮箱；对应列表标不完整，写入明确失败；不改 owner |
| registry 不可达 | 已确认 owner 可凭缓存访问，最终由本地 gate 校验；不分配、不迁移、不猜 owner |
| KV 快照过期 | 使用带版本的 registry读取；仍失败则显式降级，不变成空 map |
| 主 D1 配额耗尽 | 可能影响登录、权限、发信及主邮件；不能由其它库遮掩，恢复主账户并治理中心负载 |
| 主 Worker 请求额度耗尽 | 全站入口受影响；增加 D1 无效，必须降低请求率或调整已批准服务方案 |
| 目标导入超时 | 查询持久化检查点与幂等结果；保留预算，不盲目再删源 |
| pxed 进程重启 | 按持久化任务/lease继续；不因内存丢失解冻或重置水位 |
| OAuth/IMAP/Graph 限流 | 对该提供商退避；分片迁移不改变提供商限制 |
| 数据库恢复到旧时间点 | 隔离并重新同步 epoch/tombstone/水位；未核验前不得恢复写入 |
| 两账户同时不可用 | 各自对应邮箱不可用；不提供虚构全量视图或自动双主 |

告警包括：容量>=70/80/90%、预计 UTC 日耗尽时间、最旧同步积压、未决 migration 时长、route conflict、metrics age、聚合器 RSS/FD/磁盘、主入口请求预测。告警只含服务标识和 request/task ID。

### 11.3 审计与备份

记录操作者/服务身份、任务 ID、前后 epoch、源/目标、时间、预算、校验摘要与错误原因；不记录正文和认证头。迁移前备份必须实际验证可读/可恢复，不能只记录“备份成功”。

检查点、预算账本和 manifest 使用原子写入/事务持久化；保留 30 天审计初值，包含个人内容的备份设置更短且明确的保留与访问策略。过期清理按现有运维删除规范单独执行；本文件不授权删除生产数据或本地文件。

## 12. 开发阶段与文件责任

下表是完整开发责任清单；路径是否已实现、是否接入运行时以[实现检查点](d1-fleet-implementation.md)为准。每阶段独立评审、测试、灰度；下一阶段不得越过前一阶段安全门槛。

| 阶段 | 文件与责任 | 可交付行为 | 放行条件 |
| --- | --- | --- | --- |
| D0 基线与观测 | 修改 worker/src/core/d1_quota.ts、d1_quota_coordinator_do.ts；新增 aggregator/src/one_mail_agg/fleet_metrics.py | 账户计量、去重记录清理、容量画像；observe只出报告 | 7日数据口径、过期/重置/重复测试通过 |
| D1 单一 registry | 新增 worker/src/fleet/contracts.ts、registry_do.ts、routes.ts、registry_client.ts；修改 worker/src/unified/shard_map.ts、worker/src/worker.ts、worker/src/types.d.ts、worker/wrangler.toml.template | v1显式导入、v2快照、CAS和幂等；尚不自动分配 | 空映射旧行为回归、重启持久性、竞争分配测试通过 |
| D2 自动分配 | 新增 worker/src/fleet/placement.ts、db/2026-10-08-mail-account-provisioning.sql；修改 worker/src/user_api/mail_accounts.ts、aggregator/src/one_mail_agg/config.py、remote_accounts.py；新增 aggregator/src/one_mail_agg/fleet_registry.py | 新邮箱按预算/亲和性选库，provisioning完成后首次同步 | 并发100次同邮箱分配只出现一个owner；无容量不回主库 |
| D3 本地 gate | 新增 worker/src/unified/route_gate.ts；修改 ingest.ts、folders.ts、mutation_jobs.ts、retention.ts、shard_routes.ts、shard_schema.ts；新增 db/2026-10-08-mail-account-route-gate.sql | 所有写者遵循epoch/frozen/tombstone | 全写者清单和事务竞态测试通过，旧客户端不能绕过 |
| D4 查询规模化 | 修改 federation.ts、shard_client.ts、shard_merge.ts、cursor.ts；修改 frontend/src/api/index.js、frontend/src/views/UnifiedInbox.vue | 有界定位与扇出、heap归并、不完整分页、可见性轮询 | 12分片混合权限/失败/排序/内存测试与100人请求预算通过 |
| D5 受控迁移 | 新增 worker/src/fleet/migrations.ts、aggregator/src/one_mail_agg/fleet_controller.py；扩展 db/backfill_shard.mjs及测试；扩展 uploader.py、mutation_jobs.py | 持久化任务编排，继续复用现有复制/校验逻辑 | 每阶段崩溃/重复/超额/并发删除测试通过；PR92或等价优化已合入 |
| D6 管理与发布 | 新增 frontend/src/views/admin/D1Fleet.vue、scripts/deploy-d1-fleet.mjs、.github/workflows/shard_deploy.yaml；修改router与i18n | 管理界面、计划预览、逐分片发布与版本检查 | 最小权限验证、secret扫描、单节点失败停止后续发布 |
| D7 灰度与百人验收 | 新增 e2e/tests/api/d1-fleet.spec.ts；增加本地fleet测试拓扑与负载脚本；更新本文及静态规范 | 两库试点→小批新增→最多12库；从observe到allocate再到rebalance | §13 全部阻塞项通过，真实用量报告经评审 |

D2首次 owner 提交依赖 D3的目标 gate确认，因此实现可先完成D2纯策略与API测试，但生产启用allocate必须等待D3；D4可以在静态映射下独立验证。不得按表格行号误判所有阶段可立即单独启用。

D1/D3改变协议，先发布只支持识别但默认关闭的schema与客户端，再导入路由，最后切模式。D5默认手动提交已预览计划；自动rebalance只在既有维护策略允许且所有预算新鲜时开启。

## 13. 测试、压测与验收

### 13.1 必须覆盖的回归场景

| 类别 | 具体输入/故障 | 期望 |
| --- | --- | --- |
| 分配并发 | 100个相同邮箱请求、同幂等键重试、不同键争抢 | 一个owner；预算只预留一次 |
| 创建中断 | 主元数据已写但registry未确认、目标gate已写但响应丢失、用户同时删除 | pending不进入同步；同操作恢复；删除后不激活 |
| 配额作用域 | 一个CF账户挂2库、另一个挂1库 | 前两库共享额度，不能各领10万写 |
| 计量 | GraphQL延迟/失败、delta重复、isolate退出、UTC午夜 | 标confidence；不双计，不把未知计量当0 |
| 容量 | 两片70%附近波动、目标80%、单邮箱超库容量 | 冷却/迟滞生效，无目标则拒绝计划 |
| 路由 | 缓存旧epoch、KV缺失、registry重启、v2空map | 旧写409，未知owner报错，无本地主库回退 |
| 安全 | 用户伪造mailbox_id、跨租户cursor、恶意目标URL | 403/400；不请求任意origin、不返回别人的内容 |
| 事务 | gate冻结与ingest/已读/retention并发 | 事务前完成或整体拒绝，无部分业务写入 |
| 任务租约 | claim后冻结、lease过期但提供商已执行、旧result迟到 | 不重复副作用，旧代次结果不能改新投影 |
| 迁移数据 | 同时间戳、迟到旧时间、空文件夹、正文含Unicode、星标、附件 | 身份/字段/时间/对象引用不变 |
| 迁移中断 | 每个阶段确认前后断网/杀进程/丢响应 | 从持久化状态恢复，预算不重置，源不误删 |
| 执行器接管 | 旧进程阻塞后恢复、新进程已取得controller_term | 双边新term确认后旧命令被拒绝，不能两个进程清理 |
| 内容冲突 | 目标同ID不同正文/时间/状态、冻结后源变化 | fail closed，不INSERT OR REPLACE掩盖冲突 |
| 并发删除 | 迁移任一阶段用户删除邮箱/账号 | 删除优先，不恢复tombstone |
| 回滚 | 部分源已删、目标已写新信、恢复旧快照 | 按矩阵恢复，不直接改map |
| 列表 | 1/2/12片、相同排序时间、第一页某片超时后恢复 | 无越权/重复/漏页；不完整页不给正常next_cursor |
| 资源 | 12片同时慢/超大响应、客户端取消 | 并发<=4、总缓冲受限、所有子请求有截止 |
| 聚合器 | 单分片失败、混合批部分成功、重启、提供商限流 | 其它目的地仍处理，失败邮箱水位不推进 |
| 部署 | 一个分片schema旧、token错、registry版本超前 | prepared不激活，发布停止并保留旧服务 |

### 13.2 验证命令与环境

以下是实现阶段的验证命令；已经执行的命令、结果与尚未验收项记录在实现检查点。复用现有依赖环境，安装或下载大于10MB的单个软件包需按工作区规则另行处理。

~~~bash
pnpm --filter @one-mail/shared build
pnpm --filter @one-mail/worker typecheck
pnpm --filter @one-mail/worker lint
pnpm --filter @one-mail/worker test
pnpm --dir db test
pnpm --filter @one-mail/frontend typecheck
pnpm --filter @one-mail/frontend test
pnpm --filter @one-mail/frontend build
~~~

Worker package script 已改为 Node test runner 自动递归发现，与 CI 的 src 递归清单核对，包含 fleet、根目录 scheduled 和 cors 测试。聚合器在已安装项目依赖的Python环境中，于aggregator目录运行 python -m pytest。E2E复用e2e目录的Docker/Playwright配置，新增fleet拓扑必须在本地/测试数据上运行；现有 pnpm --dir e2e test 不能被误称为已覆盖12分片。

### 13.3 百人验收数据集与门槛

先完成本地真实SQLite/Worker集成和合成流量，再进行受预算限制的远程抽样；不在免费生产库上无预算压测。

- 100用户、300邮箱配置、20持续并发和100突发并发；分别运行1/2/12分片。
- 常规集15万封（100人×50封×30天）与倾斜集（一个邮箱占80%请求），包括空邮箱、长正文、星标、已删账号和多种提供商身份。
- 60分钟稳定负载 + 30分钟单节点故障/恢复；资源无持续增长、每次重启任务可续跑。
- 同一测试地区的健康列表/详情接口p95目标<=1.5秒、p99<=3秒；健康时错误率<0.1%；这些为验收目标，不是现有SLA。
- 100人请求模型下，每账户预计日读写与主Worker请求<=70%预算；记录实际每操作rows_read/rows_written和多片放大系数。
- 零跨用户数据泄漏、零已确认写入丢失、零未授权源删除、零提供商副作用重复；故障注入中失败必须对用户可见。
- 迁移维护时间必须实测并小于计划deadline；不承诺“几分钟迁几万封”。
- 线上灰度保留7个完整UTC日的计量和恢复证据，才从2片扩大到下一批。10个新账户可先登记prepared，未通过预算/健康验收不激活。

若入口请求、提供商限流或存储增长不能满足门槛，结论为“尚不具备100日活容量”，即使全部12库部署成功也不能放行。

## 14. 社区方案与决策记录

| 方案 | 可复用知识 | 本项目决策 |
| --- | --- | --- |
| Cloudflare D1 Read Replication | Sessions API、读副本路由、顺序一致性 | 可单独评估读延迟；不替代跨账户额度调度，也不增加免费行额度 |
| CollegeDB | Rendezvous hashing、分片策略、迁移工具接口 | 不直接引入其迁移实现：当前源码先复制/删除源再更新映射，缺少本项目的gate、多表和提供商副作用合同 |
| LulaEdge | 跨库查询编排、遥测与schema批量操作 | 不作为邮箱动态迁移引擎；其README中的migrate主要是表结构操作，且增加独立控制服务依赖 |
| 自建轻量fleet控制 | 复用现有account分片、provider幂等与迁移校验 | 选用；新增代码围绕单一registry、预算与任务状态，不替换业务数据层 |

Rendezvous hashing可用于稳定决胜，但不能感知账户当天额度、邮箱大小或执行数据迁移，因此本方案采用显式owner映射＋负载评分；增加节点不会自动重算所有旧邮箱归属。

## 15. 开发前检查清单

- [ ] 确认“新增10个、总计12个”的规划口径及实际可用账户。
- [ ] 更新生产快照，确认PR92状态；保留未切流事实，不能从文档推断已迁移。
- [ ] 采集7个完整UTC日数据，确定每操作成本、星标增长、入口r值、提供商连接预算。
- [ ] 先完成registry与所有写者gate，才启用allocate/迁移。
- [ ] D1字段/索引迁移进入部署自愈步骤，不依赖管理员手工点击初始化。
- [ ] 在测试环境完成故障矩阵与恢复演练，特别是部分源删除后的恢复。
- [ ] 第一批仍采用小邮箱、单任务、明确维护窗口；不一次搬迁20,317封热点历史邮箱。
- [ ] 新能力、开关状态、协议版本、实际验收结果回写仓库与Obsidian，更新router和项目索引。

## 16. 官方与社区资料

- [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 Read Replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [CollegeDB](https://github.com/earth-app/CollegeDB)、[migration实现](https://github.com/earth-app/CollegeDB/blob/master/src/migrations.ts)、[路由实现](https://github.com/earth-app/CollegeDB/blob/master/src/router.ts)
- [LulaEdge](https://github.com/RodrigoManzanares/LulaEdge)

所有社区能力以实际源码和部署验证为准；本文没有证明任何第三方框架已经适配one-mail的生产迁移。
