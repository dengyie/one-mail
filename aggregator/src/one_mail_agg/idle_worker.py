import logging
import threading
import time
from typing import Any, Callable

from imapclient import IMAPClient

from .config import Config, AccountConfig
from .state import SyncState
from .sync import sync_imap, default_client_factory
from .oauth import oauth_client_factory, normalize_provider
from .remote_accounts import report_sync_status

log = logging.getLogger("one-mail-agg")

_IDLE_FAILURE_THRESHOLD = 5
_IDLE_RETRY_COOLDOWN_SECONDS = 60

_active_idle_workers: dict[str, "ImapIdleWorker"] = {}
_idle_unsupported: dict[str, tuple] = {}
_idle_retry_after: dict[str, tuple[tuple, float]] = {}
_lock = threading.Lock()


def _idle_fingerprint(acc: AccountConfig) -> tuple:
    return (
        str(acc.host or "").strip().lower(),
        int(acc.port),
        bool(acc.use_ssl),
        str(acc.username or "").strip().lower(),
    )


def _mark_idle_unsupported(acc: AccountConfig) -> None:
    with _lock:
        _idle_unsupported[acc.id] = _idle_fingerprint(acc)
        _idle_retry_after.pop(acc.id, None)


def _mark_idle_cooldown(acc: AccountConfig, seconds: int = _IDLE_RETRY_COOLDOWN_SECONDS) -> None:
    with _lock:
        _idle_retry_after[acc.id] = (
            _idle_fingerprint(acc),
            time.monotonic() + max(0, seconds),
        )


def _reconnect_backoff(consecutive_errors: int) -> int:
    return min(30, 2 ** min(max(1, consecutive_errors), 5))


def _enable_socket_keepalive(client: Any) -> None:
    """为 IMAPClient 底层 socket 开启 TCP keepalive，防云端/NAT 网关 60~120s 静默老化"""
    import socket
    sock = getattr(getattr(client, "_imap", None), "sock", None)
    if sock is None:
        return
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        if hasattr(socket, "TCP_KEEPIDLE"):
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 30)
        if hasattr(socket, "TCP_KEEPINTVL"):
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 10)
        if hasattr(socket, "TCP_KEEPCNT"):
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
        if hasattr(socket, "TCP_KEEPALIVE"):
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPALIVE, 30)
    except Exception as e:
        log.debug("Failed to set SO_KEEPALIVE on client socket: %s", e)


class ImapIdleWorker(threading.Thread):
    """One long-lived IDLE worker per IMAP account with polling fallback."""

    def __init__(
        self,
        config: Config,
        account: AccountConfig,
        state: SyncState,
        client_factory: Callable[[AccountConfig], IMAPClient] = default_client_factory,
        idle_refresh_seconds: int = 60,  # 60 秒主动唤醒重进 IDLE，防长连接静默断开与 NAT 老化
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

    def _report_status(self, error: Exception | str | None) -> None:
        """Mirror daemon polling status semantics without ever affecting mail sync."""
        if not self.account.user_managed:
            return
        text = str(error) if error is not None else None
        try:
            report_sync_status(
                self.config.worker_base_url,
                self.config.admin_token,
                self.account.id,
                text,
            )
        except Exception as status_error:  # defensive: telemetry must never kill IDLE
            log.warning("Account %s IDLE status report failed: %s",
                        self.account.id, status_error)

    def do_sync(self, client: IMAPClient) -> dict:
        with self._sync_lock:
            result = sync_imap(client, self.config, self.account, self.state)
            # Active IDLE accounts bypass the daemon polling success path. Keep
            # failure backoff and Worker last_sync_at/last_error semantics identical.
            self.state.record_success(self.account.id)
            self._report_status(None)
            return result

    def run(self):
        log.info("IMAP IDLE worker started for account %s (%s:%s)",
                 self.account.id, self.account.host, self.account.port)
        consecutive_errors = 0
        client: IMAPClient | None = None

        while not self.is_stopped():
            client = None
            try:
                client = self.client_factory(self.account)
                _enable_socket_keepalive(client)
                if not client.has_capability("IDLE"):
                    _mark_idle_unsupported(self.account)
                    log.warning("Account %s does not support IDLE; falling back to daemon polling",
                                self.account.id)
                    try:
                        client.logout()
                    except Exception:
                        pass
                    return

                log.info("Account %s connected for IDLE monitoring", self.account.id)
                try:
                    r = self.do_sync(client)
                    log.info("Account %s initial IDLE sync complete: synced=%d dropped=%d",
                             self.account.id, r.get("synced", 0), r.get("dropped", 0))
                except Exception as sync_err:
                    self._report_status(sync_err)
                    log.warning("Account %s initial IDLE sync warning: %s",
                                self.account.id, sync_err)

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

                    consecutive_errors = 0

            except Exception as e:
                self._report_status(e)
                consecutive_errors += 1
                backoff = _reconnect_backoff(consecutive_errors)
                if client is not None:
                    try:
                        client.logout()
                    except Exception:
                        pass

                if consecutive_errors >= _IDLE_FAILURE_THRESHOLD:
                    _mark_idle_cooldown(self.account)
                    log.warning(
                        "Account %s IDLE repeatedly unstable (%s); falling back to daemon polling "
                        "for %ds before retrying IDLE",
                        self.account.id, e, _IDLE_RETRY_COOLDOWN_SECONDS,
                    )
                    return

                log.warning("Account %s IDLE connection lost (%s), reconnecting in %ds...",
                            self.account.id, e, backoff)
                if self._stop_event.wait(backoff):
                    break

        if client is not None:
            try:
                client.logout()
            except Exception:
                pass
        log.info("IMAP IDLE worker stopped for account %s", self.account.id)


def _is_msa_like(acc: AccountConfig) -> bool:
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
    with _lock:
        current_ids = {a.id for a in accounts}

        for aid, worker in list(_active_idle_workers.items()):
            if aid not in current_ids or worker.is_stopped() or not worker.is_alive():
                worker.stop()
                _active_idle_workers.pop(aid, None)

        for registry in (_idle_unsupported, _idle_retry_after):
            for aid in list(registry):
                if aid not in current_ids:
                    registry.pop(aid, None)

        for acc in accounts:
            if acc.source == "graph_outlook" or acc.protocol == "pop3":
                continue
            # 自愈修复：若为 Gmail 且历史曾被误 pinned 到 POP3，立即解除 pin 恢复实时推送
            if acc.source == "imap_gmail" and state.is_fallback_pinned(acc.id):
                state.set_fallback_pinned(acc.id, False)
            if state.is_fallback_pinned(acc.id):
                continue

            fingerprint = _idle_fingerprint(acc)
            unsupported_fingerprint = _idle_unsupported.get(acc.id)
            if unsupported_fingerprint == fingerprint:
                continue
            if unsupported_fingerprint is not None:
                _idle_unsupported.pop(acc.id, None)

            cooldown = _idle_retry_after.get(acc.id)
            if cooldown is not None:
                cooldown_fingerprint, retry_at = cooldown
                if cooldown_fingerprint != fingerprint:
                    _idle_retry_after.pop(acc.id, None)
                elif time.monotonic() < retry_at:
                    continue
                else:
                    _idle_retry_after.pop(acc.id, None)

            if acc.id not in _active_idle_workers or not _active_idle_workers[acc.id].is_alive():
                worker = ImapIdleWorker(config, acc, state,
                                        client_factory=_resolve_client_factory(acc, config))
                worker.start()
                _active_idle_workers[acc.id] = worker
