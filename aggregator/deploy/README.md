# VPS 部署（supervisord 托管）

pxed 这台 VPS 不以 systemd 为 PID 1、也不开 cron，聚合器由 **supervisord** 托管常驻进程。`agg-loop.sh` 直接 `exec one_mail_agg.main --daemon`，单进程单写者完成三件事：

- **IMAP IDLE**：为支持的账号拉起常驻监听线程，服务端有新邮件即秒级同步（实时收信）；
- **60s 兜底增量拉取**：POP3 / graph / 新增用户账号 / IDLE 降级账号走轮询；
- **5s 排空 mutation 队列**：已读 / 星标 / 移动回写到 provider。

收信、回写、以及所有 refresh_token 兑换都在这一进程内、由进程级 `redemption_lock` 串行化——MSA/Graph 的 refresh_token 每次兑换都轮换，任何两条并发兑换都会让其中一份立刻失效（2026-09-11 烧卡事故的并发版本）。

1. `git clone <repo> /opt/one-mail-agg && cd /opt/one-mail-agg/aggregator`
2. `python3.11 -m venv .venv && .venv/bin/pip install -e .`
3. 从 `config.example.json` 生成 `/opt/one-mail-agg/config.json`（真实凭据，仅 VPS 本地，勿提交；`chmod 600`）
4. `cp deploy/agg-loop.sh /opt/one-mail-agg/agg-loop.sh && chmod +x /opt/one-mail-agg/agg-loop.sh`
5. 把 `deploy/one-mail-agg.supervisor.conf` 纳入 supervisord（`cp` 到 `/personal/pxed/` 并在 `/personal/pxed/supervisord.conf` 里 include，或直接 `-c` 引用），然后 `supervisorctl -c /personal/pxed/supervisord.conf update`
6. 查看：`supervisorctl -c /personal/pxed/supervisord.conf status one-mail-agg`（或 tail `/opt/one-mail-agg/agg-loop.log` + `agg.supervisor.err.log`）

> 仓库内曾误存 `one-mail-agg.service`/`one-mail-agg.timer`（systemd unit），但 pxed 从未用 systemd 跑过它们（已 `disabled` 并删除），仅 supervisord 路径是真实生效的。unit 文件已从仓库移除，勿再用 systemd 部署。

凭据安全：`config.json` 含授权码/refresh_token，`chmod 600`，绝不写入 D1、绝不提交。

## Hotmail / Outlook.com 个人号接入（OAuth2 / XOAUTH2）

微软已对所有租户禁用 IMAP 基础认证，个人 hotmail/outlook.com（MSA）账号**只能**走
OAuth2 + XOAUTH2（scope `https://outlook.office.com/IMAP.AccessAsUser.All offline_access`）。

### 一次性获取 refresh_token（Device Code Flow）

```bash
cd /opt/one-mail-agg/aggregator
.venv/bin/python scripts/msa_authorize.py --client-id <PUBLIC_CLIENT_ID> --tenant consumers
```

- `<PUBLIC_CLIENT_ID>`：Azure 应用注册（Supported account types = **Personal Microsoft
  accounts only**）的 Application (client) ID。公开客户端不需要 secret。
- 按提示用目标 hotmail 账号在浏览器登录并输入用户码，脚本会打印 JSON 配置块。

### 写进 config.json

```json
{
  "id": "hotmail-main",
  "source": "imap_outlook",
  "host": "outlook.office365.com",
  "port": 993,
  "username": "you@hotmail.com",
  "password": "ignored-by-oauth",
  "folders": ["INBOX"],
  "use_ssl": true,
  "oauth": {
    "provider": "msa",
    "client_id": "<PUBLIC_CLIENT_ID>",
    "refresh_token": "<长活 refresh_token>"
  }
}
```

- `provider` 可写 `msa` / `hotmail` / `outlook_personal`（聚合器归一化为 `msa`）。
- `client_secret` 可选：个人号公开客户端通常不需要。
- 组织号（work/school）仍用 `provider=outlook` + `client_secret`（现有流程，不破坏）。

### 验证

重启聚合器后看日志：

```bash
supervisorctl -c /personal/pxed/supervisord.conf restart one-mail-agg
tail -20 /opt/one-mail-agg/agg-loop.log
# 期望三行证据：
#   IMAP IDLE worker started for account hotmail-main (outlook.office365.com:993)
#   Account hotmail-main connected for IDLE monitoring
#   synced hotmail-main: protocol=imap synced>0 dropped=0
```

IDLE 生效后新邮件是服务端推送即同步；日志里不再出现 `synced` 行也属正常（无新邮件时
`do_sync` 的 synced=0 不打日志）。要确认「实时通路还活着」，看 `connected for IDLE
monitoring` 是否在最近一次重连后仍存在，以及超时保底刷新（默认 240s）是否按期出现。
