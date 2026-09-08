import logging
import time
import threading
from typing import Callable, Any

from imapclient import IMAPClient
from imapclient.exceptions import IMAPClientError, IMAPClientAbortError

from .config import Config, AccountConfig
from .state import SyncState
from .sync import sync_imap, default_client_factory
from .oauth import oauth_client_factory, normalize_provider

log = logging.getLogger("one-mail-agg")

# 活跃长连接表：account_id -> ImapIdleWorker
_active_idle_workers: dict[str, "ImapIdleWorker"] = {}
_lock = threading.Lock()


class ImapIdleWorker(threading.Thread):
    """常驻后台线程：为一个 IMAP 账号保持长连接并挂起 IDLE，

    一旦收到服务端推来的 EXISTS / EXPUNGE 等邮件事件，立即触发同步。
    同时，每隔 idle_refresh_seconds（默认 10 分钟）主动刷新一次 IDLE（避免 NAT/防火墙超时），
    并作为保底轮询保证消息不被遗漏。
    """

    def __init__(
        self,
        config: Config,
        account: AccountConfig,
        state: SyncState,
        client_factory: Callable[[AccountConfig], IMAPClient] = default_client_factory,
        idle_refresh_seconds: int = 240,  # 4 分钟主动唤醒重进 IDLE，防长连接静默断开
    ):
        super().__init__(name=f"idle-{account.id}", daemon=True)
        self.config = config
        self.account = account
        self.state = state
        self.client_factory = client_factory
        self.idle_refresh_seconds = idle_refresh_seconds
        self._stop_event = threading.Event()
        self._sync_lock = threading.Lock()

    def stop(self):
        self._stop_event.set()

    def is_stopped(self) -> bool:
        return self._stop_event.is_set()

    def do_sync(self, client: IMAPClient) -> dict:
        with self._sync_lock:
            return sync_imap(client, self.config, self.account, self.state)

    def run(self):
        log.info("IMAP IDLE worker started for account %s (%s:%s)", self.account.id, self.account.host, self.account.port)
        consecutive_errors = 0

        while not self.is_stopped():
            client: IMAPClient | None = None
            try:
                # 建立连接
                client = self.client_factory(self.account)
                if not client.has_capability("IDLE"):
                    log.warning("Account %s does not support IDLE, worker terminating", self.account.id)
                    return

                # 连接成功，重置失败计数
                consecutive_errors = 0
                log.info("Account %s connected for IDLE monitoring", self.account.id)

                # 先执行一次全量增量检查
                try:
                    r = self.do_sync(client)
                    log.info("Account %s initial IDLE sync complete: synced=%d dropped=%d",
                             self.account.id, r.get("synced", 0), r.get("dropped", 0))
                except Exception as sync_err:
                    log.warning("Account %s initial IDLE sync warning: %s", self.account.id, sync_err)

                # 监控第一个有效 folder（通常是 INBOX，IDLE 协议单连接通常挂在一个 mailbox）
                folder = self.account.folders[0] if self.account.folders else "INBOX"

                while not self.is_stopped():
                    client.select_folder(folder, readonly=True)
                    client.idle()
                    # 阻塞监听事件，最长 idle_refresh_seconds 秒
                    # 期间若远端发来 EXISTS（新邮件），idle_check 立即返回
                    responses = client.idle_check(timeout=self.idle_refresh_seconds)
                    client.idle_done()

                    if self.is_stopped():
                        break

                    has_event = bool(responses)
                    if has_event:
                        log.info("Account %s received IDLE event from server: %s -> syncing immediately!",
                                 self.account.id, responses)

                    # 只要有事件，或者超时主动唤醒保底，都跑一次 sync
                    try:
                        res = self.do_sync(client)
                        if has_event or res.get("synced", 0) > 0:
                            log.info("Account %s instant sync done: synced=%d dropped=%d",
                                     self.account.id, res.get("synced", 0), res.get("dropped", 0))
                    except Exception as loop_sync_err:
                        log.warning("Account %s loop sync error: %s", self.account.id, loop_sync_err)
                        # 抛出以重连
                        raise

            except Exception as e:
                consecutive_errors += 1
                backoff = min(30, 2 ** min(consecutive_errors, 5))
                log.warning("Account %s IDLE connection lost (%s), reconnecting in %ds...",
                            self.account.id, e, backoff)
                if client is not None:
                    try:
                        client.logout()
                    except Exception:
                        pass
                # 退避等待重连或退出
                if self._stop_event.wait(backoff):
                    break

        if client is not None:
            try:
                client.logout()
            except Exception:
                pass
        log.info("IMAP IDLE worker stopped for account %s", self.account.id)


