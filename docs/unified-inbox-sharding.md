# 统一收件箱多账号静态分片方案（Thin-Shard Federation）

状态：P0 遥测 + P1 空 map 行为等价联邦已落地（SHARD_MAP 为空时生产路径不变）。P2 账号 B 已部署 SHARD_MODE Worker（未切流，主 KV 的 SHARD_MAP 仍空）。P3 本地迁移工具、无损 archival ingest、分流与回归已完成；用户确认 UTC 00:00 后两个远程只读生产预检均通过，第二次请求消耗 `rows_read=99`、`rows_written=0`，无 code 7500。生产仍未复制、未写 map、未切流、未删除源邮件。
日期：2026-10-05

2026-10-08 预备更新：账号 B 分片已更新到当前 main 源码并补齐 `attachment_gc` / `mail_account_lifecycle`；健康鉴权与 archival 输入校验通过，目标邮件仍为 0，未切流。首批建议迁移 3,647 封外部邮件，详见 `docs/superpowers/plans/2026-10-08-shard1-load-distribution.md`；维护窗口待确认。迁移对账现使用 received_at/id 复合游标及目标主键批量查验，避免按 UUID 反复排序扫描整个邮箱。
前置：PR #66（探测式刷新 + 30s 下限）已上线——本方案的所有预算估算以它为基线。

## 1. 背景与目标

约束：项目永久免费，只能使用 Cloudflare 免费档 + 多个账号。

目标（按优先级）：
1. **配额隔离**：把「邮件大表的读写」从主账号的每日 500 万 rows_read / 10 万 rows_written 里分出去，按账号数线性扩容配额。
2. **爆炸半径分离**：任一分片配额耗尽或故障时，只有它承载的那部分邮件不可见，收信、发信、登录、临时邮箱不受影响。
3. **收信永不丢**：ingest 链路在任何降级状态下都不被熔断。

非目标：
- ❌ 按邮件数动态再平衡（迁移成本 > 收益，见 §5.4）
- ❌ 跨账号强一致/分布式事务
- ❌ 改变前端 API 契约（前端零改动是硬性要求）

## 2. 平台硬限制（免费档，2026-10 核实）

| 维度 | 免费档 | 对本方案的意义 |
|---|---|---|
| D1 rows_read | **500 万行/天/账号** | 分片的直接动机，按账号数线性扩容 |
| D1 rows_written | **10 万行/天/账号** | 收信写入的真实天花板，必须遥测 |
| D1 单库容量 | **500 MB** | 含正文的 emails 表会先撞这个——分片同时是存储扩容 |
| D1 账号总容量 / 库数 | 5 GB / 10 个库 | 单账号内部还能再拆库（但共享每日配额） |
| Workers 请求 | 10 万次/天/账号 | 网关+分片模式的请求量远低于此 |
| Workers subrequest | 50 次/请求 | 扇出 2~4 个分片绰绰有余 |
| Workers CPU | 10 ms/请求 | 归并排序是纯内存小数据量，无压力 |
| Cron Triggers | 5 个/账号 | 每分片 1 个足够 |
| KV | 10 万读/1 千写/天 | 遥测聚合 + 分片表，写入按分钟聚合即可 |
| Service Binding | 仅同账号 | 跨账号联邦只能走 **HTTPS + 共享 token** |
| Email Routing | 域名归属唯一账号 | **cf_routing 邮件的分片归属是被迫的**：域名在哪个账号，收信就落在哪个账号 |

## 3. 分片模型：薄分片（元数据集中，邮件数据分片）

核心决策：**只有"邮件大表"出主库，所有元数据留在主账号**。

