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
    # Collision policy: only equivalent transport identities collide. POP3
    # endpoint/TLS settings are included so a valid user account is not silently
    # swallowed by an admin account with different fallback behavior.
    def collision_key(a):
        return (a.host, a.port, a.username, a.use_ssl, a.protocol,
                a.pop3_host, a.pop3_port, a.pop3_ssl, a.pop3_use_stls,
                tuple(a.folders))

    accounts = list(config.accounts)
    seen = {collision_key(a) for a in accounts}
    user_account_ids: set[str] = set()   # 仅用户接入账号回写 sync 状态（admin config 账号无对应行）
    user_accounts = fetch_user_accounts(config.worker_base_url, config.admin_token)
    for ua in user_accounts:
        key = collision_key(ua)
        if key in seen:
            log.info("skip duplicate user account %s (host=%s already in config)", ua.username, ua.host)
            continue
        accounts.append(ua)
        seen.add(key)
        user_account_ids.add(ua.id)

    results = {}
    for account in accounts:
        is_user = account.id in user_account_ids
        # ===== 连续失败退避守卫（修复 #2）：退避窗口内直接跳过该账号，不再尝试连接 =====
        if state.should_skip_account(account.id):
            fail_count, skip_until_ts = state.get_fail_state(account.id)
            msg = ("skipped (consecutive_failures=%d, backoff window open until ts=%.0f)"
                   % (fail_count, skip_until_ts))
            results[account.id] = {"error": msg}
            log.warning("sync %s %s", account.id, msg)
            if is_user:
                report_sync_status(config.worker_base_url, config.admin_token,
                                   account.id, msg)
            continue  # 仍在退避：不尝试连接，避免无意义轰炸目标服务器触发封 IP
        # provider 解析 / client 工厂构造单独包裹：未知 OAuth provider 抛
        # KeyError/AttributeError/TypeError（_TOKEN_FN 直索引 / oauth 非 dict）时
        # 只降级为「该账号错误」，绝不让整个循环跳出冻结其后所有账号（修复 #3）。
        try:
            # oauth is not None（含空 dict {}、字符串等畸形值）：都当 OAuth 账号走
            # 工厂——空 dict 若按 falsy 回落 default_client_factory，会用 refresh_token
            # 当密码连 IMAP，报错含糊且浪费一次连接；防御式识别成「缺 provider」更清晰。
            factory = oauth_client_factory(account) if account.oauth is not None else default_client_factory
        except (KeyError, AttributeError, TypeError):
            provider = (account.oauth.get("provider")
                        if isinstance(account.oauth, dict)
                        else "<malformed:not-dict>") or "<missing>"
            results[account.id] = {"error": f"provider unsupported: {provider}"}
            log.error("sync %s failed: provider unsupported: %s", account.id, provider)
            state.record_failure(account.id)   # 配置级错误同样计入连续失败退避
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
            # 成功（含 0 新邮件——账号可达即健康）：清零失败计数、解除退避
            state.record_success(account.id)
            # 成功：回写清空 last_error、刷新 last_sync_at（仅用户账号）
            if is_user:
                report_sync_status(config.worker_base_url, config.admin_token, account.id, None)
        except Exception as e:
            results[account.id] = {"error": str(e)}
            log.error("sync %s failed: %s", account.id, e)
            # 失败：累计连续失败计数，达到阈值进入退避（下轮直接跳过该账号）
            state.record_failure(account.id)
            # 失败：回写 last_error 供用户在「我的邮箱」页看到（如「IMAP 登录失败」），
            # 仅用户账号——admin config 账号的错误只在日志里。
            if is_user:
                report_sync_status(config.worker_base_url, config.admin_token, account.id, str(e))
            # 单账号失败不影响其他；下次运行重试
            time.sleep(min(1 + random.random(), 3))
    return results


def main() -> int:
    config_path = sys.argv[1] if len(sys.argv) > 1 else "./config.json"
    run_once(config_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
