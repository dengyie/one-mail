# D1 Fleet 实现检查点

> 更新：2026-10-08。分支：`feat/d1-dynamic-fleet`，基线：`84066cb`。
>
> 当前交付是动态分片的观测与查询基础。生产仍按既有静态路由运行；本轮没有创建 Cloudflare 账户、改 owner、迁移邮件或启用控制进程。完整需求以[开发规范](d1-dynamic-fleet.md)为准。

## 1. 可运行范围与安全边界

`FLEET_MODE` 默认 `legacy-static`；`observe` 允许独立服务身份访问观测接口。两种模式的数据请求均继续使用现有静态路由。配置为 `allocate`、`rebalance` 或未知值时，Worker 在访问数据前返回 `503 MODE_DISABLED`；Email Routing 拒收，定时任务失败，避免把未接入的动态配置静默解释成本地路由。

`FleetRegistryDurableObject` 核心已经具有 CAS、幂等导入、预算预订、pending 分配、目标确认和 tombstone 事务。**这些底层能力没有暴露为生产 owner 变更 API**。邮箱元数据校验、目标 gate 与正常写者的事务隔离完成前，不能用手工 `gate_confirmed=true` 或 `known_empty=true` 绕过外围编排。

observe 的 plan 只是“当前预算能否容纳一个配置需求”的只读建议，不是已有邮箱迁移计划；不会扣预算、发布 owner 或创建迁移任务。历史成功幂等回执也不能代替当前路由和 gate 查询。

## 2. 已完成文件与行为

| 文件 | 已落盘行为 |
| --- | --- |
| `aggregator/src/one_mail_agg/fleet_metrics.py` | 固定 Cloudflare API origin；最多4账户并发；每响应512KiB；账户级读写/Worker请求和逐库容量；八日有界SQLite历史；UTC日结重采；三份相邻五分钟样本资格；失败/过期/倒退可见 |
| `aggregator/src/one_mail_agg/fleet_metric_report.py` | 将完整样本和显式剩余日需求映射到严格TS合同；拒绝null、partial、stale、账户/分片不符和溢出；不隐式外推日用量、不发网络请求 |
| `worker/src/core/d1_quota.ts`、`d1_quota_coordinator_do.ts` | 五分钟KV发布；去重保留当日加前两日；分批alarm清理；单调删除边界拒绝过期重放；未知/丢失计量标partial；过期队首不再永久阻塞新日flush |
| `worker/src/fleet/contracts.ts`、`validation.ts`、`placement.ts` | 严格DTO；uint64代次字符串；真实UTC日期；安全整数；同账户共享预算；O(S)最大资源占用评分、70%门槛和5个百分点亲和性 |
| `worker/src/fleet/registry_do.ts` | 单一持久化控制对象；CAS、请求指纹、重启重放、导入事务、pending/confirm分配、删除优先、预算保守预订和只读plan；相邻五分钟桶才累计有效样本；实际账户/数据库集合变化事务作废旧指标，退休账户清理，规划按当前账户键批量读取 |
| `worker/src/fleet/registry_client.ts`、`http_io.ts` | 固定DO绑定地址；整次请求5秒截止；流式body限额；取消与上游契约校验；公共快照排除数据库ID及凭据引用 |
| `worker/src/fleet/routes.ts`、`mode.ts` | 独立读/控制身份；有条件快照读取、configure、metrics、plan；未知/未完成API不透传；未完成动态模式拒绝启动 |
| `worker/src/worker.ts`、`types.d.ts`、`worker/wrangler.toml.template` | DO导出、类型/迁移绑定；主站服务入口在ASSETS和浏览器密码之前处理；分片不提供fleet入口 |
| `worker/src/unified/shard_client.ts`、`shard_merge.ts` | 并发≤4；共享3秒截止与8MiB解码body预算；列表512KiB；详情8MiB；堆归并O(K+LlogK)；取消保留原因 |
| `worker/src/unified/federation.ts`、`index.ts` | 一次作用域分组；每页≤100行且最多24次远程续页；不完整页不生成下一游标；只读定位后单owner写入，重新校验ID/权限/归属，共享定位及写入预算 |
| `frontend/src/api/contracts.ts`、`views/UnifiedInbox.vue` | 接收完整性字段；同分页边界失败时仅保留不可用邮箱的数据，恢复后替换；成功操作移除不再符合筛选的行，保留行的失败操作仍可回滚；不跨缺失数据推进游标 |
| `worker/package.json` | 测试自动递归发现，避免shell glob漏掉根目录和新增子目录测试 |

