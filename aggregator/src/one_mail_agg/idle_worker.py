import logging
import threading
from typing import Callable

from imapclient import IMAPClient

from .config import Config, AccountConfig
from .state import SyncState
from .sync import sync_imap, default_client_factory
from .oauth import oauth_client_factory, normalize_provider

log = logging.getLogger("one-mail-agg")

# 活跃长连接表：account_id -> ImapIdleWorker
_active_idle_workers: dict[str, "ImapIdleWorker"] = {}
# 服务端明确不支持 IDLE 时，记住当前连接配置并交回 daemon 轮询；只有配置变化才重试。
_idle_unsupported: dict[str, tuple] = {}
_lock = threading.Lock()


def _idle_fingerprint(acc: AccountConfig) -> tuple:
    """决定一个 IDLE capability 结论是否仍适用于当前账号配置。"""
    return (
        str(acc.host or "").strip().lower(),
        int(acc.port),
        bool(acc.use_ssl),
        str(acc.username or "").strip().lower(),
    )


def _mark_idle_unsupported(acc: AccountConfig) -> None:
    with _lock:
        _idle_unsupported[acc.id] = _idle_fingerprint(acc)


def _reconnect_backoff(consecutive_errors: int) -> int:
    """快速失败时指数退避，最高 30 秒。"""
    return min(30, 2 ** min(max(1, consecutive_errors), 5))


class ImapIdleWorker(threading.Thread):
    """常驻后台线程：为一个 IMAP 账号保持长连接并挂起 IDLE。

    收到服务端事件后立即同步；每 4 分钟主动退出 IDLE 做一次保底增量检查。
    连接异常自动重连。服务端明确不支持 IDLE 时退出线程，由 daemon 的常规轮询兜底。
    """

    def __init__(
        self,
        config: Config,
        account: AccountConfig,
        state: SyncState,
        client_factory: Callable[[AccountConfig], IMAPClient] = default_client_factory,
        idle_refresh_seconds: int = 240,
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
        client: IMAPClient | None = None

        while not self.is_stopped():
            client = None
            try:
                client = self.client_factory(self.account)
                if not client.has_capability("IDLE"):
                    _mark_idle_unsupported(self.account)
                    log.warning(
                        "Account %s does not support IDLE; falling back to daemon polling",
                        self.account.id,
                    )
                    try:
                        client.logout()
                    except Exception:
                        pass
                    return

                # 注意：仅仅 TCP/auth 建连成功不代表 IDLE 稳定，不能在这里清零错误计数。
                # 否则“每次都能连上但一进 IDLE 就断”的服务端会永久以 2 秒频率重连。
                log.info("Account %s connected for IDLE monitoring", self.account.id)

                try:
                    r = self.do_sync(client)
                    log.info("Account %s initial IDLE sync complete: synced=%d dropped=%d",
                             self.account.id, r.get("synced", 0), r.get("dropped", 0))
                except Exception as sync_err:
                    log.warning("Account %s initial IDLE sync warning: %s", self.account.id, sync_err)

                folder = self.account.folders[0] if self.account.folders else "INBOX"

                while not self.is_stopped():
                    client.select_folder(folder, readonly=True)
                    client.idle()
                    responses = client.idle_check(timeout=self.idle_refresh_seconds)
                    client.idle_done()

                    if self.is_stopped():
                        break

                    has_event = bool(responses)
                    if has_event:
                        log.info("Account %s received IDLE event from server: %s -> syncing immediately!",
                                 self.account.id, responses)

                    try:
                        res = self.do_sync(client)
                        if has_event or res.get("synced", 0) > 0:
                            log.info("Account %s instant sync done: synced=%d dropped=%d",
                                     self.account.id, res.get("synced", 0), res.get("dropped", 0))
                    except Exception as loop_sync_err:
                        log.warning("Account %s loop sync error: %s", self.account.id, loop_sync_err)
                        raise

                    # 一次完整的 select -> IDLE -> sync 成功，才认为连接稳定并重置退避。
                    consecutive_errors = 0

            except Exception as e:
                consecutive_errors += 1
                backoff = _reconnect_backoff(consecutive_errors)
                log.warning("Account %s IDLE connection lost (%s), reconnecting in %ds...",
                            self.account.id, e, backoff)
                if client is not None:
                    try:
                        client.logout()
                    except Exception:
                        pass
                if self._stop_event.wait(backoff):
                    break

        if client is not None:
            try:
                client.logout()
            except Exception:
                pass
        log.info("IMAP IDLE worker stopped for account %s", self.account.id)


def _is_msa_like(acc: AccountConfig) -> bool:
    """判断是否为个人 Hotmail/Outlook（MSA）账号。"""
    if acc.oauth is None:
        return False
    host = (acc.host or "").strip().lower()
    outlook_hosts = {
        "outlook.office365.com", "outlook.office.com", "imap-mail.outlook.com",
        "outlook.nohav.net",
    }
    if host in outlook_hosts:
        return True
    try:
        provider = normalize_provider((acc.oauth.get("provider") if isinstance(acc.oauth, dict) else None))
    except AttributeError:
        return False
    return provider == "msa"


def _resolve_client_factory(acc: AccountConfig, config: Config | None = None):
    """OAuth 账号走 XOAUTH2 工厂，否则默认基础登录。"""
    if acc.oauth is not None:
        try:
            return oauth_client_factory(acc, config)
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
    """为可用 IMAP 账号维持 IDLE worker；不支持 IDLE 的账号交给 daemon 轮询。"""
    with _lock:
        current_ids = {a.id for a in accounts}

        for aid, worker in list(_active_idle_workers.items()):
            if aid not in current_ids or worker.is_stopped() or not worker.is_alive():
                worker.stop()
                _active_idle_workers.pop(aid, None)

        # 删除已移除账号的 capability 记忆，避免 registry 长期增长。
        for aid in list(_idle_unsupported):
            if aid not in current_ids:
                _idle_unsupported.pop(aid, None)

        for acc in accounts:
            if acc.source == "graph_outlook":
                continue
            if acc.protocol == "pop3":
                continue
            if state.is_fallback_pinned(acc.id):
                continue

            fingerprint = _idle_fingerprint(acc)
            unsupported_fingerprint = _idle_unsupported.get(acc.id)
            if unsupported_fingerprint == fingerprint:
                # 无常驻 worker -> main daemon 会按 poll_interval（默认 60s）同步。
                continue
            if unsupported_fingerprint is not None:
                # host/port/SSL/username 改过，允许重新探测 IDLE capability。
                _idle_unsupported.pop(acc.id, None)

            if acc.id not in _active_idle_workers or not _active_idle_workers[acc.id].is_alive():
                worker = ImapIdleWorker(config, acc, state, client_factory=_resolve_client_factory(acc, config))
                worker.start()
                _active_idle_workers[acc.id] = worker