```
                         ┌──────────────── 主账号（分片 0 / 网关）────────────────┐
                         │  Worker one-mail                                      │
 用户浏览器 ──CF Edge──▶ │  ├─ 鉴权/用户/地址/api_keys/settings（不动）           │
 inbox.mangoqwq.com      │  ├─ cf_routing 收信（Email Routing + raw_mails+emails）│
                         │  ├─ 发信全家桶（sendbox/reservations/配额）            │
                         │  ├─ emails[source='cf_routing']                       │
                         │  └─ 联邦网关：按 account→shard 路由/归并 ──────┐      │
                         └───────────────────────────────────────────────┼──────┘
                                                                         │ HTTPS + SHARD_TOKEN
                              ┌──────────────────────────────────────────┴──────┐
                              ▼                                                 ▼
                   ┌── 账号 B（分片 1）──┐                        ┌── 账号 C（分片 2）──┐
                   │ Worker (SHARD_MODE) │                        │ Worker (SHARD_MODE) │
                   │  emails(imap_*)     │                        │  emails(imap_*)     │
                   │  mail_account_folders│                       │  …                  │
                   │  mail_mutation_jobs │                        │                     │
                   └─────────▲───────────┘                        └─────────▲──────────┘
                             │ ingest / claim / result（直连）               │
                   ┌─────────┴───────────────────────────────────────────────┴──────┐
                   │ pxed VPS aggregator（按 account→shard 分流）                    │
                   └────────────────────────────────────────────────────────────────┘
```

### 3.1 表的归属（代码盘点结论）

| 归属 | 表 | 理由 |
|---|---|---|
| **仅主分片** | users、users_address、address、user_roles、user_passkeys、user_mail_accounts、api_keys、settings（含 oauth_state）、scheduled_locks、sendbox、address_sender、send_mail_limit_reservations、auto_reply_mails、**raw_mails** | 发信/登录/RBAC/配额/临时邮箱基座不拆；raw_mails 与 cf_routing 收信同请求双写，必须同分片 |
| **按 account_id 分片** | emails（source != 'cf_routing'）、mail_account_folders、mail_mutation_jobs | 唯一的体量大头；自带 source/account_id/to_addr 快照，可独立鉴权 |
| **每分片一份** | scheduled_locks（锁名带分片后缀）、保留所需的最小 schema | 各分片 cron 独立跑 retention |

分片 D1 不需要 users/settings/api_keys——因为**分片 Worker 永远不直接面对用户请求**，只面对网关（SHARD_TOKEN）和聚合器（INGEST_TOKEN）。这是本方案比"完整分库"便宜一个数量级的关键。

### 3.2 分片键与分配策略

- **分片键 = mail_account.account_id**（外部邮箱账号），不是 user、不是邮件数。
- 分配方式：**人工静态指定**（配置在主分片 KV 的 shard map：`account_id → shard_id`，网关 isolate 内存缓存 60s 降 KV 读），新接入的邮箱分给当前最空的分片，**分配后永不自动迁移**。
- cf_routing（本站临时邮箱）**固定主分片**——这不是选择，是 Email Routing 的账号归属决定的（一个域名的 MX 只能在一个账号）。由此推出一条长期硬约束：**所有收信域名（含未来新增）必须保留在主账号**，任何域名接入分片账号都会破坏本模型。
- 为什么不按邮件数动态再平衡：跨账号搬邮件 = 两边配额一起烧 + 迁移窗口双写一致性；而大邮箱在单分片内对 D1 毫无压力（真正的压力是每日读写配额，不是表大小）。需要再平衡时用 backfill 工具（§6 P3）手动做，一年一次的量级。

### 3.3 为什么 K 从 2 开始

一个邮件分片就把「外部邮箱聚合」的读写从主账号剥离——这已经隔离了最大的增长来源（历史邮件累积 + 多人浏览外部邮箱）。K=2 的复杂度（一个账号、一份部署、一条路由规则）与 K=4 相同，先跑通再扩。用户级分片（user_id→shard）虽然能让单用户的归并永远只落在 2 个分片内，但会引入"用户迁移"问题，且免费项目用户量级下 account_id 粒度足够。

## 4. 端点级路由与归并设计

前提事实：emails.id = `crypto.randomUUID()`（TEXT 主键），排序键 `COALESCE(internal_date, received_at) DESC, id DESC`——随机 UUID 保证跨分片归并时 (received_at, id) 不会并列，两路有序流可安全线性归并。

