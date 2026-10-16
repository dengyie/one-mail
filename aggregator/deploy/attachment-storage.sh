#!/usr/bin/env bash
set -euo pipefail

BASE=/opt/one-mail-agg
PY="$BASE/aggregator/.venv/bin/python"
TOKEN_FILE="$BASE/attachment-storage.token"
ROOT=/opt/one-mail-attachments
MIN_FREE_BYTES="${ATTACHMENT_STORAGE_MIN_FREE_BYTES:-536870912}"

case "$MIN_FREE_BYTES" in
  ''|*[!0-9]*)
    echo "ATTACHMENT_STORAGE_MIN_FREE_BYTES must be a non-negative integer" >&2
    exit 1
    ;;
esac

test -x "$PY"
test -r "$TOKEN_FILE"
exec "$PY" -m one_mail_agg.storage_server \
  --root "$ROOT" \
  --token-file "$TOKEN_FILE" \
  --host 127.0.0.1 \
  --port 39001 \
  --min-free-bytes "$MIN_FREE_BYTES"
