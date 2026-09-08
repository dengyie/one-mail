#!/usr/bin/env bash
set -euo pipefail

echo "==> Waiting for worker at $WORKER_URL ..."
for i in $(seq 1 60); do
  if curl -sf "$WORKER_URL/health_check" > /dev/null 2>&1; then
    echo "    Worker ready after ${i}s"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ERROR: Worker not ready after 60s"
    exit 1
  fi
  sleep 1
done

if [ -n "${WORKER_URL_SUBDOMAIN:-}" ]; then
  echo "==> Waiting for subdomain worker at $WORKER_URL_SUBDOMAIN ..."
  for i in $(seq 1 60); do
    if curl -sf "$WORKER_URL_SUBDOMAIN/health_check" > /dev/null 2>&1; then
      echo "    Subdomain worker ready after ${i}s"
      break
    fi
    if [ "$i" -eq 60 ]; then
      echo "ERROR: Subdomain worker not ready after 60s"
      exit 1
    fi
    sleep 1
  done
fi

if [ -n "${WORKER_URL_ENV_OFF:-}" ]; then
  echo "==> Waiting for env-off worker at $WORKER_URL_ENV_OFF ..."
  for i in $(seq 1 60); do
    if curl -sf "$WORKER_URL_ENV_OFF/health_check" > /dev/null 2>&1; then
      echo "    Env-off worker ready after ${i}s"
      break
    fi
    if [ "$i" -eq 60 ]; then
      echo "ERROR: Env-off worker not ready after 60s"
      exit 1
    fi
    sleep 1
  done
fi

if [ -n "${WORKER_GZIP_URL:-}" ]; then
  echo "==> Waiting for worker-gzip at $WORKER_GZIP_URL ..."
  for i in $(seq 1 60); do
    if curl -sf "$WORKER_GZIP_URL/health_check" > /dev/null 2>&1; then
      echo "    Worker-gzip ready after ${i}s"
      break
    fi
    if [ "$i" -eq 60 ]; then
      echo "ERROR: Worker-gzip not ready after 60s"
      exit 1
    fi
    sleep 1
  done
fi

echo "==> Waiting for frontend at $FRONTEND_URL ..."
for i in $(seq 1 60); do
  if curl -skf "$FRONTEND_URL" > /dev/null 2>&1; then
    echo "    Frontend ready after ${i}s"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ERROR: Frontend not ready after 60s"
    exit 1
  fi
  sleep 1
done

echo "==> Waiting for smtp-proxy-tls SMTP on $SMTP_PROXY_TLS_HOST:$SMTP_PROXY_TLS_SMTP_PORT ..."
for i in $(seq 1 30); do
  if nc -z "$SMTP_PROXY_TLS_HOST" "$SMTP_PROXY_TLS_SMTP_PORT" 2>/dev/null; then
    echo "    smtp-proxy-tls SMTP ready after ${i}s"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "WARNING: smtp-proxy-tls SMTP not ready after 30s, continuing anyway"
  fi
  sleep 1
done

post_checked() {
  local label="$1"
  local base_url="$2"
  local endpoint="$3"
  local response_file
  local status

  response_file="$(mktemp)"
  if ! status="$(curl -sS -o "$response_file" -w '%{http_code}' -X POST "${base_url}${endpoint}")"; then
    echo "ERROR: ${label}${endpoint} request failed (curl status ${status:-unknown})"
    cat "$response_file"
    rm -f "$response_file"
    return 1
  fi
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "ERROR: ${label}${endpoint} returned HTTP ${status}"
    cat "$response_file"
    rm -f "$response_file"
    return 1
  fi
  rm -f "$response_file"
}

echo "==> Initializing database"
post_checked "Database" "$WORKER_URL" "/admin/db_initialize"
post_checked "Database" "$WORKER_URL" "/admin/db_migration"
echo "    Database initialized"

if [ -n "${WORKER_URL_SUBDOMAIN:-}" ]; then
  echo "==> Initializing subdomain worker database"
  post_checked "Subdomain database" "$WORKER_URL_SUBDOMAIN" "/admin/db_initialize"
  post_checked "Subdomain database" "$WORKER_URL_SUBDOMAIN" "/admin/db_migration"
  echo "    Subdomain worker database initialized"
fi

if [ -n "${WORKER_URL_ENV_OFF:-}" ]; then
  echo "==> Initializing env-off worker database"
  post_checked "Env-off database" "$WORKER_URL_ENV_OFF" "/admin/db_initialize"
  post_checked "Env-off database" "$WORKER_URL_ENV_OFF" "/admin/db_migration"
  echo "    Env-off database initialized"
fi

if [ -n "${WORKER_GZIP_URL:-}" ]; then
  echo "==> Initializing gzip worker database"
  post_checked "Gzip database" "$WORKER_GZIP_URL" "/admin/db_initialize"
  post_checked "Gzip database" "$WORKER_GZIP_URL" "/admin/db_migration"
  echo "    Gzip worker database initialized"
fi

if [ -n "${WORKER_URL_SEND_MAIL_DOMAIN:-}" ]; then
  echo "==> Initializing send-mail-domain worker database"
  post_checked "Send-mail-domain database" "$WORKER_URL_SEND_MAIL_DOMAIN" "/admin/db_initialize"
  post_checked "Send-mail-domain database" "$WORKER_URL_SEND_MAIL_DOMAIN" "/admin/db_migration"
  echo "    Send-mail-domain database initialized"
fi

echo "==> Running Playwright tests"
exec npx playwright test "$@"