各模块关联测试已同步落盘。`frontend/src/router/__tests__/session_guard.test.ts` 补充联合类型收窄，只修改测试的类型表达。

## 3. observe 服务接口

主站使用独立的 `FLEET_READ_TOKEN` 和 `FLEET_CONTROL_TOKEN` Worker secret，两者必须不同，长度32–512个可打印ASCII字符。不要复用浏览器密码、用户token或shard ingest token。任一缺失或配置相同返回 `503 FLEET_AUTH_NOT_CONFIGURED`。

固定DO对象名为 `one-mail:fleet-registry:v2`，namespace为 `FLEET_REGISTRY`。这项绑定及 `fleet-registry-v2` SQLite DO migration只部署到主账户；不要通过主站模板覆盖薄分片配置。

| HTTP接口 | 身份 | 行为 |
| --- | --- | --- |
| `GET /internal/fleet/snapshot` | read或control | 严格v2公共快照；`ETag: "fleet-<revision>"`；匹配If-None-Match返回304；每次先鉴权并读取权威状态 |
| `POST /internal/fleet/configure` | control | `{expected_revision,idempotency_key,config}`；config为contracts.ts的FleetConfig，限制12账户/12分片/1000邮箱；已有引用的分片不能被换库、换账户或移除 |
| `POST /internal/fleet/metrics` | control | `{expected_revision,idempotency_key,report}`；report含完整样本和预计整日累计，不能用未知值补0 |
| `POST /internal/fleet/plan` | read或control | `{expected_revision,affinity_shard_ids?}`；只读、无幂等键；返回同revision及decision，不更改任何预订/owner |

`/allocate`、`/import`、`/confirm`、`/tombstone` 和 `/migrations` 等未完成服务接口返回404，即使持有control身份也不能调用。正常浏览器密码或ingest key不会授予fleet访问权限。`/internal/fleet/*` 不通过ASSETS，也不依赖主邮件D1或JWT配置才能读取registry。

configure/metrics的期望revision为规范十进制字符串。成功回执丢失时重试相同幂等键和完全相同的请求；不同内容同键返回409。另一操作导致CAS冲突时先读取最新快照，再显式提交新的操作；不能自动改写旧请求后重复使用原幂等键。

幂等回执保留30天，每次变更最多清理100个过期回执，总数上限200,000。budget reservation暂时保守持有：不会因confirm、日期切换或TTL自行释放；未实现可信核销前禁止生产分配。

计量配置、命令、私有历史文件权限与构造POST body的方法见[采集器说明](../aggregator/docs/fleet-metrics.md)。本阶段提供采集CLI和纯JSON适配器；未安装生产调度器或自动publisher。

## 4. 查询与配额的重要限制

- 8MiB是每次交互累计解码响应body预算，包含丢弃/已解析响应；不是JavaScript实际堆内存承诺。
- 3秒限制覆盖远程排队、读取及定位后写入。当前D1本地调用仍受平台自身执行限制，不能宣称整个HTTP链路具有可取消的3秒硬上限。
- 列表部分失败给出 `incomplete=true`、`unavailable_mailbox_ids`、`next_cursor=null`，精确总数置空；健康重试从原分页边界恢复。
- 邮件ID存在于两个有效邮箱归属时返回409并且不写入；错误分片的遗留行不能成为写入目标。
- D1 meta始终是局部观测，DO去重也不能把它升级为账户硬余额；调度使用独立账户API来源。
- 五分钟KV发布限制是每coordinator。初期一账户一片满足该拓扑；若一个账户多个coordinator共用KV，须先补账户级发布协调和KV预算，不能将多片各288次/日当作账户总计288次。