| 端点 | 策略 |
|---|---|
| GET /api/unified/emails（列表） | 网关：解析作用域（现有 `resolveScopedEmailFilter` 改为**先在元数据层解析出 account_id/地址集合**，替代 SQL IN 子查询）→ 本地查 cf_routing 部分 + 按 map 把 account_id 分组后**并行远端查**（limit+1 探测 has_more）→ 归并排序取前页。count 仅首页、= 各分片 count 之和。with_count=0 探测请求同样扇出（每分片 1 行）。cursor 分页天然兼容（排序键全局）。 |
| GET /api/unified/emails/:id | 网关：主库查 1 行，miss 则按分片扇出（短路返回第一个命中）。详情打开是低频操作，N 路 1 行读可接受。 |
| POST read/unread/star/move、DELETE | **"apply-if-exists" 原子扇出**：向所有分片并行下发「若存在此 email_id 则在本库完成 行更新 + mutation job 入队」，恰好一个分片命中。代码事实：外部邮件变更 = 读行 + UPDATE emails + INSERT mail_mutation_jobs 同库完成（`mutation_jobs.ts:135-194`），必须整体落在归属分片内；不要用"先定位再路由"（两次往返 + 定位与执行之间的 TOCTOU）。K 路各 1 行读、1 写，成本与定位式相同。 |
| GET /api/unified/mutations/:id | 按分片扇出（1 行读/分片），命中即返回。 |
| GET /verifcodes、/stats、/count | 扇出 + 合并（verifcodes 按 received_at 归并取 fresh 窗口内前 N；各分片查询本身有 fresh 窗口 + LIMIT 50 兜底，扇出成本有界）。 |
| GET /meta（DISTINCT source/account_id） | 扇出 + 并集。注意各分片各自带 LIMIT 截断（source 50 / account 100 / to_addr 200），合并后是"每分片 top-N 的并集"，对选项下拉场景足够。 |
| GET /folders、mutations claim/result | 按 account_id 路由到归属分片。 |
| POST /admin/unified/ingest | **聚合器直连分片**（不经网关，省主账号请求配额），鉴权 INGEST_TOKEN。ingest 按 (account_id, provider, provider_message_id) 查重（`ingest.ts:171`），幂等可重试——backfill 的安全性依赖这一点。 |
| POST mail_accounts/:id/status、/refresh_token | **仍走主分片**（user_mail_accounts 是元数据）。聚合器契约里唯一保持主分片的两条回写。 |
| 发信全部、用户/地址/账号管理、OAuth、/admin/keys | 不变，仅主分片。 |
| admin 级联删除（用户/地址） | 主分片删元数据 + 按 account_id 扇出删分片邮件。 |
| 自定义 SQL 清理（cleanup_api） | 仅主分片（raw_mails/sendbox 域）；文档标注不跨分片。 |
| retention cron | 每分片独立跑自己的 emails 清理；scheduled_locks 锁名与 KV 冷却键加分片后缀。 |

### 4.1 扇出协议约定（网关 ↔ 分片）

- **失败语义**：分片 fetch 超时 3s、不重试（重试留给下一轮轮询）。部分分片失败时返回已成功的结果并附 `degraded: [shard_id]` 标记——列表可用但 count/验证码可能不全；前端已有 connected 徽标可承载该状态。**绝不因分片失败拖垮主分片响应。**
- **参数上限**：D1 单查询最多 100 个绑定参数——分片查询协议里 account_id 集合放 JSON body（不下 IN 拼接）；"admin 全量"场景**不下发过滤**（分片本来就只存自己的账号）；用户 IN 列表 >100 时分批查询合并（现实中不会出现）。
- **offset 读放大**：offset 翻页网关需向每个分片取 `offset+limit` 行再归并切片，深页成本 ×K。约定：offset 上限 500（25 页），更深翻页前端切 cursor 模式（cursor 归并无放大）。探测式刷新只取 1 行，不受影响。
- **探测扇出成本**：多分片后每次后台探测 = K 次 1 行读；P4 熔断的高频降频同样作用于扇出。

## 5. 分片 Worker 形态

