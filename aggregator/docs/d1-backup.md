# VPS 本地 D1 逻辑备份（不使用 R2）

生产账户没有开通 R2，Worker 的定时备份路径因此保持休眠。本模块把同一个 D1
数据库备份到已经付费、长期在线的 pxed VPS 上：调用 Cloudflare D1 export API，
按真实协议轮询（`POST` + `current_bookmark`，下载地址在 `result.result.signed_url`），
把 dump 流式 gzip 到本地磁盘，再按 daily / weekly / monthly 分层保留。

- 不产生对象存储费用，不需要绑卡，也不新增 Cloudflare 资源。
- dump 全程不经过 Worker，也不在内存里整份缓冲（169 MiB 的库常量内存压缩）。
- 备份文件、运行日志和 token 都留在 VPS 本地，权限 `0700` / `0600`。
- D1 免费版仍保留内置 Time Travel（7 天）作为分钟级「撤销键」；本模块负责
  超过 7 天、可下载、可离线校验的那份档案。

## 目录与保留

默认根目录 `/opt/one-mail-backups`：

```text
daily/2026-11-07.sql.gz     每次运行一份
weekly/2026-W45.sql.gz      每个 ISO 周的第一份（硬链接，不重复占盘）
monthly/2026-11.sql.gz      每个自然月的第一份（硬链接）
runs.jsonl                  每次尝试一行审计记录（成功/失败、字节、sha256）
```

默认保留 7 份每日、4 份每周、6 份每月。gzip 后单份约 15–25 MiB，总量约
300 MB。分层文件用硬链接共享 inode；文件系统不支持硬链接时退化为复制。

删除只匹配各层精确命名的文件（`YYYY-MM-DD.sql.gz`、`YYYY-Www.sql.gz`、
`YYYY-MM.sql.gz`），目录里的其他文件永远不会被删。

## 配置与凭据

目标与保留策略放在 `/opt/one-mail-agg/d1-backup.json`（非敏感，`0600` 即可）：

```json
{
  "account_id": "0123456789abcdef0123456789abcdef",
  "database_id": "5f3e1c0a-9b2d-4e7a-8c61-1d2e3f4a5b6c",
  "root": "/opt/one-mail-backups",
  "keep_daily": 7,
  "keep_weekly": 4,
  "keep_monthly": 6,
  "hour": 3,
  "minute": 10
}
```

模板见 `deploy/d1-backup.example.json`。只接受上述键；未知键、相对路径、
非 UUID 的库 ID 都会让进程在启动时失败，而不是带着错配置运行。

API token 放在 `/opt/one-mail-agg/d1-backup.token`，必须 `0600`，由部署从
GitHub Secret `D1_BACKUP_API_TOKEN` 写入。token 只要求 **D1:Edit**（导出）
权限，作用域限定到该账户即可；不需要 R2、Workers 或 Zone 权限。token 不会
进入 argv、环境变量或日志；presigned 下载地址同样不写日志。

## 安装与启用

1. 在 Cloudflare Dashboard 创建一个只含 `D1:Edit` 的 API Token。
2. 在仓库 Secrets 里新增 `D1_BACKUP_API_TOKEN`。
3. 在 VPS 上一次性创建目标配置（把两个 ID 换成真实值）：

   ```bash
   umask 077
   cat > /opt/one-mail-agg/d1-backup.json <<'JSON'
   {
     "account_id": "<32位账户ID>",
     "database_id": "<D1数据库UUID>",
     "root": "/opt/one-mail-backups",
     "keep_daily": 7, "keep_weekly": 4, "keep_monthly": 6,
     "hour": 3, "minute": 10
   }
   JSON
   ```

4. 触发一次 `Deploy Aggregator`。部署会安装 `d1-backup.sh`、写入 token，并在
   token 与配置文件都存在时把 `one-mail-d1-backup` program 追加进
   `/opt/one-mail-agg/supervisor-one-mail-agg.conf`。两者缺一时会打印提示并
   保持备份不启用，部署不会因此失败。

检查：

```bash
supervisorctl -c /personal/pxed/supervisord.conf status one-mail-d1-backup
tail -n 50 /opt/one-mail-agg/d1-backup.supervisor.err.log
ls -lh /opt/one-mail-backups/daily
df -h /opt/one-mail-backups
```

首次启动会立即补跑当天缺失的备份，之后每天在配置的 UTC 时间执行；失败后
30 分钟重试，成功则回到每日计划。

## 恢复

优先用 Time Travel 处理分钟级误操作（免费版 7 天窗口，原地覆盖）：

```bash
wrangler d1 time-travel info one_mail_db
wrangler d1 time-travel restore one_mail_db --timestamp=<unix秒或ISO时间>
```

需要更早的状态或先验证再切换时，用本地档案。不要直接把完整 dump 导入生产库；
先建临时库导入、核对行数，再决定切换：

```bash
gunzip -c /opt/one-mail-backups/daily/2026-11-07.sql.gz > /tmp/restore.sql
wrangler d1 create one_mail_restore_drill
wrangler d1 execute one_mail_restore_drill --remote --file /tmp/restore.sql
# 核对关键表行数后，再决定迁移/切换策略
rm -f /tmp/restore.sql
```

`runs.jsonl` 里的 `sha256` 对应 gzip 文件本身，可用于离线校验档案未被改动。

## 容量与失败模式

- 启动前要求目标盘至少保留 2 GiB（`min_free_bytes` 可调）；不足直接失败，
  不会写半个文件。
- 下载超过 4 GiB、小于 1 KiB、或首字节是 `<`（代理返回 HTML 错误页）都会
  被拒绝；临时 `.part` 文件会被清理。
- API 轮询上限 120 次（约 2 分钟）；导出任务不轮询会被服务端自动取消，
  超时会记录为 `export_timeout` 并在 30 分钟后重试。
- 同机备份只能防 D1/Worker 侧损坏，防不了 VPS 整机丢失。需要 3-2-1 时，把
  最新的 `.sql.gz` 定期 rsync 到本地 PC/NAS 即可，仍然零新增费用。

## 本地验证

```bash
cd aggregator
PYTHONPATH=src python -m pytest tests/test_d1_backup.py -q
```

测试完全离线，不读取生产凭据、不发起网络请求。
