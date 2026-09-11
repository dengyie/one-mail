import sys
import time
import logging
import random

from .config import load_config
from .state import SyncState
from .sync import sync_account, default_client_factory
from .oauth import oauth_client_factory, normalize_provider
from .graph_source import sync_graph
from .remote_accounts import fetch_user_accounts, report_sync_status
from .idle_worker import ensure_idle_workers
from .network_guard import assert_public_user_account, UnsafeMailTargetError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("one-mail-agg")


NETWORK_POLICY_ERROR = "mail target rejected by network policy"


def get_merged_accounts(config, state):
    def collision_key(a):
        # 严格按 (host, username) 归一化去重，防止相同邮箱在 config.json 和 user_mail_accounts 中被重复同步两遍打爆 D1
        return (str(a.host).strip().lower(), str(a.username).strip().lower())

    accounts = list(config.accounts)
    seen = {collision_key(a) for a in accounts}
    user_account_ids: set[str] = set()
    user_accounts = fetch_user_accounts(config.worker_base_url, config.admin_token)
    for ua in user_accounts:
        try:
            # User-managed targets are untrusted.  Validate before adding the
            # account to the merged list so neither IDLE nor polling workers can
            # initiate a connection to loopback/private/link-local/reserved IPs.
            assert_public_user_account(ua)
        except UnsafeMailTargetError as exc:
            log.warning("reject unsafe user mail target account=%s host=%r: %s", ua.id, ua.host, exc)
            report_sync_status(config.worker_base_url, config.admin_token, ua.id, NETWORK_POLICY_ERROR)
            continue

        key = collision_key(ua)
        if key in seen:
            log.info("skip duplicate user account %s (host=%s already in config)", ua.username, ua.host)
            continue
        accounts.append(ua)
        seen.add(key)
        user_account_ids.add(ua.id)
    return accounts, user_account_ids


def run_once(config_path: str) -> dict:
    config = load_config(config_path)
    state = SyncState(config.state_path)

    accounts, user_account_ids = get_merged_accounts(config, state)

    results = {}
    for account in accounts:
        is_user = account.id in user_account_ids
        if state.should_skip_account(account.id):
            fail_count, skip_until_ts = state.get_fail_state(account.id)
            msg = ("skipped (consecutive_failures=%d, backoff window open until ts=%.0f)"
                   % (fail_count, skip_until_ts))
            results[account.id] = {"error": msg}
            log.warning("sync %s %s", account.id, msg)
            if is_user:
                report_sync_status(config.worker_base_url, config.admin_token,
                                   account.id, msg)
            continue
        try:
            if account.source == "graph_outlook":
                results[account.id] = sync_graph(account, config, state, config_path)
                r = results[account.id]
                log.info("synced %s: protocol=%s synced=%d dropped=%d",
                         account.id, r.get("protocol") or "?", r.get("synced", 0), r.get("dropped", 0))
                state.record_success(account.id)
                if is_user:
                    report_sync_status(config.worker_base_url, config.admin_token, account.id, None)
                continue
            factory = oauth_client_factory(account) if account.oauth is not None else default_client_factory
        except (KeyError, AttributeError, TypeError):
            provider = normalize_provider(
                account.oauth.get("provider")
                if isinstance(account.oauth, dict)
                else None) or (
                account.oauth.get("provider")
                if isinstance(account.oauth, dict) else "<malformed:not-dict>") or "<missing>"
            results[account.id] = {"error": f"provider unsupported: {provider}"}
            log.error("sync %s failed: provider unsupported: %s", account.id, provider)
            state.record_failure(account.id)
            if is_user:
                report_sync_status(config.worker_base_url, config.admin_token,
                                   account.id, f"provider unsupported: {provider}")
            continue
        try:
            results[account.id] = sync_account(factory, config, account, state)
            r = results[account.id]
            log.info("synced %s: protocol=%s synced=%d dropped=%d",
                     account.id, r.get("protocol") or "?", r.get("synced", 0), r.get("dropped", 0))
            state.record_success(account.id)
            if is_user:
                report_sync_status(config.worker_base_url, config.admin_token, account.id, None)
        except Exception as e:
            results[account.id] = {"error": str(e)}
            log.error("sync %s failed: %s", account.id, e)
            state.record_failure(account.id)
            if is_user:
                report_sync_status(config.worker_base_url, config.admin_token, account.id, str(e))
            time.sleep(min(1 + random.random(), 3))
    return results


def run_daemon(config_path: str, poll_interval: int = 60) -> int:
    """长期守护进程模式：

    1. 为支持的 IMAP 账号拉起常驻 IDLE 监听线程，秒级实时监听新邮件推送；
    2. 主循环每隔 poll_interval（默认 60s）执行常规增量拉取（兜底 POP3 及拉取新增用户账号）。
    """
    log.info("Starting one-mail-agg in continuous daemon mode (poll_interval=%ds)", poll_interval)
    config = load_config(config_path)
    state = SyncState(config.state_path)

    while True:
        try:
            # 1. 刷新配置与账号列表
            config = load_config(config_path)
            accounts, user_account_ids = get_merged_accounts(config, state)

            # 2. 保证 IMAP 账号的 IDLE 监听线程就绪
            ensure_idle_workers(config, state, accounts)

            # 3. 对非纯 IMAP 或未被 IDLE 托管的账号（如 POP3 163 等）执行轮询同步
            for account in accounts:
                # 若已有存活的 IDLE worker 正在托管该账号，无需在主循环频繁重复同步，
                # IDLE 线程自会处理实时事件及 4 分钟保底刷新；
                # 但对于 POP3 或 fallback 到 POP3 的账号，走常规轮询同步。
                is_user = account.id in user_account_ids
                if state.should_skip_account(account.id):
                    continue

                # 判定当前账号是否完全由存活的 IDLE worker 处理
                from .idle_worker import _active_idle_workers
                is_idle_active = (
                    account.id in _active_idle_workers
                    and _active_idle_workers[account.id].is_alive()
                    and not _active_idle_workers[account.id].is_stopped()
                )

                if is_idle_active:
                    # IDLE 线程正在全实时监听，跳过主线程重复轮询
                    continue

                try:
                    if account.source == "graph_outlook":
                        r = sync_graph(account, config, state, config_path)
                    else:
                        factory = oauth_client_factory(account) if account.oauth is not None else default_client_factory
                        r = sync_account(factory, config, account, state)
                    if r.get("synced", 0) > 0:
                        log.info("poll synced %s: protocol=%s synced=%d dropped=%d",
                                 account.id, r.get("protocol") or "?", r.get("synced", 0), r.get("dropped", 0))
                    state.record_success(account.id)
                    if is_user:
                        report_sync_status(config.worker_base_url, config.admin_token, account.id, None)
                except Exception as e:
                    log.warning("poll sync %s error: %s", account.id, e)
                    state.record_failure(account.id)

        except Exception as e:
            log.error("daemon iteration error: %s", e)

        time.sleep(poll_interval)


def main() -> int:
    config_path = sys.argv[1] if len(sys.argv) > 1 else "./config.json"
    daemon_mode = "--daemon" in sys.argv
    if daemon_mode:
        return run_daemon(config_path)
    run_once(config_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
