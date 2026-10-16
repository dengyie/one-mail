#!/usr/bin/env bash
set -euo pipefail

BASE=/opt/one-mail-agg
PY="$BASE/aggregator/.venv/bin/python"
TOKEN_FILE="$BASE/attachment-storage.token"
ROOT=/opt/one-mail-attachments

test -x "$PY"
test -r "$TOKEN_FILE"
exec "$PY" -m one_mail_agg.storage_server \
  --root "$ROOT" \
  --token-file "$TOKEN_FILE" \
  --host 127.0.0.1 \
  --port 39001
