import logging

from imapclient import IMAPClient
from imapclient.exceptions import IMAPClientAbortError, IMAPClientError

from .config import Config, AccountConfig
from .state import SyncState
from .imap_base import fetch_new_messages
from .normalize import normalize_message
from .uploader import upload_emails
from .pop3_source import connect_pop3, fetch_new_pop3_messages, uidl_to_key
from .proxy_client import ProxiedIMAPClient, create_imap_client, _maybe_send_id
from .folder_catalog import maybe_sync_imap_folder_catalog

log = logging.getLogger("one-mail-agg")


def _imap_fallback_allowed(error: Exception) -> bool:
    """Only transport aborts / known Unsafe Login policy failures may fall back."""
    return (isinstance(error, (IMAPClientAbortError, OSError)) or
            (isinstance(error, IMAPClientError) and "unsafe login" in str(error).lower()))


def _only_inbox(account: AccountConfig) -> bool:
    folders = [str(folder).strip().upper() for folder in account.folders]
    return folders == ["INBOX"]


def _safe_auto_pop3_fallback(account: AccountConfig, state: SyncState,
                             error: Exception) -> bool:
    """POP3 auto fallback is safe only before this account ever entered IMAP.

    IMAP and POP3 deliberately use different source-key namespaces. Once a SELECT
    has succeeded, UIDVALIDITY is durable evidence that this account belongs to the
    IMAP namespace. Switching later would allow the same INBOX message to be inserted
    again under a POP3 UIDL key. Multi-folder accounts are also never auto-fallen back
    because POP3 cannot preserve their folder semantics.
    """
    return (
        account.protocol == "auto"
        and account.oauth is None
        and _only_inbox(account)
        and not state.has_imap_history(account.id)
        and _imap_fallback_allowed(error)
    )


def default_client_factory(account: AccountConfig) -> IMAPClient:
    c = create_imap_client(
        account,
        timeout=30,
        direct_client_cls=IMAPClient,
        proxied_client_cls=ProxiedIMAPClient,
    )
    c.login(account.username, account.password)
    _maybe_send_id(c, account)
    return c


def _account_result(synced: int, dropped: int, protocol: str,
                    *, dropped_folders: list[str] | None = None,
                    warning: str | None = None) -> dict:
    result = {"synced": synced, "dropped": dropped, "protocol": protocol}
    if dropped_folders:
        result["dropped_folders"] = list(dropped_folders)
    if warning:
        result["warning"] = warning
    return result


def sync_imap(client, config: Config, account: AccountConfig, state: SyncState) -> dict:
    total = 0
    dropped = 0
    catalog_attempted = False
    for folder in account.folders:
        sel = client.select_folder(folder, readonly=True)
        uidvalidity = int(sel[b"UIDVALIDITY"])
        if not catalog_attempted:
            maybe_sync_imap_folder_catalog(client, config, account)
            catalog_attempted = True
        oversize = []
        msgs = fetch_new_messages(client, account, folder, state, oversize=oversize)
        dropped += len(oversize)
        if not msgs:
            continue
        batch = []
        for m in msgs:
            try:
                batch.append(normalize_message(
                    m.raw_bytes, account, folder, uidvalidity,
                    m.uid, m.internal_date_ms))
            except Exception as e:
                dropped += 1
                log.warning("skip imap message uid=%s folder=%s account=%s: %r",
                            m.uid, folder, account.id, e)
        if batch:
            upload_emails(config, batch)
            total += len(batch)
        # upload 成功后才推进；set_last_uid_max 同时保留 fetch 层已推进的已知超限 UID。
        state.set_last_uid_max(account.id, folder, max(m.uid for m in msgs))
    return _account_result(total, dropped, "imap")


