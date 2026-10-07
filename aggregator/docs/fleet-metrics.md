# D0 账户级只读计量采集器

本模块落实[动态分片规范](../../docs/d1-dynamic-fleet.md)的 D0 账户计量基础。它只采集 Cloudflare API、输出报告和保存本机历史；不执行邮件 SQL、不写 KV、不分配 owner、不迁移数据、不创建账户，也不安装定时服务。

## 配置和凭据

JSON 必须使用 UTF-8，根对象只接受 `v` 和 `accounts`；版本为整数 `1`。最多 12 个账户，每账户最多 10 个受管库。一个 Cloudflare 账户只能登记一次，所有 shard ID 和 database ID 唯一。账户实际读写统计覆盖账户内全部数据库，包括未列在 `databases` 中的库；列表仅决定要采集哪些库的容量。

以下 ID 为文档演示数据，运行前替换为受管清单里的真实 ID：

```json
{
  "v": 1,
  "accounts": [
    {
      "account_key": "main",
      "provider_account_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "credential_ref": "env:CF_MAIN_METRICS_TOKEN",
      "databases": [
        {"shard_id": "primary", "database_id": "11111111-1111-1111-1111-111111111111"}
      ]
    },
    {
      "account_key": "account-b",
      "provider_account_id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "credential_ref": "env:CF_B_METRICS_TOKEN",
      "databases": [
        {"shard_id": "shard-b", "database_id": "22222222-2222-2222-2222-222222222222"}
      ]
    }
  ]
}
```

`credential_ref` 只接受 `env:环境变量名`。令牌通过进程环境注入，不进入配置、命令行参数、SQLite 或输出。使用账户范围的只读 API token，具备 Account Analytics 的 GraphQL 读取权限与 D1 数据库元数据读取权限；不同套餐/令牌的具体 dataset 权限须在灰度前验证。Global API Key 不在此模块支持范围内。任何未授权 dataset、HTTP 401/403/429、GraphQL errors、缺失字段都降低该账户置信度，不能视为零用量。

## 一次采集

先准备管理员独占的 `0700` 目录，把非敏感配置保存为该目录下的 `fleet.json`。在已经安装聚合器的 Python 环境运行：

```bash
python -m one_mail_agg.fleet_metrics --config /private/onemail-fleet/fleet.json --history /private/onemail-fleet/history.sqlite
```

采集器每次退出，不常驻。由已有运维调度器在完成权限和预算检查后，每 5 分钟运行一次；本次代码交付未开启任何生产定时任务。

每账户一次 D1 GraphQL 日累计、一次 Workers GraphQL 日累计，加每受管库一次 REST 元数据请求。12 账户各 1 库即每轮 36 个 Cloudflare API 请求，不执行 D1 查询、不产生本模块的 D1 行扫描。账户任务并发上限 4，同一账户串行采集；每次请求绝对截止 10 秒，每账户截止 60 秒。超时会取消异步 socket 操作，取消父任务会等待所有子任务退出。HTTPS origin 固定为 `api.cloudflare.com`，不跟随重定向、不加载环境代理、不接受外部 URL，单响应上限 512 KiB。

使用 Python 标准库 `asyncio` 的 TLS 流，因为现有依赖中的 requests 没有可取消的异步请求。HTTP 读取只支持本模块所需的 HTTP/1.1 JSON、定长、chunked、关闭连接分帧；不增加 HTTP 客户端依赖，响应解析有独立错误和边界测试。

stdout 是一份完整 JSON 报告，包含 `v=1`、`mode=observe`、`accounts`。报告中的每个账户包含规范 MetricSnapshot 字段，以及 `issues`、`consecutive_valid_samples`、`allocation_eligible`：

- `rows_read`、`rows_written`、`worker_requests` 未知时为 `null`。失败的容量来源不出现在 `shard_sizes` 中。成功返回显式空聚合数组代表没有匹配事件，计为零；缺失数组或账户不是零。
- `authoritative` 仅表示成功采集账户 API，仍存在平台统计延迟和自适应采样，不是实时余额。
- `partial` 表示任一来源失败、结构/安全整数校验失败或同 UTC 日计数倒退。已成功的独立来源保留，问题使用稳定错误码，不带响应正文、密钥或请求头。
- `stale` 表示超过 15 分钟、观测时间在未来、UTC 日不符。跨午夜完成的前一天查询不能分配新邮箱。
- 至少三个连续 5 分钟桶的有效样本才能使 `allocation_eligible=true`。同桶重跑不增加连续计数；缺桶、失败、午夜重置中断连续计数。
- `allocation_eligible` **仅是计量前置条件**，不能代替目标健康、schema/protocol、reservation、gate 或 registry 的检查。此模块没有自动分配能力。