- **同一份代码**，`SHARD_MODE=1` 时：不挂 Email handler / 用户路由 / 发信路由，只暴露 `/shard/*`（emails 查询、mutations、ingest、folders、verifcodes），鉴权统一为 `Authorization: Bearer <SHARD_TOKEN>`（每分片独立 token，存在各自账号的 secret 里；常量时间比较，≥32 字节随机）。
- 入口用 `*.workers.dev`（免费、无需域名）。**注意 workers.dev 域名可预测且免费档无 WAF**，因此 Cloudflare Access service token（免费 50 用户内）建议作为默认配置而非可选项，SHARD_TOKEN 作为第二道防线。
- 分片 D1 用精简 schema（`db/shard-schema.sql`：emails、mail_account_folders、mail_mutation_jobs、scheduled_locks + 现有索引）；`db_api` 迁移在 SHARD_MODE 下只跑子集。已核实 ingest 路径**无 settings 依赖**（`ingest.ts` 无 getJsonSetting 调用），分片不需要 settings 表。
- 每分片自己的 **KV namespace**（遥测、锁、冷却键）——KV 配额按账号独立。
- 每分片的**写入遥测**与主分片同机制（meta.rows_written 累计到各自 KV）——10 万写/天的悬崖对分片同样存在，ingest 永不熔断，超限时降级的是"读"。

## 6. 落地阶段（每阶段可独立停船）

**P0 遥测（1 天，无条件先做）**
Worker 累计每次 D1 调用 `meta.rows_read/rows_written`（已核实 binding 返回这两个字段）到 KV（分钟粒度聚合），admin 加今日用量端点 + 前端一张卡。**KV 写入预算必须显式设计**：免费档 KV 只有 1 千写/天——计数先累加在 isolate 内存，由 cron 或每 ~2 分钟节流 flush（≈720 写/天/分片，单计数器多字段用 hash 写单 key）。验收：面板能看到主分片真实用量构成；写放大不超过 KV 免费额度。

