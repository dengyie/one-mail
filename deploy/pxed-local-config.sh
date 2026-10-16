#!/usr/bin/env bash
set -euo pipefail

pxed_ensure_local_config_link() {
    local include_path=$1
    local local_path=$2
    local mode=$3
    local stage="${local_path}.seed.$$"
    local link_stage="${include_path}.link.$$"

    mkdir -p "$(dirname "$local_path")" "$(dirname "$include_path")"
    if [[ -L "$include_path" && "$(readlink "$include_path")" == "$local_path" ]]; then
        [[ -f "$local_path" ]] || { echo "missing local config target: $local_path" >&2; return 1; }
        return 0
    fi

    if [[ -e "$include_path" || -L "$include_path" ]]; then
        if ! install -m "$mode" "$include_path" "$stage"; then
            rm -f "$stage"
            return 1
        fi
        if ! mv -f "$stage" "$local_path"; then
            rm -f "$stage"
            return 1
        fi
    elif [[ ! -e "$local_path" ]]; then
        install -m "$mode" /dev/null "$stage"
        if ! mv -f "$stage" "$local_path"; then
            rm -f "$stage"
            return 1
        fi
    fi

    ln -s "$local_path" "$link_stage"
    if ! mv -f "$link_stage" "$include_path"; then
        rm -f "$link_stage"
        return 1
    fi
}

pxed_atomic_install_local_config() {
    local source=$1
    local target=$2
    local mode=$3
    local stage="${target}.deploy.$$"

    if ! install -m "$mode" "$source" "$stage"; then
        rm -f "$stage"
        return 1
    fi
    if ! mv -f "$stage" "$target"; then
        rm -f "$stage"
        return 1
    fi
}

pxed_restore_local_config() {
    local backup=$1
    local target=$2
    local mode=$3

    if [[ -f "$backup" ]]; then
        pxed_atomic_install_local_config "$backup" "$target" "$mode"
    else
        pxed_atomic_install_local_config /dev/null "$target" "$mode"
    fi
}
