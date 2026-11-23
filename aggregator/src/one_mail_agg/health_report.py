"""聚合器账号健康快照与 daemon 心跳上报。

现状缺口（2026-11 QQ 断信 6 天无人发现 + 海外账号隧道断全静默的事故复盘）：

- 静态 config.json 账号（qq-main / mail163-main）没有 user_mail_accounts 行，
  既有的 report_sync_status 回写 404 静默丢弃，状态页完全看不到它们；
- 熔断（skip_until）、IDLE 线程存活、SOCKS5 出口、daemon 心跳只存在于
  进程内存，出问题只能 SSH 翻日志。

本模块每轮 daemon 轮询末尾把两类信息一次性 POST 到 Worker
``POST /admin/account_health``（x-admin-auth）：per-account 健康快照 +
单行 daemon 心跳（含 SOCKS 出口）。上报由「状态变化或 15 分钟心跳到期」
驱动（对齐 idle_worker._report_status 的 D1 写配额防抖），失败仅记日志，
绝不影响收信主流程。
"""
import logging
import time

import requests

from .config import AccountConfig, Config
from .state import SyncState
from .transport_retry import call_with_transport_retry

log = logging.getLogger("one-mail-agg")

# 状态无变化时的最低上报频率（秒）：让 Worker 侧 updated_at 保持新鲜，
# 也作为 daemon 存活心跳。与 idle_worker._D1_STATUS_HEARTBEAT_SECONDS 对齐。
HEARTBEAT_INTERVAL_SECONDS = 900.0

AGGREGATOR_VERSION = "0.1.0"

# 模块级上报节流状态：{fingerprint, last_reported_at}。daemon 单线程主循环
# 调用，无并发问题；run_once 路径每进程只跑一轮，直接上报。
_throttle: dict = {"fingerprint": None, "last_reported_at": 0.0}

# 进程启动时间：daemon 心跳里暴露，便于区分「刚重启」与「长期运行」。
_PROCESS_STARTED_AT = time.time()


def classify_error(error: Exception | str | None) -> str:
    """把同步失败异常归入稳定错误类别（状态页据此显示中文标签）。

    分类语义对齐 main.py / idle_worker.py 的既有日志分支：
    quota（D1 配额）、ratelimit（163 频控）、proxy（SOCKS5 隧道）、
    auth（登录失败）、policy（网络策略拒绝）、persist（refresh_token 落盘）、
    conn（其余连接类）、unknown（兜底）。
    """
    if error is None:
        return ""
    from .uploader import quota_retry_at
    from .main import is_rate_limit_error

    if isinstance(error, Exception) and quota_retry_at(error):
        return "quota"
    if isinstance(error, str):
        text = error.lower()
        if "network policy" in text or "rejected by network policy" in text:
            return "policy"
        if "authenticationfailed" in text or "login fail" in text or "password" in text:
            return "auth"
        if "connection refused" in text or "socks5" in text or "tunnel" in text:
            return "proxy"
        if "timeout" in text or "connection" in text or "broken pipe" in text:
            return "conn"
        return "unknown"
    if isinstance(error, Exception):
        if is_rate_limit_error(error):
            return "ratelimit"
        name = type(error).__name__.lower()
        text = str(error).lower()
        if "authenticationfailed" in text or "login fail" in text:
            return "auth"
        if isinstance(error, ConnectionRefusedError) or "connection refused" in text:
            return "proxy"
        if isinstance(error, PermissionError) or "network policy" in text:
            return "policy"
        if "refresh_token" in text or "tokenpersist" in name:
            return "persist"
        if "timeout" in text or "timed out" in text or "connection" in text or "broken pipe" in text:
            return "conn"
    return "unknown"


def build_account_health_snapshot(config: Config, state: SyncState,
                                  accounts: list[AccountConfig],
                                  user_account_ids: set[str]) -> dict:
    """汇总所有账号的当前健康快照（聚合器侧唯一真值来源）。

    数据源全部来自既有状态积木：SyncState（fail_count/skip_until/fallback）、
    idle_worker 注册表（IDLE 存活/冷却）、main._ACCOUNT_LAST_POLL（轮询计划）。
    """
    from .idle_worker import is_idle_worker_active, _idle_unsupported
    from .main import _ACCOUNT_LAST_POLL, get_account_poll_interval
    from .proxy_client import get_socks5_proxy

    now = time.time()
    items = []
    for account in accounts:
        fail_count, skip_until_ts = state.get_fail_state(account.id)
        idle_alive = is_idle_worker_active(account.id)
        item = {
            "account_id": account.id,
            "label": account.id if account.id in user_account_ids else None,
            "source": account.source,
            "username": account.username,
            "user_managed": account.id in user_account_ids,
            "error_kind": "",
            "last_error": None,
            "fail_count": fail_count,
            "skip_until": int(skip_until_ts * 1000) if skip_until_ts > now else 0,
            "idle_alive": bool(idle_alive),
            "poll_interval_seconds": get_account_poll_interval(account, state),
            "last_sync_at": None,
        }
        items.append(item)

    proxy_host, proxy_port = get_socks5_proxy()
    return {
        "daemon": {
            "started_at": int(_PROCESS_STARTED_AT * 1000),
            "accounts_count": len(items),
            "socks5_egress": f"{proxy_host}:{proxy_port}",
            "aggregator_version": AGGREGATOR_VERSION,
        },
        "accounts": items,
    }


def _snapshot_fingerprint(payload: dict) -> tuple:
    """提取决定「是否需要上报」的稳定指纹（不含时间戳类易变字段）。"""
    daemon = payload["daemon"]
    daemon_fp = (daemon["accounts_count"], daemon["socks5_egress"],
                 daemon["aggregator_version"])
    accounts_fp = tuple(
        (a["account_id"], a["last_error"], a["error_kind"], a["fail_count"],
         a["skip_until"], a["idle_alive"])
        for a in payload["accounts"]
    )
    return daemon_fp, accounts_fp


def report_account_health(config: Config, payload: dict, *,
                          force: bool = False) -> bool:
    """POST 健康快照到 Worker；状态无变化且心跳未到期时跳过。

    返回是否真的发了请求。失败仅 log.warning，绝不抛出——状态上报挂了
    不应影响邮件归集（对齐 report_sync_status 的容错契约）。
    """
    fingerprint = _snapshot_fingerprint(payload)
    now = time.monotonic()
    if (not force
            and fingerprint == _throttle["fingerprint"]
            and now - _throttle["last_reported_at"] < HEARTBEAT_INTERVAL_SECONDS):
        return False

    url = f"{config.worker_base_url}/admin/account_health"
    headers = {"x-admin-auth": config.admin_token}
    try:
        r = call_with_transport_retry(
            lambda: requests.post(url, json=payload, headers=headers, timeout=10))
        if r.status_code != 200:
            log.warning("report account health failed: HTTP %s %s",
                        r.status_code, r.text[:200])
            return False
        _throttle["fingerprint"] = fingerprint
        _throttle["last_reported_at"] = now
        return True
    except Exception as e:
        log.warning("report account health error: %s", e)
        return False


def report_account_health_with_state(config: Config, state: SyncState,
                                     accounts: list[AccountConfig],
                                     user_account_ids: set[str], *,
                                     force: bool = False) -> bool:
    """构建快照并按节流策略上报（daemon 主循环的挂载入口）。"""
    payload = build_account_health_snapshot(config, state, accounts, user_account_ids)
    return report_account_health(config, payload, force=force)