def sync_pop3(account: AccountConfig, config: Config, state: SyncState) -> dict:
    non_inbox = [folder for folder in account.folders if str(folder).strip().upper() != "INBOX"]
    if non_inbox:
        log.warning("pop3 account=%s cannot sync non-INBOX folders; dropped=%d: %s",
                    account.id, len(non_inbox), ", ".join(non_inbox))
    if not any(str(folder).strip().upper() == "INBOX" for folder in account.folders):
        raise ValueError(
            f"pop3 {account.id}: folders must include INBOX; POP3 cannot sync non-INBOX folders")
    conn = connect_pop3(account)
    try:
        oversize: list[str] = []
        msgs = fetch_new_pop3_messages(conn, account, "INBOX", state, oversize=oversize)
        if not msgs:
            warning = ("POP3 only supports INBOX; non-INBOX folders were dropped: "
                       + ", ".join(non_inbox)) if non_inbox else None
            return _account_result(0, len(oversize) + len(non_inbox), "pop3",
                                   dropped_folders=non_inbox, warning=warning)
        batch, uploaded_uidls = [], []
        dropped = len(oversize) + len(non_inbox)
        for m in msgs:
            try:
                batch.append(normalize_message(
                    m.raw_bytes, account, "INBOX", uidvalidity=0, uid=0,
                    internal_date_ms=m.internal_date_ms,
                    imap_uid_override=uidl_to_key(account, "INBOX", m.uidl)))
                uploaded_uidls.append(m.uidl)
            except Exception as e:
                dropped += 1
                log.warning("skip pop3 message uidl=%s account=%s: %r",
                            m.uidl, account.id, e)
        if not batch:
            raise RuntimeError(
                f"pop3 {account.id}: all {len(msgs)} pending messages failed to normalize "
                f"(dropped={dropped}), nothing uploaded and nothing marked seen")
        result = upload_emails(config, batch)
        inserted = result.get("inserted", len(batch))
        state.add_pop3_seen_many(account.id, "INBOX", uploaded_uidls)
        warning = ("POP3 only supports INBOX; non-INBOX folders were dropped: "
                   + ", ".join(non_inbox)) if non_inbox else None
        return _account_result(inserted, dropped, "pop3",
                               dropped_folders=non_inbox, warning=warning)
    finally:
        try:
            conn.quit()
        except Exception:
            pass


def sync_account(client_factory, config: Config, account: AccountConfig, state: SyncState) -> dict:
    """按协议同步；auto 只允许首次、INBOX-only 账号安全降级到 POP3。"""
    if account.protocol == "pop3":
        return sync_pop3(account, config, state)

    if state.is_fallback_pinned(account.id):
        # Pin 只属于 auto + 单 INBOX 配置。用户显式切回 IMAP，或后来增加了
        # 文件夹，都必须解除旧 pin，而不是被历史状态永久劫持到 POP3。
        if account.protocol == "auto" and _only_inbox(account):
            return sync_pop3(account, config, state)
        state.set_fallback_pinned(account.id, False)

    client = None
    try:
        client = client_factory(account)
    except (IMAPClientError, OSError) as error:
        if _safe_auto_pop3_fallback(account, state, error):
            return _fallback_to_pop3(config, account, state, error=error)
        raise

    try:
        return sync_imap(client, config, account, state)
    except (IMAPClientError, OSError) as error:
        if _safe_auto_pop3_fallback(account, state, error):
            return _fallback_to_pop3(config, account, state, error=error)
        raise
    finally:
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass


def _fallback_to_pop3(config: Config, account: AccountConfig, state: SyncState,
                       *, error: Exception | None = None) -> dict:
    """执行已经判定安全的首次 POP3 fallback，并永久 pin 到 POP3。"""
    if not _only_inbox(account) or state.has_imap_history(account.id):
        if error is not None:
            raise error
        raise RuntimeError(f"unsafe POP3 fallback rejected for account {account.id}")

    res = sync_pop3(account, config, state)
    state.set_fallback_pinned(account.id, True)
    log.info("account=%s pinned to POP3 after first-use IMAP failure (synced=%d, dropped=%d)",
             account.id, res["synced"], res["dropped"])
    return res
