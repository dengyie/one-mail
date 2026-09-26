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
from .proxy_client import OVERSEAS_IMAP_HOSTS

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("one-mail-agg")


NETWORK_POLICY_ERROR = "mail target rejected by network policy"


def is_rate_limit_error(error: Exception | str) -> bool:
    """检查异常信息是否为服务端频控或流量配额限制（如网易 163 登录太频繁、超出 POP 流量）。"""
    if isinstance(error, Exception):
        raw_parts = []
        for arg in getattr(error, "args", []):
            if isinstance(arg, bytes):
                raw_parts.append(arg.decode("gbk", errors="ignore"))
                raw_parts.append(arg.decode("utf-8", errors="ignore"))
                raw_parts.append(repr(arg))
            else:
                raw_parts.append(str(arg))
        msg = (" ".join(raw_parts) + " " + str(error)).lower()
    else:
        msg = str(error).lower()

    keywords = [
        "登录太频繁",
        "too frequent",
        "frequency",
        "rate limit",
        "quota exceeded",
        "流量使用已超过上限",
        "exceeded limit",
    ]
    return any(kw in msg for kw in keywords)


def get_account_poll_interval(account, state: SyncState, default_poll_interval: int = 60) -> int:
    """计算账号的安全轮询间隔（秒）。

    - 若显式配置了 account.poll_interval，优先以配置值为准；
    - 若为 POP3 协议（显式 pop3 或安全 fallback pinned 到 pop3）：
      默认 600 秒（10 分钟），严格满足网易等服务商 >= 5 分钟的频控与流量保护要求；
    - 若为其他无 IDLE 能力的轮询账号（如网易 163 IMAP 轮询、Graph 轮询）：
      默认 300 秒（5 分钟）；
    - 其他普通账号：沿用 default_poll_interval（默认 60s）。
    """
    if getattr(account, "poll_interval", None) is not None and account.poll_interval > 0:
        return account.poll_interval
    if getattr(account, "protocol", "auto") == "pop3" or state.is_fallback_pinned(account.id):
        if (getattr(account, "source", "") in ("imap_gmail", "imap_qq", "imap_outlook")
                or str(getattr(account, "host", "")).lower() in OVERSEAS_IMAP_HOSTS):
            return max(default_poll_interval, 60)
        return 600
    if (getattr(account, "source", "") in ("graph_outlook", "imap_163")
            or str(getattr(account, "host", "")).lower() in ("imap.163.com", "imap.126.com")):
        return 300
    return max(default_poll_interval, 60)


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
            if is_rate_limit_error(e):
                log.warning("sync %s rate limited by server: %s (backing off 1800s)", account.id, e)
                state.record_rate_limit_backoff(account.id, backoff_sec=1800)
            else:
                log.error("sync %s failed: %s", account.id, e)
                state.record_failure(account.id)
            if is_user:
                report_sync_status(config.worker_base_url, config.admin_token, account.id, str(e))
            time.sleep(min(1 + random.random(), 3))
    return results


_ACCOUNT_LAST_POLL: dict[str, float] = {}


def _poll_pass(config, state, now: float | None = None) -> None:
    """一轮增量拉取：维持 IDLE 线程，并按各账号独立周期同步未被 IDLE 托管的账号。"""
    now_ts = now if now is not None else time.monotonic()
    accounts, user_account_ids = get_merged_accounts(config, state)

    # 1. 保证 IMAP 账号的 IDLE 监听线程就绪（秒级实时推送）
    ensure_idle_workers(config, state, accounts)

    # 2. 清理已移除账号的上次调度时间
    current_ids = {a.id for a in accounts}
    for aid in list(_ACCOUNT_LAST_POLL.keys()):
        if aid not in current_ids:
            _ACCOUNT_LAST_POLL.pop(aid, None)

    # 3. 对非纯 IMAP 或未被 IDLE 托管的账号（如 POP3 163 / graph 等）按独立周期执行轮询
    for account in accounts:
        # 若已有存活的 IDLE worker 正在托管该账号，无需在主循环频繁重复同步，
        # IDLE 线程自会处理实时事件及保底刷新；
        from .idle_worker import _active_idle_workers
        is_idle_active = (
            account.id in _active_idle_workers
            and _active_idle_workers[account.id].is_alive()
            and not _active_idle_workers[account.id].is_stopped()
        )

        if is_idle_active:
            # IDLE 线程正在全实时监听，跳过主线程重复轮询
            _ACCOUNT_LAST_POLL.pop(account.id, None)
            continue

        interval = get_account_poll_interval(account, state)
        last_at = _ACCOUNT_LAST_POLL.get(account.id)
        if last_at is not None and (now_ts - last_at) < interval:
            # 尚未到达该账号的安全轮询周期，跳过
            continue

        is_user = account.id in user_account_ids
        if state.should_skip_account(account.id):
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
            _ACCOUNT_LAST_POLL[account.id] = now_ts
        except Exception as e:
            if is_rate_limit_error(e):
                log.warning("poll sync %s rate limited by server: %s (backing off 1800s)", account.id, e)
                state.record_rate_limit_backoff(account.id, backoff_sec=1800)
            else:
                log.warning("poll sync %s error: %s", account.id, e)
                state.record_failure(account.id)
            _ACCOUNT_LAST_POLL[account.id] = now_ts
            if is_user:
                report_sync_status(config.worker_base_url, config.admin_token, account.id, str(e))


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
       （按各账号独立周期兜底 POP3 / 163 IMAP / graph / 新增用户账号，防频繁频控与流量超限），
       其余 tick 排空 provider mutation 队列（已读 / 星标 / 移动回写）。

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
                _poll_pass(config, state, now=tick_started)
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
