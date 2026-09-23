import sys
import time
import logging
import random

from .config import load_config
from .state import SyncState
from .sync import sync_account, default_client_factory
from .oauth import oauth_client_factory, normalize_provider
from .graph_source import sync_graph
from .mutation_jobs import process_mutation_jobs
from .remote_accounts import fetch_user_accounts, report_sync_status
from .idle_worker import ensure_idle_workers
from .network_guard import assert_public_user_account, UnsafeMailTargetError
from .egress_guard import install_egress_guard

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
                results[account.id] = sync_graph(account, config, state)
                r = results[account.id]
                log.info("synced %s: protocol=%s synced=%d dropped=%d",
                         account.id, r.get("protocol") or "?", r.get("synced", 0), r.get("dropped", 0))
                state.record_success(account.id)
                if is_user:
                    report_sync_status(config.worker_base_url, config.admin_token, account.id, None)
                continue
            factory = oauth_client_factory(account, config) if account.oauth is not None else default_client_factory
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


def _poll_pass(config, state) -> None:
    """一轮完整增量拉取：维持 IDLE 线程，并兜底同步未被 IDLE 托管的账号。"""
    accounts, user_account_ids = get_merged_accounts(config, state)

    # 1. 保证 IMAP 账号的 IDLE 监听线程就绪（秒级实时推送）
    ensure_idle_workers(config, state, accounts)

    # 2. 对非纯 IMAP 或未被 IDLE 托管的账号（如 POP3 163 / graph 等）执行轮询同步
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
                r = sync_graph(account, config, state)
            else:
                factory = oauth_client_factory(account, config) if account.oauth is not None else default_client_factory
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


def _drain_mutation_jobs(config) -> None:
    """排空 provider mutation 队列（已读/星标/移动的回写）。

    与同步同进程、不并发：mutation 需要为账号兑换 refresh_token，与同步并发兑换
    会让其中一份拿到的 RT 立刻失效。单进程 tick 串行天然只有一个写者。
    """
    result = process_mutation_jobs(config)
    if result.get("claimed", 0):
        log.info("mutation batch claimed=%d succeeded=%d retried=%d failed=%d unsupported=%d",
                 result.get("claimed", 0), result.get("succeeded", 0), result.get("retried", 0),
                 result.get("failed", 0), result.get("unsupported", 0))


def run_daemon(config_path: str, poll_interval: int = 60,
               mutation_interval: int = 5) -> int:
    """长期守护进程模式（单进程单写者）：

    1. 为支持的 IMAP 账号拉起常驻 IDLE 监听线程，秒级实时接收新邮件推送；
    2. 每 mutation_interval（默认 5s）一个 tick：到点跑一轮完整增量拉取
       （兜底 POP3 / graph / 新增用户账号），其余 tick 排空 provider mutation 队列。

    每个 tick 重新读 config.json：IDLE 线程轮换出的新 refresh_token 已原子写回
    该文件，用旧快照兑换会直接把账号打失效。
    """
    log.info("Starting one-mail-agg in continuous daemon mode (poll_interval=%ds, mutation_interval=%ds)",
             poll_interval, mutation_interval)
    state = SyncState(load_config(config_path).state_path)
    next_poll_at = 0.0

    while True:
        tick_started = time.monotonic()
        try:
            config = load_config(config_path)
            if tick_started >= next_poll_at:
                next_poll_at = tick_started + poll_interval
                _poll_pass(config, state)
            else:
                _drain_mutation_jobs(config)
        except Exception as e:
            log.error("daemon iteration error: %s", e)

        time.sleep(mutation_interval)


def main() -> int:
    # 进程级出站防线：在 admission 时的 DNS 校验与真实 connect 之间存在
    # rebinding/TOCTOU 窗口，部署容器无内核防火墙能力（无 CAP_NET_ADMIN /
    # systemd / docker），因此在 connect(2) 时刻对实际目标地址做最终校验。
    install_egress_guard()
    config_path = sys.argv[1] if len(sys.argv) > 1 else "./config.json"
    daemon_mode = "--daemon" in sys.argv
    if daemon_mode:
        return run_daemon(config_path)
    run_once(config_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