## 5. 验证与尚未证明的内容

本地环境复用已安装依赖，没有增加运行时依赖。Node为26.9.0、Python为3.14.7（现有聚合器虚拟环境）；CI仍按项目约定使用Node24/Python3.11，CI结果需独立核验。

| 检查 | 本轮结果 |
| --- | --- |
| Shared build | 通过 |
| Worker typecheck / 全量lint | 通过 |
| Worker完整测试 | 514通过，0失败 |
| Worker Wrangler bundle | dry-run通过，已识别FleetRegistry绑定 |
| 数据库工具测试 | 29通过，0失败 |
| 前端typecheck / build | 通过 |
| 前端完整测试 | 38文件、300通过，0失败 |
| 聚合器完整测试 | 602通过，0失败，包含97项collector/adapter测试 |
| UTF-8 / diff空白检查 | 通过，无BOM |

验证命令：

```bash
pnpm --filter @one-mail/shared build
pnpm --filter @one-mail/worker typecheck
pnpm --filter @one-mail/worker lint
pnpm --filter @one-mail/worker test
pnpm --filter @one-mail/worker build
pnpm --dir db test
pnpm --filter @one-mail/frontend typecheck
pnpm --filter @one-mail/frontend test
pnpm --filter @one-mail/frontend build
```

Worker build使用从模板生成的本地 `wrangler.toml`，是`--dry-run`。聚合器在 `aggregator` 目录以 `PYTHONPATH=src python -m pytest -q` 运行，确保测试工作树源码。

本轮不包含真实账户API权限验证、实际7日画像、12个真实Worker本地集群、100用户/300邮箱负载、端到端迁移故障演练，也未触及线上数据。通过单测不能代替D7容量放行。

## 6. 后续完整文件交付顺序

- [ ] D1运行时v2路由读取/私有凭据解析、显式导入工具、派生快照与缓存；观测态registry不是数据面路由源。
- [ ] D3 `route_gate.ts`、SQL迁移及所有ingest/folders/mutation/retention/删除写者的同事务校验；旧读owner冲突和controller term隔离。
- [ ] D2 `mail-account-provisioning.sql`、用户邮箱创建/删除编排、固定operation ID恢复、目标确认后ready、聚合器动态配置/读取与首次同步门槛。
- [ ] D0剩余：真实账户权限与日结验证、操作成本/附件/积压画像、计划预算核销及同账户多coordinator协调。
- [ ] D4剩余：mailbox路由提示/有界ID缓存、cursor权限和owner revision绑定、管理员后台统计、可见性轮询请求预算。
- [ ] D5 `migrations.ts`、`fleet_controller.py`、PR92分页优化或等价修复、复制/校验/清理检查点、双边预算与恢复矩阵。
- [ ] D6 `D1Fleet.vue`、逐账户部署脚本/workflow、版本核验、单节点发布失败中止。
- [ ] D7 fleet测试拓扑/E2E/负载脚本、两库维护窗口演练、7个完整UTC日灰度证据；再决定扩容数量。

这些条目是未完成工作，不是被默认为可兼容的旧逻辑。生产allocate/rebalance放行前必须逐项补齐相关安全依赖。

## 7. 本轮复核结论

审查范围为本分支变更、实际Worker入口、查询/操作调用链、TS/Python边界、配置和相关测试。没有把整个仓库都宣称为零缺陷。

本轮复核中已修复并覆盖回归的主要问题：

