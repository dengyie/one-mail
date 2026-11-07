#!/usr/bin/env bash
# 由 .github/workflows/aggregator_deploy.yaml 在 VPS 上调用。
#
# 把 D1 逻辑备份的安装与状态查询放在这里，而不是塞进 workflow：那个文件有
# 600 行上限，而且这些逻辑本身就该是可独立执行的运维动作。
#
#   install : 装 token/启动脚本/备份目录，并在 token 与目标配置都存在时把
#             one-mail-d1-backup program 追加进 supervisor 配置
#   status  : 只读打印 supervisor 状态与最近一天的文件，从不改变任何状态
#
# install 依赖调用方传入：BASE、AGG、STAGE（远端暂存目录）、SUPERVISOR_CONF。
set -euo pipefail

: "${BASE:=/opt/one-mail-agg}"
: "${AGG:=$BASE/aggregator}"
: "${SUPERVISOR_CONF:=$BASE/supervisor-one-mail-agg.conf}"
SUPERVISOR=${SUPERVISOR:-/personal/pxed/supervisord.conf}
PROGRAM_LINE='[program:one-mail-d1-backup]'

# 备份是可选的：没有 token 就不装 program，仓库在没有该 secret 时行为不变。
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
  if ! grep -q "^\[program:one-mail-d1-backup\]$" "$SUPERVISOR_CONF" 2>/dev/null; then
    # 追加而非覆盖：这个文件里还有聚合器与附件服务的 program。
    staged="$SUPERVISOR_CONF.deploy.$$"
    cp "$SUPERVISOR_CONF" "$staged"
    printf '\n' >> "$staged"
    cat "$AGG/deploy/one-mail-d1-backup.supervisor.conf" >> "$staged"
    chmod 0644 "$staged"
    mv -f "$staged" "$SUPERVISOR_CONF"
  fi
  chmod 0644 "$SUPERVISOR_CONF"
  echo "D1 backup program installed"
}

# 备份进程是辅助性的：这里无论如何都返回 0，部署不能因为备份坏掉而失败。
report_status() {
  if ! grep -q "^\[program:one-mail-d1-backup\]$" "$SUPERVISOR_CONF" 2>/dev/null; then
    echo "d1 backup: not installed"
    return 0
  fi
  status=$(supervisorctl -c "$SUPERVISOR" status one-mail-d1-backup 2>&1 || true)
  printf 'd1 backup: %s\n' "$status"
  case "$status" in
    *FATAL*|*EXITED*) printf '::warning::D1 backup is not running: %s\n' "$status" ;;
  esac
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
