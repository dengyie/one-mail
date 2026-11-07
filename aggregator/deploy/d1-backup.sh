#!/usr/bin/env bash
# one-mail D1 逻辑备份常驻入口（由 supervisord 托管）。
#
# 不使用 R2：直接调用 Cloudflare D1 export API，轮询完成后把 dump 流式
# gzip 到 VPS 本地 /opt/one-mail-backups，并按 daily/weekly/monthly 保留。
# 目标与保留策略在 /opt/one-mail-agg/d1-backup.json，API token 在
# /opt/one-mail-agg/d1-backup.token（0600，由部署写入）。
set -euo pipefail

BASE=/opt/one-mail-agg
PY="$BASE/aggregator/.venv/bin/python"
CONFIG="$BASE/d1-backup.json"
TOKEN_FILE="$BASE/d1-backup.token"

test -x "$PY"
test -r "$CONFIG"
test -r "$TOKEN_FILE"

exec "$PY" -m one_mail_agg.d1_backup \
  --config "$CONFIG" \
  --token-file "$TOKEN_FILE" \
  --loop