**P1 联邦化改造（5~8 天，纯代码，行为等价）**
1. `ShardRegistry`（KV 分片表 + 空表 = 全本地）与 `ShardClient`（fetch + token + 重试）。
2. unified 各端点改走路由/归并层；`auth_scope` 的 USER_OWNERSHIP_WHERE 拆成"元数据解析 → IN 列表下发"。
3. 归并排序/分页/count 合并的单测（含跨分片同 received_at 的边界）。
4. SHARD_MODE 分支与 /shard/* 端点。
验收：SHARD_MAP 为空时全量测试（worker 227 + frontend 175 + e2e）行为与现状逐字节一致；merge 层单测覆盖。

**P2 分片账号基础设施（已落地 2026-10-05，未切流）**
账号 B `21c639b4d03f7f78a329146982147dd3`（`mangguotech@gmail.com`）：独立 gitignored `worker/wrangler.shard1.toml`（模板 `worker/wrangler.shard1.toml.example`，**不要**写进主站 `wrangler.toml` / GitHub `BACKEND_TOML` / 主账号 `CLOUDFLARE_*`）。Worker `one-mail-shard1`，`workers_dev = true`，`SHARD_MODE=1`，精简 D1 `one_mail_shard1` + 独立 KV。本地凭据 `E:/code/one-mail/.env.shard1`。
验收（已实测）：`GET /shard/health` 无 token / 错 token → 401；Bearer `SHARD_TOKEN` → 200 `{ok, shard_id: shard1, shard_mode: true}`。`/api/unified/*` 在分片 Worker 上 404。Cloudflare Access 与主 KV `SHARD_MAP` **未写**（切流是 P3）。CI shard job 未加，避免空 secret 把 main 的 Deploy Backend 打红。

**P3 迁移首批邮箱 + 切流（2~3 天）**
1. 选 1~2 个邮件量最大的外部邮箱。
2. backfill 工具（新增 `db/backfill_shard.mjs`）：按 account_id 从主库分块 SELECT（received_at 游标）→ POST 分片 ingest（按 provider_message_id 幂等，可安全重试/断点续跑）。
3. **切换顺序（防丢信窗口，关键）**：
   ① 复制历史存量（不删源；必须显式 `--source-quiesced`，声明两边会修改既有行的写者在 copy→cutover→delta→verification 期间暂停；仅新增行可继续）→
   ② **先写 KV 分片表**（聚合器与新请求立刻改走分片；此刻主库不再有该账号新写入）→
   ③ **full delta reconciliation**：从头扫描源账号，而不是仅用 `received_at` 水位，捕获迟到但时间戳较旧的新行；任何既有源/目标行的状态或内容差异都 fail closed，不自动覆盖或恢复 →
   ④ 双边 exact projection/count 校验 →
   ⑤ 停止源端新增、等待路由缓存收敛，并在删除期间保持源/目标既有行写者停止；按写入预算分块 DELETE 主库该账号行。
   任何反序（先删后切）都会丢窗口期邮件。DELETE 的实际 rows_written 含索引写放大，工具按 D1 返回的元数据记账并受共享预算限制，不能按邮件数简单估算。
4. aggregator config 增加 shards 配置（base_url + token）并按 account→shard 分流 ingest/claim/result；status/refresh_token 回写不变仍走主分片。
验收：统一收件箱列表/详情/验证码/已读/删除/移动在混合分片数据下全部正确；e2e 增加"本地双 worker 拓扑"（主 + 1 分片）覆盖归并与降级路径；主账号当日 rows_read 显著下降；分片读写独立计量；对账端点核对双边 count。

**P4 每分片熔断与降级（2 天）**
80%→降频跳 count；90%→该分片读切换"延迟可见"（网关缓存该分片上次快照于 KV，TTL 2 分钟）；ingest 永不阻断。验收：人为压低限额阈值，收件箱延迟可见且收信入库不受影响。

## 7. 配额预算（K=2 预估，PR #66 之后）

| | 主分片（0） | 邮件分片（1） |
|---|---|---|
| 读来源 | cf_routing 列表/详情、元数据、发信 | 外部邮件列表/详情/验证码扫描 |
| 写来源 | cf_routing 收信（~5 写/封，待 P0 校准）、发信、元数据变更 | 外部邮件 ingest（~2 写/封，含 folder UPSERT，待 P0 校准） |
| 请求来源 | 全部用户流量 + 网关扇出 | 网关扇出 + 聚合器 ingest/claim |

按当前规模（个人/小团队）两分片各自稳态预计 < 50 万读/天，剩余 10 倍余量；写入侧是更需要盯的（10 万/天），P0 遥测会给出真实数字。另注意 KV 双额度：读 10 万/天（分片表 isolate 缓存后每请求 0~1 次）、写 1 千/天（遥测节流 flush 后 ~720/天）。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 分片故障 → 外部邮件不可见 | 爆炸半径按设计分离；扇出 3s 超时 + `degraded` 标记部分结果；P4 快照降级让"不可见"变"延迟可见" |
| 扇出放大读取 | 扇出仅限用户主动操作与低频探测；offset 上限 500 + cursor 切换；P4 按 80/90% 分级自动收紧 |
| 跨账号 HTTPS 延迟 | CF 边缘到边缘，通常同 colo < 30ms；归并并行发起；3s 超时不拖垮主响应 |
| 500MB 单库上限 | 每分片 retention 强制开启（正文 30 天、已读 90 天已有实现），监控各库容量 |
| token 泄露 / workers.dev 可预测 | 每分片独立 token（≥32B 随机、常量时间比较、可独立轮换）；**Cloudflare Access service token 作为默认配置**（免费 50 用户内） |
| 聚合器多分片 claim 竞争 | claim 无账号过滤、每分片返回自己全部 job，按分片独立 lease_token 即可；claim 已是幂等租赁语义 |
| 元数据与邮件数据不一致（删账号 vs 分片残留） | 级联删除改为网关编排的"先分片后元数据"顺序 + 对账巡检（P3 里加一个 count 对账端点） |
| 未来新收信域名被加到分片账号 | §3.2 硬约束：收信域名必须全在主账号（Email Routing 归属决定的模型前提） |
| backfill/删除烧写配额 | DELETE 每行计 1 写，限速执行（单日 ≤ ~8 万行）；ingest 幂等使重试安全 |

## 9. 明确不做

- 按邮件数/按负载自动迁移邮箱（迁移工具仅手动触发）
- 跨账号分布式事务（发信配额天然单分片，无需跨账号事务）
- 前端感知分片（API 契约不变）
- raw_mails/sendbox 出主库（与 cf_routing 收信强耦合）
