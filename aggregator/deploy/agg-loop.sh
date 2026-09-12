#!/bin/bash
# one-mail 聚合器常驻循环：完整收信同步与 provider mutation 串行执行。
# pxed 无 systemd/cron，由 supervisord 托管本脚本常驻循环（见 deploy/one-mail-agg.supervisor.conf）。
#
# 不能让 sync 与 mutation 并发：MSA / Graph refresh_token 可能在兑换时轮换，
# 两个进程同时刷新会让其中一份旧 token 永久失效。完整同步完成后，在下一轮
# sync 前每 5 秒处理一次 durable mutation queue，既保持低延迟又保留单写者语义。
set -uo pipefail
LOG=/opt/one-mail-agg/agg-loop.log
SYNC_INTERVAL=300
SYNC_TIMEOUT_SEC=240
MUTATION_INTERVAL=5
MUTATION_TIMEOUT_SEC=45
PY=/opt/one-mail-agg/aggregator/.venv/bin/python
CONFIG=/opt/one-mail-agg/config.json
TS() { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(TS)] $*" >> "$LOG"; }

log "one-mail-agg loop start pid=$$ sync_interval=${SYNC_INTERVAL}s mutation_interval=${MUTATION_INTERVAL}s"
while true; do
  if timeout "$SYNC_TIMEOUT_SEC" "$PY" -m one_mail_agg.main "$CONFIG" >> "$LOG" 2>&1; then
    log "sync OK (rc=0)"
  else
    rc=$?
    log "sync FAILED rc=$rc"
  fi

  # Preserve the historical five-minute quiet window between full mailbox
  # syncs, but use it for low-latency provider write-back. These calls are
  # deliberately sequential with the sync above (no '&' / background worker).
  elapsed=0
  while [ "$elapsed" -lt "$SYNC_INTERVAL" ]; do
    if ! timeout "$MUTATION_TIMEOUT_SEC" "$PY" -m one_mail_agg.mutation_main "$CONFIG" >> "$LOG" 2>&1; then
      rc=$?
      log "mutation poll FAILED rc=$rc"
    fi
    sleep "$MUTATION_INTERVAL"
    elapsed=$((elapsed + MUTATION_INTERVAL))
  done
done
