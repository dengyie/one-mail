import sys
import time
import logging
import random

from .config import load_config
from .state import SyncState
from .sync import sync_account, default_client_factory
from .oauth import oauth_client_factory
from .remote_accounts import fetch_user_accounts, report_sync_status

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("one-mail-agg")


def run_once(config_path: str) -> dict:
    config = load_config(config_path)
    state = SyncState(config.state_path)

    # 合并账号来源：
    #   1) config.json 的 admin 账号（管理员自有邮箱）
    #   2) Worker /admin/unified/mail_accounts 拉取的普通用户自助接入邮箱
    # 用户账号挂了不应阻塞 admin 账号（fetch_user_accounts 内部已 fail-soft）。
    # 按 (host, username) 去重：避免 admin 与用户接入同一邮箱时两套凭据争抢；
    # 用 host+username 组合而非单 username，更贴合「同一邮箱同一主人」语义。
    accounts = list(config.accounts)
    seen = {(a.host, a.username) for a in accounts}
    user_account_ids: set[str] = set()   # 仅用户接入账号回写 sync 状态（admin config 账号无对应行）
    user_accounts = fetch_user_accounts(config.worker_base_url, config.admin_token)
    for ua in user_accounts:
        key = (ua.host, ua.username)
        if key in seen:
            log.info("skip duplicate user account %s (host=%s already in config)", ua.username, ua.host)
            continue
        accounts.append(ua)
        seen.add(key)
        user_account_ids.add(ua.id)

    results = {}
    for account in accounts:
        is_user = account.id in user_account_ids
        # provider 解析 / client 工厂构造单独包裹：未知 OAuth provider 抛 KeyError
        # （_TOKEN_FN 直索引）时只降级为「该账号错误」，绝不让整个循环跳出冻结
        # 后续所有用户账号（review A1）。隔离这一小段避免把 sync_account 内部
        # 可能的 KeyError（如 UIDVALIDITY 缺失）误归类为 provider 问题。
        try:
            factory = oauth_client_factory(account) if account.oauth else default_client_factory
        except KeyError:
            provider = (account.oauth or {}).get("provider") or "<missing>"
            results[account.id] = {"error": f"provider unsupported: {provider}"}
            log.error("sync %s failed: provider unsupported: %s", account.id, provider)
            # 不支持的 OAuth provider 属于配置级错误：回写账号级 last_error，
            # 仅用户账号供用户在「我的邮箱」页看到；admin config 账号只记日志。
            if is_user:
                report_sync_status(config.worker_base_url, config.admin_token,
                                   account.id, f"provider unsupported: {provider}")
            continue  # 跳过该账号且不影响后续账号；下一轮运行会重试同批
        try:
            results[account.id] = sync_account(factory, config, account, state)
            r = results[account.id]
            log.info("synced %s: protocol=%s synced=%d dropped=%d",
                     account.id, r.get("protocol") or "?", r.get("synced", 0), r.get("dropped", 0))
            # 成功：回写清空 last_error、刷新 last_sync_at（仅用户账号）
            if is_user:
                report_sync_status(config.worker_base_url, config.admin_token, account.id, None)
        except Exception as e:
            results[account.id] = {"error": str(e)}
            log.error("sync %s failed: %s", account.id, e)
            # 失败：回写 last_error 供用户在「我的邮箱」页看到（如「IMAP 登录失败」），
            # 仅用户账号——admin config 账号的错误只在日志里。
            if is_user:
                report_sync_status(config.worker_base_url, config.admin_token, account.id, str(e))
            # 单账号失败不影响其他；下次运行重试
            time.sleep(min(2 ** 0 + random.random(), 3))
    return results


def main() -> int:
    config_path = sys.argv[1] if len(sys.argv) > 1 else "./config.json"
    run_once(config_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