def _is_msa_like(acc: AccountConfig) -> bool:
    """判断是否为个人 Hotmail/Outlook（MSA）账号：host 落在 major outlook host 或
    source 为 imap_outlook、且配置了 oauth。MSA 账号一旦 token 工厂解析失败，几乎
    可以确定是当前 token 已吊销/无效，后端 basic auth 对微软个人号必败。"""
    if acc.oauth is None:
        return False
    host = (acc.host or "").strip().lower()
    outlook_hosts = {
        "outlook.office365.com", "outlook.office.com", "imap-mail.outlook.com",
        "outlook.nohav.net",
    }
    if host in outlook_hosts:
        return True
    provider = None
    try:
        provider = normalize_provider((acc.oauth.get("provider") if isinstance(acc.oauth, dict) else None))
    except AttributeError:
        return False
    return provider == "msa"


def _resolve_client_factory(acc: AccountConfig):
    """OAuth 账号走 oauth_client_factory（XOAUTH2/用户 token），否则默认基础登录。

    未知/畸形 provider 不在此处抛异常（与 sync 路径一致：账号级隔离，不拖垮整轮）。
    MSA（Hotmail/Outlook 个人号）账号若 token 工厂无法解析 = 当前 token 基本确定吊销，
    给出明确的「需重新授权」告警；对非 MSA 账号仍回退基础登录（qq/163 行为不变）。
    """
    if acc.oauth is not None:
        try:
            return oauth_client_factory(acc)
        except (KeyError, AttributeError, TypeError) as e:
            if _is_msa_like(acc):
                log.error(
                    "entry %s: MSA (Hotmail/Outlook) oauth factory failed (%s) — refresh_token "
                    "过期/吊销或 provider 误配，该账号已无法以基础认证登录（微软已禁用），"
                    "需要重新授权拿到新 token 才能恢复 IDLE。",
                    acc.id, e,
                )
            else:
                log.error("entry %s: unsupported oauth provider for IDLE, falling back to basic login", acc.id)
    return default_client_factory


def ensure_idle_workers(config: Config, state: SyncState, accounts: list[AccountConfig]) -> None:
    """保证所有支持且配置为 IMAP 协议的账号都有常驻 IDLE 线程在监听。

    非 auto 或纯 POP3 账号不启动 IDLE。OAuth 账号（含 Hotmail/Outlook 个人号）
    使用对应 OAuth 工厂以支持 XOAUTH2 认证。
    """
    with _lock:
        current_ids = {a.id for a in accounts}
        # 停掉已删除的账号
        for aid, worker in list(_active_idle_workers.items()):
            if aid not in current_ids or worker.is_stopped() or not worker.is_alive():
                worker.stop()
                _active_idle_workers.pop(aid, None)

        # 启动新账号的 IDLE
        for acc in accounts:
            # 协议必须不是纯 pop3，且若在 state 中已知 fallback 到 pop3 则跳过
            if acc.protocol == "pop3":
                continue
            if state.is_fallback_pinned(acc.id):
                continue

            if acc.id not in _active_idle_workers or not _active_idle_workers[acc.id].is_alive():
                worker = ImapIdleWorker(config, acc, state, client_factory=_resolve_client_factory(acc))
                worker.start()
                _active_idle_workers[acc.id] = worker
