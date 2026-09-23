#!/bin/bash
# one-mail 聚合器常驻入口（由 supervisord 托管，command 即本脚本）。
#
# 单进程单写者：直接 exec 聚合器的 --daemon 模式，而不是外层 300s 轮询 + 每次
# 起子进程调 mutation_main 的循环。daemon 在同一进程内完成三件事：
#   1. 为支持 IMAP IDLE 的账号拉起常驻监听线程 —— 服务器推送即秒级同步；
#   2. 每 60s 兜底一轮完整增量拉取（POP3 / graph / 新用户账号 / IDLE 降级账号）；
#   3. 其余每 5s 一个 tick 排空 provider mutation 队列（已读 / 星标 / 移动回写）。
#
# 收信、回写、以及所有 refresh_token 兑换都落在同一进程，由进程级
# redemption_lock 串行化。MSA/Graph 的 refresh_token 每次兑换都轮换，并发兑换
# 会让其中一份立刻失效——这正是 2026-09-11 烧卡事故的并发版本。
set -uo pipefail
LOG=/opt/one-mail-agg/agg-loop.log
PY=/opt/one-mail-agg/aggregator/.venv/bin/python
CONFIG=/opt/one-mail-agg/config.json
TS() { date "+%Y-%m-%d %H:%M:%S"; }

echo "[$(TS)] one-mail-agg daemon start: IMAP IDLE realtime + 60s fallback poll + 5s mutation drain" >> "$LOG"
exec "$PY" -m one_mail_agg.main "$CONFIG" --daemon >> "$LOG" 2>&1