退出码：`0` 为本轮账户来源完整；`2` 为成功写出包含 partial/stale 的报告；`1` 为配置/本机持久化失败；`130` 为用户取消。只有取得完整报告后才能使用该报告，不将进程错误或缺失输出解释为零用量。适配到 Worker 的严格数值 `MetricSnapshot` 前，必须先拒绝 partial/stale/null 报告。

## 完整 UTC 日与有界历史

历史使用标准库 SQLite，一个事务写入本轮全部账户结果；失败回滚。文件权限为 `0600`，拒绝共享父目录和符号链接。每账户每天最多 288 桶，保留当前日和前 7 个 UTC 日，全部账户合计最多 27,648 行；即使配置账户名称变化也有绝对行数上限。不包含邮件正文、地址或 OAuth 凭据。

同日读取/写入/请求累计的最大已观测值单独用于倒退检查。失败轮次或同桶覆盖不抹掉这个基准；后续低于该基准的样本仍为 partial。日切换后按新的 UTC 日重新累计。库体积允许因清理而下降，不按累计计数处理。

仅保留每天最后一次实时采样会漏掉最后几分钟。每日平台统计稳定后，用 `--utc-date` 重采刚结束的完整日；可对保留窗口内某一天重跑以吸收迟到统计：

```bash
python -m one_mail_agg.fleet_metrics --config /private/onemail-fleet/fleet.json --history /private/onemail-fleet/history.sqlite --utc-date 2026-10-07
```

历史日 GraphQL 时间范围为该 UTC 日完整区间。REST 容量仍为本次观测容量，不能误称为历史日结束容量。历史重采写入该日期最后一个桶，不新增无限桶；它对当前分配标为 stale、退出 `2`，但保留实际账户日累计供容量报告。未来日期和超出 8 日保留窗口的请求在任何网络操作前被拒绝。

7 日容量结论仍需核验每天的采样完整性、日结重采结果和平台延迟；不足数据时不得宣称百人验收完成。当前模块尚未采集单操作 D1 meta、附件体积、邮箱分布和提供商积压，这些继续由规范中的其他 D0/验收模块提供。

## 本地验证

```bash
python -m pytest tests/test_fleet_metrics.py -q
python -m compileall -q src/one_mail_agg/fleet_metrics.py
```

测试覆盖同账户多库、跨账户并发上限、部分失败、非法结构/整数、HTTP 超时与取消、响应体上限、重定向拒绝、UTC 午夜、历史日重采、计数倒退、连续样本门槛、持久化回滚与保留窗口。测试不使用生产账户或真实 Cloudflare API。

## 同期 Worker D1 meta 计量调整

Worker 的 `d1_quota.ts` 与 `D1QuotaCoordinatorDurableObject` 继续提供操作链计量，不能与上述账户 GraphQL 累计简单相加。

- KV 发布间隔由 120 秒改为 **300 秒**。DO 在调用 KV 前持久化发布时间槽，跨 UTC 日、重启、失败重试都共享此限制；一轮 KV 响应未知不会引发频繁重写。DO 增量本身仍可持续合并。
- DO 仅接受服务端 UTC 当天及前两天的 delta；更早返回 `410 / QUOTA_DELTA_EXPIRED`，将来日期和不存在的日历日期返回 400。客户端 `now` 不决定接受窗口或发布时间。
- DO alarm 每次最多清理 128 个过期 delta 标记和 128 个过期日状态，有剩余时 1 秒后续扫，否则下一 UTC 日清理。删除前持久化单调保留下界，时钟回退不能让已清理的 delta 再次入账。存储失败向平台抛出，使用 alarm 重试。
- 计数和相加结果必须在非负安全整数范围内。超限拒绝 DO 事务，不写标记；无效 D1 meta 不进入计数，业务数据库已经成功的操作不会因此变成失败，报告增加 `INVALID_META` 或 `COUNTER_OVERFLOW`。
- 客户端遇到明确的过期错误后，该次 flush 仍抛出保留上下文的计量异常，同时移除永远不能重放的过期队头；下一次 flush 可以提交当天计量。报告保留 `EXPIRED_DELTA`，不将其称作完整计量。普通 HTTP 410、网络错误和非法确认不会丢弃队列。
- 旧数值字段保留；新字段 `confidence`、`accounting_issues` 标明 partial/stale、缺失快照和计量缺口。没有 KV 或 DO 日状态时的数值零只是旧显示合同，不能作为新分配器的可靠零用量。

上述 DO 仍按 shard 命名。288 次/日是**每个 coordinator**的预算，符合初期每账户一个 shard 的部署；若以后同账户运行多个 coordinator，须先统一账户 KV 发布预算，不能把每个对象的 288 次都视为独立免费额度。本次仅修改实现，未启用生产 DO、alarm 或任何采集调度。

