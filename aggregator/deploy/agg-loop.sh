#!/bin/bash
# one-mail IMAP 聚合器常驻循环：每 300s 跑一次 real sync。
# pxed 无 systemd/cron，由 supervisord 托管本脚本常驻循环（见 deploy/one-mail-agg.supervisor.conf）。
# 日志落 /opt/one-mail-agg/agg-loop.log（supervisord 再把 stdout/stderr 捕到 agg.supervisor.*.log）。
set -uo pipefail
LOG=/opt/one-mail-agg/agg-loop.log
INTERVAL=300
TIMEOUT_SEC=240
TS() { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(TS)] $*" >> "$LOG"; }

log "one-mail-agg loop start pid=$$ interval=${INTERVAL}s timeout=${TIMEOUT_SEC}s"
while true; do
  if timeout "$TIMEOUT_SEC" /opt/one-mail-agg/aggregator/.venv/bin/python -m one_mail_agg.main /opt/one-mail-agg/config.json >> "$LOG" 2>&1; then
    log "sync OK (rc=0)"
  else
    rc=$?
    log "sync FAILED rc=$rc"
  fi
  sleep "$INTERVAL"
done
