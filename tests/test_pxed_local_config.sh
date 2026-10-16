#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/deploy/pxed-local-config.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/include" "$tmp/local"

printf 'old config\n' > "$tmp/include/service.conf"
pxed_ensure_local_config_link "$tmp/include/service.conf" "$tmp/local/service.conf" 0644
[[ -L "$tmp/include/service.conf" ]]
[[ "$(readlink "$tmp/include/service.conf")" == "$tmp/local/service.conf" ]]
[[ "$(cat "$tmp/local/service.conf")" == 'old config' ]]

cp "$tmp/local/service.conf" "$tmp/backup.conf"
printf 'new config\n' > "$tmp/new.conf"
pxed_atomic_install_local_config "$tmp/new.conf" "$tmp/local/service.conf" 0644
[[ "$(cat "$tmp/include/service.conf")" == 'new config' ]]
pxed_ensure_local_config_link "$tmp/include/service.conf" "$tmp/local/service.conf" 0644
[[ "$(cat "$tmp/include/service.conf")" == 'new config' ]]

if pxed_atomic_install_local_config "$tmp/missing.conf" "$tmp/local/service.conf" 0644 2>/dev/null; then
    echo "install unexpectedly accepted a missing source" >&2
    exit 1
fi
[[ "$(cat "$tmp/local/service.conf")" == 'new config' ]]

pxed_restore_local_config "$tmp/backup.conf" "$tmp/local/service.conf" 0644
[[ "$(cat "$tmp/include/service.conf")" == 'old config' ]]

echo "pxed local config tests passed"
