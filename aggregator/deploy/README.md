# VPS 部署（supervisord 托管）

pxed 这台 VPS 不以 systemd 为 PID 1、也不开 cron，聚合器由 **supervisord** 托管常驻循环。生产实际跑的就是 `agg-loop.sh`（每 300s 一轮，含 240s 超时与失败重试），不是 systemd timer。

1. `git clone <repo> /opt/one-mail-agg && cd /opt/one-mail-agg/aggregator`
2. `python3.11 -m venv .venv && .venv/bin/pip install -e .`
3. 从 `config.example.json` 生成 `/opt/one-mail-agg/config.json`（真实凭据，仅 VPS 本地，勿提交；`chmod 600`）
4. `cp deploy/agg-loop.sh /opt/one-mail-agg/agg-loop.sh && chmod +x /opt/one-mail-agg/agg-loop.sh`
5. 把 `deploy/one-mail-agg.supervisor.conf` 纳入 supervisord（`cp` 到 `/personal/pxed/` 并在 `/personal/pxed/supervisord.conf` 里 include，或直接 `-c` 引用），然后 `supervisorctl -c /personal/pxed/supervisord.conf update`
6. 查看：`supervisorctl -c /personal/pxed/supervisord.conf status one-mail-agg`（或 tail `/opt/one-mail-agg/agg-loop.log` + `agg.supervisor.err.log`）

> 仓库内曾误存 `one-mail-agg.service`/`one-mail-agg.timer`（systemd unit），但 pxed 从未用 systemd 跑过它们（已 `disabled` 并删除），仅 supervisord 路径是真实生效的。unit 文件已从仓库移除，勿再用 systemd 部署。

凭据安全：`config.json` 含授权码/refresh_token，`chmod 600`，绝不写入 D1、绝不提交。
