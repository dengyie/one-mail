# 线上鉴权链路观察 SOP(Workers 探针)

> 背景:PR #171/#172 修复「一直掉登录 401」——D1 瞬时故障曾被视为凭据失效。
> 语义约定:**401 = 凭据真的失效**(前端自愈清凭据跳登录页);**503 = D1 瞬时故障、
> 存活无法判定**(可重试、绝不清凭据)。本 SOP 用于日常/故障时观察线上鉴权链路。

## 1. 触发探针(GitHub Actions,无需本地凭据)

```bash
# 看最近 60 分钟(默认)
gh workflow run workers_log_probe.yaml

# 看最近 24 小时
gh workflow run workers_log_probe.yaml -f minutes=1440

# 只看 503(D1 兜底路径)
gh workflow run workers_log_probe.yaml -f minutes=180 -f filter=503
```

取结果:

```bash
RUN_ID=$(gh run list --workflow=workers_log_probe.yaml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log | grep -vE '\^' | grep -E 'status=|total=|requests='
```

## 2. 读数语义

探针输出三个区块,重点看 `per-status totals` 里 `one-mail` 的行:

| 输出行 | 含义 | 判断 |
|---|---|---|
| `http=200 requests=N` | 正常流量基线 | 量级稳定即可 |
| `http=401 requests=N` | 凭据真的失效(匿名探测/过期 token/密码改了) | 偶发个位数正常;**持续高位且无对应操作 = 异常** |
| `http=503 requests=N` | D1 瞬时故障走了新兜底(可重试、不清凭据) | 偶发正常(用户界面短暂降级自动恢复);**反复大量出现 = D1 不稳定,查 d1-backup/配额** |
| `http=500 requests=N` | Worker 内部错误(鉴权链外通道或未处理异常) | 需定位端点,见 §4 |
| `errors=N (sum.errors)` | Worker 抛了未捕获异常 | >0 必查,配合实时 tail |
| `hourly timeline` errors>0 的时段 | 错误集中出现时间 | 与部署/备份/配额事件对时间线 |

已知正常现象:**每天本地 03:10** 前后可能有一小批 500(`folders ingest`/
`refresh_token write-back`/`mail_accounts` 等)——d1-backup 在 03:10 做 D1
export,导出窗口内 D1 瞬时不可用。聚合器有重试+缓存兜底,会自动恢复,
日志表现为 `WARNING ... retrying`,属于已知低危,无需处理。

## 3. 判定速查:用户报「掉登录」时

1. 跑 `gh workflow run workers_log_probe.yaml -f minutes=1440`
2. 看 401/503/500 分布:
   - **401 多且集中** → 凭据侧问题(密码改动/多设备踢下线/token 签发异常),查
     `/open_api` 登录端点与 JWT 签发配置
   - **503 多** → D1 侧问题(瞬时故障),修复已保证不清凭据;若 503 密集出现,
     查 D1 配额/备份窗口/Cloudflare 状态页
   - **500 多** → worker 未处理异常,先实时 tail(§4)拿堆栈
   - **全都干净** → 问题在前端本地(localStorage/网络),让用户硬刷新+重登录复测

## 4. 需要原始日志(逐条)时

本账号未开通 Workers Logs(GraphQL 无 `workersLogs` 数据集,探针只能聚合)。
逐条日志用实时 tail,需一个有 **Workers Scripts:Read** 权限的 token:

```bash
CLOUDFLARE_API_TOKEN=... npx wrangler tail one-mail --format pretty \
  --status error --ampling-rate 1  # 只看 error/exception
```

探针聚合定位到时段后,tail 期间重现一次请求即可拿到逐条堆栈。

## 5. 维护说明

- 探针 workflow:`.github/workflows/workers_log_probe.yaml`(PR #174 重写)
- 查询是分组聚合 schema:字段必须在 `dimensions{}`/`sum{}`/`quantiles{}`
  子选择内,顶层 `datetime` 会报 `unknown field`
- 凭据来源:仓库 secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`,
  不落盘、不回传;若探针报 `GQL-ERROR [authz]`,说明 token 缺
  Account Analytics 读权限,去 CF dashboard 给该 token 加权限
- d1-backup 计划:pxed `/opt/one-mail-agg/d1-backup.json`(`hour:3, minute:10`)