1. 同一五分钟内的三次快速遥测上报原可错误满足“三次有效样本”；`placement.ts`改为UTC五分钟桶，重复桶不增加资格、缺桶/失败重置。
2. 只读定位原会被错误分片的遗留副本403阻断，并未校验返回行的真实owner；`federation.ts`验证ID、邮箱与owner，单owner写入前再次校验权限，两个有效owner冲突时不写入。
3. HTTP解析器原拒绝所有重复头，合法重复Set-Cookie也导致计量失败；`fleet_metrics.py`仅对分帧/编码头保持严格重复校验。
4. 注册表损坏/超限响应原误报客户端400/413；现在作为上游故障503处理并保留原始异常链，合法409业务冲突仍保留。

确认删除的重复内容仅为无生产调用的 `fanOutApply` 函数及其导入，测试改走生产使用的“只读定位→单owner操作”。没有删除文件或生产数据。

独立复审又复现了三项P2，现已完成根因修复并用先失败后通过的回归验证：

1. 同逻辑键更换实际账户/数据库后沿用旧三样本资格：配置事务按账户ID与分片数据库集合比较并作废旧指标；新增分片也重新取得完整样本。凭据轮换和数组重排保留有效资格，失败提交原子回滚。
2. 退休指标挤掉第13条当前账户指标：配置移除账户时清理其指标；plan按当前最多12个账户键批量get，不再截取历史前缀前12项。覆盖满额账户多次替换与历史脏记录。
3. 部分刷新保留已不匹配筛选的行：只保留`unavailable_mailbox_ids`对应旧行；成功操作先移除失效筛选成员，再刷新。保留行沿用对象身份判断，所以刷新期间provider拒绝仍能回滚乐观状态。覆盖星标/未读/组合筛选及失败回滚。

随后在Cloudflare真实DO实例首次configure时复现503：Workers不支持`fetch`的`redirect: "error"`。注册表与分片客户端统一改为`manual`并显式拒绝3xx、取消响应流；服务边界保留传输错误异常链，避免诊断只剩503。新增`e2e/tests/api/fleet-registry.spec.ts`通过真实Worker/DO绑定验证configure、snapshot、plan和幂等重放，弥补Node模拟边界。

本地完整门禁合计1445项通过。Cloudflare隔离实例18项检查通过，覆盖换库/换账户重新资格化、满额12账户连续替换、幂等重放、权限隔离与条件快照。发布范围是静态/observe基础能力，生产数据面继续使用静态路由；隔离实例未绑定生产D1，不向生产registry写入合成配置。完整动态分配与迁移仍须先完成第6节安全依赖及D7验收。实际部署版本与线上测试结果以发布记录为准。

## 8. 发布后账号导出缺列修复

PR #96（`668a338`）发布后，UTC零点前正常列表因D1免费读配额耗尽返回500；零点后列表恢复，但`/admin/unified/mail_accounts`仍失败。生产`PRAGMA table_info(user_mail_accounts)`确认已有`can_send`，却缺少`smtp_host`、`smtp_port`、`smtp_ssl`和`proxy_policy`。导出查询无条件投影这四列；仅更新Worker或重启聚合器不能修复。

`db/2026-10-08-user-mail-accounts-smtp-proxy.sql`按现有`db/schema.sql`及管理员初始化器补齐四列。部署继续使用现有outbound迁移渲染器，改为逐列判断而非仅凭`can_send`跳过整份SQL；schema查询解析复用现有D1解析器。发布前自动执行新增迁移，不在请求热路径做DDL，不改账号凭据、发送权限或分片归属。复杂度为O(C)，C为受限的迁移列数。

回归覆盖生产旧表、只完成部分DDL的重试、已有SMTP值与加密凭据保留、重复执行零变更、新表初始化边界以及错误输入拒绝。四项测试先失败后通过。这个修复解决账号导出的缺列错误；UTC日配额重置只恢复当前可用性，不等于长期配额容量问题已经根治。

## 9. 测试驱动的运行恢复修复（2026-10-08）

基于 PR #98 的现有降量优化继续处理生产遗留的 claim 退避和数据库版本状态问题，不改变静态路由或启用动态分配。

