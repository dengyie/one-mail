# VPS 部署
1. `git clone <repo> /opt/one-mail-agg && cd /opt/one-mail-agg/aggregator`
2. `python3.11 -m venv .venv && .venv/bin/pip install -e .`
3. 从 `config.example.json` 生成 `/opt/one-mail-agg/config.json`（真实凭据，仅 VPS 本地，勿提交）
4. `cp deploy/one-mail-agg.{service,timer} /etc/systemd/system/`
5. `systemctl daemon-reload && systemctl enable --now one-mail-agg.timer`
6. 查看：`journalctl -u one-mail-agg.service -f`
凭据安全：config.json 含授权码/refresh_token，`chmod 600`，绝不写入 D1。