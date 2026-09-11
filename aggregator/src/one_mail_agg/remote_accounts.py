"""从 Worker 拉取普通用户自助接入的外部邮箱账号（多租户）。

Worker 端 `GET /admin/unified/mail_accounts`（x-admin-auth 保护）返回所有
enabled=1 的用户邮箱，**含解密后的明文凭据**。这里映射成与 config.json 同构的
AccountConfig，合并进每轮 sync。单账号 key 用 user_mail_accounts.id，
与 admin 的 config.json 账号天然隔离（SyncState 按 account_id 键）。

失败时记日志返回空列表，绝不阻塞 admin 账号的同步——用户账号挂了不应影响
管理员自有邮箱的归集。
"""
import logging

import requests

from .config import AccountConfig

log = logging.getLogger("one-mail-agg")


def _folders(value) -> list[str]:
    """Return a safe folder list from the Worker JSON payload.

    The Worker normally emits an array, but this boundary must remain tolerant of
    old rows and hand-edited/malformed responses.  Do not pass a string through:
    sync iterates folders and would otherwise process one character at a time.
    """
    if not isinstance(value, list):
        return ["INBOX"]
    folders = [folder.strip() for folder in value
               if isinstance(folder, str) and folder.strip()]
    return folders or ["INBOX"]


def _optional_int(value, default: int = 0) -> int:
    """Parse an optional TCP port and reject values outside its legal range."""
    if value is None or value == "":
        return default
    # bool is an int subclass, but accepting true as port 1 is never valid
    # configuration.  Also avoid silently truncating floats (int(1.5)).
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError(f"invalid port: {value!r}")
    if isinstance(value, str) and not value.strip().isdigit():
        raise ValueError(f"invalid port: {value!r}")
    port = int(value)
    if not 1 <= port <= 65535:
        raise ValueError(f"port out of range: {port}")
    return port


def _optional_bool(value, default=None):
    """Parse bool-like API values without treating ``"false"`` as true."""
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    raise ValueError(f"invalid boolean: {value!r}")


def fetch_user_accounts(worker_base_url: str, admin_token: str) -> list[AccountConfig]:
    url = f"{worker_base_url}/admin/unified/mail_accounts"
    headers = {"x-admin-auth": admin_token}
    try:
        r = requests.get(url, headers=headers, timeout=15)
        if r.status_code != 200:
            log.warning("fetch user mail_accounts failed: HTTP %s %s",
                        r.status_code, r.text[:200])
            return []
        data = r.json()
    except Exception as e:
        log.warning("fetch user mail_accounts error: %s", e)
        return []

    if not isinstance(data, dict):
        log.warning("fetch user mail_accounts returned non-object JSON: %r", type(data).__name__)
        return []
    raw_accounts = data.get("accounts", [])
    if not isinstance(raw_accounts, list):
        log.warning("fetch user mail_accounts returned non-list accounts: %r",
                    type(raw_accounts).__name__)
        return []

    accounts = []
    for a in raw_accounts:
        if not isinstance(a, dict):
            log.warning("skip malformed user account payload: expected object, got %r",
                        type(a).__name__)
            continue
        try:
            # Reject structurally unsafe values at the Worker boundary.  In
            # particular IDs become state keys and URL path components later.
            if (not isinstance(a.get("id"), (str, int)) or
                    not isinstance(a.get("host"), str) or
                    not isinstance(a.get("username"), str) or
                    not isinstance(a.get("password"), str)):
                raise ValueError("id/host/username/password have invalid types")
            accounts.append(AccountConfig(
                id=str(a["id"]),
                source=a.get("source") or "imap_custom",
                host=a["host"],
                port=_optional_int(a["port"]),
                username=a["username"],
                password=a["password"],
                folders=_folders(a.get("folders")),
                # IMAP settings keep their historical defaults.  POP3 fields
                # are additive and are intentionally passed through so POP3
                # fallback/direct mode uses the Worker account configuration.
                use_ssl=_optional_bool(a.get("use_ssl"), True),
                oauth=a.get("oauth") or None,
                protocol=a["protocol"] if "protocol" in a else "auto",
                pop3_host=a.get("pop3_host") or "",
                pop3_port=_optional_int(a.get("pop3_port")),
                pop3_ssl=_optional_bool(a.get("pop3_ssl")),
                pop3_use_stls=_optional_bool(a.get("pop3_use_stls"), False),
                initial_sync_limit=_optional_int(a.get("initial_sync_limit"), 50),
                user_managed=True,
            ))
        except (KeyError, ValueError, TypeError) as e:
            log.warning("skip malformed user account %s: %s", a.get("id"), e)
    log.info("fetched %d user mail account(s)", len(accounts))
    return accounts


def report_sync_status(worker_base_url: str, admin_token: str,
                        account_id: str, error: str | None) -> None:
    """回写单个用户邮箱的 sync 状态到 Worker（/admin/unified/mail_accounts/:id/status）。

    成功时 error=None（清空 last_error、刷新 last_sync_at）；失败时写 error 字符串。
    只对 user_mail_accounts 的账号有意义（admin config.json 账号没有对应行，404 无害）。
    失败时仅记日志，绝不阻塞 sync 主流程——状态回写挂了不应影响邮件归集。
    """
    url = f"{worker_base_url}/admin/unified/mail_accounts/{account_id}/status"
    headers = {"x-admin-auth": admin_token}
    try:
        r = requests.post(url, json={"error": error} if error else {}, headers=headers, timeout=10)
        if r.status_code not in (200, 404):
            log.warning("report sync status for %s failed: HTTP %s %s",
                        account_id, r.status_code, r.text[:200])
    except Exception as e:
        log.warning("report sync status for %s error: %s", account_id, e)
