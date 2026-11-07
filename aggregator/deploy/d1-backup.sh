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

# 备份不能和收发信抢资源：169 MiB 的 dump 会占几秒 CPU 做 gzip，并产生一阵
# 顺序写。这里用最低调度优先级 + idle I/O 类别，保证聚合器的 IMAP IDLE
# 线程和 60s 轮询始终优先。两者都存在时才加，缺了也不会变成崩溃循环。
LAUNCH=""
if command -v nice >/dev/null 2>&1; then LAUNCH="nice -n 19"; fi
if command -v ionice >/dev/null 2>&1; then LAUNCH="$LAUNCH ionice -c 3"; fi

# shellcheck disable=SC2086  # 有意让可选前缀在这里分词
exec $LAUNCH "$PY" -m one_mail_agg.d1_backup \
  --config "$CONFIG" \
  --token-file "$TOKEN_FILE" \
  --loop