- `aggregator/src/one_mail_agg/main.py`：mutation/outbound 各持有局部不可变 `ClaimSchedule`，共享一个串行循环。失败与不完整批次返回 `None`，按 60、120、240、300 秒退避；明确成功会重置失败退避，连续三次空领取后使用至少 60 秒间隔。计数和退避均封顶，时间由调用方传入，每步时间/空间 O(1)。截止时间从请求完成时计算；慢轮询完成后留出队列窗口。既有 provider 租约、幂等、unknown 投递及 token 兑换锁保持原合同。
- `worker/src/admin_api/db_api.ts`、`core/settings.ts`、`packages/shared/src/index.ts`：沿用四字段 `DatabaseStatus` DTO。仅无应用表时允许初始化；有表但无 marker 时提示迁移。元数据/版本读取失败保留异常链并返回 HTTP 错误，初始化/迁移在此时不执行 DDL。元数据表名从初始化契约生成，查询结果有固定上限；不读取邮件行。实际结构修复先补 `address.source_meta` 再创建其索引，删除已由结构检查覆盖的旧版本分支，所有修复成功后才写版本。
- `worker/src/core/db_schema.ts`、`unified/schema.ts`：复用一次 PRAGMA 和列名 Set 判断缺列，按表原子批量补齐；索引、默认值和 provider 回填分组执行。结构判断为 O(C)，C 为静态迁移列数。并发补列冲突必须重新确认全部所需列存在；部分补齐仍报错。初始化/迁移原有 68–85 次 D1 绑定调用超过免费档单次 50 次上限；回归实测新库 39 次、已初始化热 Worker 32 次、冷 Worker 38 次、legacy 表 41 次，测试预算限定为 45 次，为鉴权等外围操作留余量。批处理减少绑定请求，不减少 SQL 扫描或索引写入计费；不能据此推断日配额容量。
- `frontend/src/views/admin/DatabaseManager.vue`：单次执行保护、强类型响应校验、页面生命周期取消；POST 后必须读到当前版本才提示成功。失败时隐藏旧操作建议，提供仅 GET 的状态重试，避免重复提交。中英文操作说明同步到 `vitepress-docs/docs/{zh,en}/guide/ui/d1.md`。
- `e2e/fixtures/test-helpers.ts`：Mailpit v1.29 的 [WebSocket 实现](https://github.com/axllent/mailpit/blob/v1.29.0/server/websockets/client.go)会将多个 JSON 事件用换行拼入一条消息。测试监听器此前整条解析且吞错，导致已投递邮件等待超时；现在逐行解析，解析/谓词错误保留 cause 并立即失败，连接未就绪时关闭或超时也会结束两个等待并清理连接。9 项确定性测试进入 Docker E2E 入口，不增加重试或延长超时。

新增 78 项回归（队列 19、数据库状态/迁移 37、管理页 13、E2E 助手 9）。原实现先复现重试过频、队列相互拖延、慢轮询饥饿、异常被吞、旧表缺列迁移失败、D1 调用预算超限，以及管理页重复提交/假成功；修复后本地全量 Worker **553**、前端 **314**、聚合器 **621**、数据库工具 **33**、E2E 助手 **9**，共 **1530** 项通过。真实 SQLite 验证补列批次失败原子回滚、重放保留邮件及并发完整性检查；Mailpit 合并事件与连接生命周期测试先复现 8 项失败后全部通过。Shared build、Worker typecheck/lint/bundle、前端 typecheck/build 及管理页编译脚本类型检查通过。Docker 本机不可用，E2E 由 CI 独立验证，不能以这些单测替代线上验收。

这些修复限制故障期间的请求放大，并修正状态判断；不表示外部网络超时根因消失、D1 长期配额足够或百人容量已验收。完整 schema 迁移仍是低频管理员动作，不是每次状态查询都运行的操作。线上部署与实际验证以发布记录为准。

## 10. 每日写额度故障的修复与恢复边界（2026-10-08）

生产 Worker 已明确报告 D1 免费账户每日写额度耗尽，ingest 与状态回写返回 500。Cloudflare 账户小时指标在 04:00–05:00 UTC 记录 150,233 rows_written，与当时管理页补建旧邮件索引的时间重合；六个索引乘约 2.5 万旧邮件与该规模一致，但这不是逐条写入归因。配额重置是外部恢复条件，发布代码不能清零当日已用额度。

- **减少重复写入**：`insertEmails` 只对未插入的重放邮件刷新 provider 元数据，SQL 仅在字段实际变化时更新。新邮件不再紧接着做重复 UPDATE；Graph 移动、真实元数据变化仍更新，用户已读/星标/正文保持不变。文件夹心跳最多五分钟更新一次，名称、类型、UIDVALIDITY 和错误清除立即生效；在同一 INSERT SELECT 中排除未变化行，避免无变化 UPSERT 仍推进 AUTOINCREMENT。目录身份索引提供单行查找，未增加逐行网络请求；批次处理 O(n)，邮件账号判断沿用 O(1) Map。
- **维护预算**：主库管理员初始化/迁移在任何 DDL 前读取有界 schema 元数据，并按缺失索引数量限制邮件计数上限。维护可用量取 `max(0, 70000 - observed rows_written)`；保守模型超过该量返回 `409 D1_MIGRATION_WRITE_BUDGET`，附缺失索引、估算值、是否触及抽样上限和遥测置信度。无需索引修复时不数邮件。元数据或计数失败不执行 DDL、不推进版本。此检查只约束主库管理接口的邮件索引构建；partial index 可能高估，全部回填、其他表、分片初始化和 CI/CLI 直接 SQL 不在此保证内，不能视为账户硬余额。Worker 与部署 SQL 都跳过无法推断 provider 的 NULL→NULL 回填。
- **错误协议**：主 Worker 与 shard HTTP 入口共用错误处理器，沿 cause 链识别 Cloudflare 明确的日读/写限额错误。返回 503、`D1_DAILY_READ_LIMIT` / `D1_DAILY_WRITE_LIMIT`、下个 UTC 零点 `retry_at`、向上取整 `Retry-After` 及 `Cache-Control: no-store`；保留 CORS，日志保留原始 cause。局部用量估算不会触发 ingest 熔断，其他异常仍为普通 500。
- **账号暂停**：聚合器只接受有效 503 配额协议，停止该目标剩余批内重试，同时继续健康目标。IDLE、Graph 和轮询把截止时间写进既有 SyncState；文件夹上传失败会向外传播，状态写入单独耗尽也会保存暂停。暂停跨进程重启保留，到期由原调度恢复；失败批次不推进 UID/seen 水位，也不重复回写配额错误状态。mutation/outbound 维持原有有界指数退避，不宣称所有后台请求均停至零点。
- **部署顺序**：在额度耗尽时，先明确受影响的静态目的地与 UTC 恢复时间；停稳聚合器并确认无第二同步进程，备份现有状态，仅写对应账号的暂停截止时间，再发布/启动新版本。禁止在运行进程外改其状态，禁止额外兑换真实 OAuth token 验证。发布前后保留邮件水位、配置与路由，读端和暂停行为可立即验收；真实非空入库恢复必须等额度重置后再确认。

新增回归先复现重复邮件/文件夹更新、隐藏的自增序列写入、超预算索引迁移、NULL 回填及配额重试问题。最终本地 Worker **582**、Aggregator **646**、DB 工具 **34** 项通过，合计 **1262**；Worker typecheck、lint、bundle 通过。SQL 回归使用真实 SQLite 验证数据、序列及原子语义，不将 SQLite `changes` 冒充 Cloudflare `rows_written` 账单。CI/E2E 和线上状态仍需按实际发布证据单独记录；本轮不宣称百人容量或长期日配额已验证。
