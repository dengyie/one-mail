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

    accounts = []
    for a in data.get("accounts", []):
        try:
            accounts.append(AccountConfig(
                id=a["id"],
                source=a.get("source") or "imap_custom",
                host=a["host"],
                port=int(a["port"]),
                username=a["username"],
                password=a["password"],
                folders=a.get("folders") or ["INBOX"],
                use_ssl=True,
                oauth=a.get("oauth") or None,
                protocol=a.get("protocol") or "auto",
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