**待完成的发布门槛：** 当前没有实现同账户多 coordinator 的统一 KV 发布协调。即使 Cloudflare 账户允许创建多个 D1，在该协调能力和账户预算验收完成之前，多个 coordinator 共享同账户 KV 发布的拓扑不得放行。采集器能正确读取同账户多个库，不代表此发布拓扑已经得到支持。

## 转换为 registry MetricReport

`one_mail_agg.fleet_metric_report` 是纯数据适配器，输出与 `worker/src/fleet/contracts.ts` 完全一致的 `MetricReport` / `MetricsRequest`；没有网络发布器、循环任务或路由控制器。

`build_metric_report` / `build_metrics_request` 必须显式传入：

- 原始 `MetricSnapshot` 和对应 `AccountConfig`；账户 ID 必须匹配，容量必须恰好覆盖该账户登记的所有 shard，不能缺失或混入其他 shard。
- `RemainingDemand(rows_read, rows_written, worker_requests)`：非负安全整数，表示尚未反映在 API 观测中的流量，加上本 UTC 日余下时间的保守业务需求。没有默认值，不按已过时间线性放大，不自行猜测。该预算不包含由 registry 另行扣除的 reservation，避免重复计算。
- 带时区的 `now`。只接受本 UTC 日、非未来、距当前不超过 15 分钟的账户 API 样本；partial、stale、缺失计数、采集 issues 均被拒绝。
- 后续样本传入上次**已接受的 authoritative** `baseline`；不得用最新失败样本替换它。同日三个计数任一倒退，或观测时间重复/倒退，均拒绝。旧日 baseline 允许新日计数归零；同日旧 baseline 即使超过 15 分钟仍参与高水位检查。

输出源名仅将可靠的 `cloudflare-account-api` 映射为 `cloudflare_graphql`。`projected_* = observed_* + remaining_*` 使用安全整数溢出检查；转换不修改原始对象。首次有效样本也可提交，因为 registry 必须自行积累连续样本，适配器不会伪造“已满足三次采样”。

以下示例假设已经保存本轮 stdout 为 `collected.json`，运营根据真实观测填写 `remaining-demand.json` 的三个整数字段；该文件没有内置流量估值。首次提交可以没有 `accepted-main.json`，后续必须保存上次成功提交对应的原始样本供 baseline 使用：

```python
import json
from datetime import datetime, timezone
from pathlib import Path

from one_mail_agg.fleet_metrics import MetricSnapshot, parse_config
from one_mail_agg.fleet_metric_report import RemainingDemand, build_metrics_request

directory = Path("/private/onemail-fleet")
config = parse_config(json.loads((directory / "fleet.json").read_text(encoding="utf-8")))
account = next(account for account in config.accounts if account.account_key == "main")
collected = json.loads((directory / "collected.json").read_text(encoding="utf-8"))
raw = next(item for item in collected["accounts"] if item["account_key"] == account.account_key)
sample = MetricSnapshot(**raw)
baseline_path = directory / "accepted-main.json"
baseline = MetricSnapshot(**json.loads(baseline_path.read_text(encoding="utf-8"))) if baseline_path.exists() else None
remaining = RemainingDemand(**json.loads((directory / "remaining-demand.json").read_text(encoding="utf-8")))
request = build_metrics_request(
    sample, account, remaining,
    now=datetime.now(timezone.utc),
    baseline=baseline,
    expected_revision=input("Registry snapshot revision: ").strip(),
    idempotency_key=input("Stable idempotency key for this report: ").strip(),
)
(directory / "metrics-request.json").write_text(json.dumps(request), encoding="utf-8")
```

操作员先通过 `GET /internal/fleet/snapshot` 取得 revision，确认 observe 模式和独立 control token 已配置后，才向主站 `POST /internal/fleet/metrics` 发送生成的请求。令牌应由已有 `0600` 私有 curl 配置提供，不写入示例 JSON、终端命令参数或 Git：

```bash
curl --fail-with-body --max-time 10 --config /private/onemail-fleet/fleet-control.curl --request POST --header 'Content-Type: application/json' --data-binary @/private/onemail-fleet/metrics-request.json https://mail-api.mangoqwq.cc.cd/internal/fleet/metrics
```

成功确认后才将对应的原始 `raw` 保存为 `accepted-main.json`。超时/结果未知时保持同一请求和幂等键重试；确认收到 revision 冲突后重新获取快照并按接口合同处理，不用随机换键隐藏冲突。失败适配不会生成可提交报告。当前未创建上述私有文件，也未发送任何生产控制请求。

跨语言验收测试直接把 Python 生成的 JSON 送入 TypeScript `metricsRequest` 校验器，防止两套字段名、源标识、安全整数及 revision 合同漂移：

```bash
python -m pytest tests/test_fleet_metrics.py tests/test_fleet_metric_report.py -q
```
