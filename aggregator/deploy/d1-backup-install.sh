#!/usr/bin/env bash
# 由 .github/workflows/aggregator_deploy.yaml 在 tencent-lh 上调用。
#
# 把 D1 逻辑备份的安装与状态查询放在这里，而不是塞进 workflow：那个文件有
# 600 行上限，而且这些逻辑本身就该是可独立执行的运维动作。
#
#   install : 装 token/启动脚本/systemd unit，并在 token 与目标配置都存在时
#             enable --now one-mail-d1-backup.service
#   status  : 只读打印 systemd 状态与最近一天的文件，从不改变任何状态
#
# install 依赖调用方传入：BASE、AGG、STAGE（远端暂存目录）。
set -euo pipefail

: "${BASE:=/opt/one-mail-agg}"
: "${AGG:=$BASE/aggregator}"
UNIT_NAME=one-mail-d1-backup
UNIT_FILE=/etc/systemd/system/${UNIT_NAME}.service

# 备份是可选的：没有 token 就不装 unit，仓库在没有该 secret 时行为不变。
install_program() {
  if [ ! -f "${STAGE:-/nonexistent}/d1-backup.token" ]; then
    echo "D1_BACKUP_API_TOKEN absent: leaving the D1 backup program disabled"
    return 0
  fi
  # 只要 token 到手就先装启动脚本：先装 token 再因为缺配置而跳过，会让一份
  # 可用的 token 留在 /opt 之外，下一次部署就可能把它当成陈旧文件清掉。
  install -m 0600 "$STAGE/d1-backup.token" "$BASE/d1-backup.token"
  install -m 0755 "$AGG/deploy/d1-backup.sh" "$BASE/d1-backup.sh"
  if [ ! -f "$BASE/d1-backup.json" ]; then
    echo "$BASE/d1-backup.json is missing: create it from deploy/d1-backup.example.json to enable D1 backups"
    return 0
  fi
  install -d -m 0700 /opt/one-mail-backups
  install -m 0644 "$AGG/deploy/one-mail-d1-backup.service" "$UNIT_FILE"
  systemctl daemon-reload
  systemctl enable --now "$UNIT_NAME"
  echo "D1 backup unit installed and enabled"
}

# 备份进程是辅助性的：这里无论如何都返回 0，部署不能因为备份坏掉而失败。
report_status() {
  if [ ! -f "$UNIT_FILE" ]; then
    echo "d1 backup: not installed"
    return 0
  fi
  status=$(systemctl is-active "$UNIT_NAME" 2>&1 || true)
  printf 'd1 backup: %s\n' "$status"
  case "$status" in
    failed|inactive) printf '::warning::D1 backup is not running: %s\n' "$status" ;;
  esac
  tail -n 20 /opt/one-mail-backups/runs.jsonl 2>/dev/null || true
  ls -lh /opt/one-mail-backups/daily 2>/dev/null | tail -n 5 || true
  return 0
}

case "${1:-install}" in
  install) install_program ;;
  status) report_status ;;
  *)
    echo "usage: $0 [install|status]" >&2
    exit 2
    ;;
esac
