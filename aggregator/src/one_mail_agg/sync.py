import logging

from imapclient import IMAPClient
from imapclient.exceptions import IMAPClientError

from .config import Config, AccountConfig
from .state import SyncState
from .imap_base import fetch_new_messages
from .normalize import normalize_message
from .uploader import upload_emails
from .pop3_source import connect_pop3, fetch_new_pop3_messages, uidl_to_key

log = logging.getLogger("one-mail-agg")


def default_client_factory(account: AccountConfig) -> IMAPClient:
    c = IMAPClient(account.host, port=account.port, ssl=account.use_ssl)
    c.login(account.username, account.password)
    return c


def sync_imap(client, config: Config, account: AccountConfig, state: SyncState) -> int:
    """IMAP 增量同步一整个账号（全部 folders），返回同步邮件数。"""
    total = 0
    for folder in account.folders:
        sel = client.select_folder(folder, readonly=True)
        uidvalidity = int(sel[b"UIDVALIDITY"])
        msgs = fetch_new_messages(client, account, folder, state)
        if not msgs:
            continue
        # 逐封归一化，单封畸形绝不卡死整批（C3 hardening）：
        # normalize_message 对坏附件/坏头仍可能抛错，原先整批 list comprehension
        # 会让整体在 set_last_uid 之前崩掉——水印不推进，账号反复卡在同一窗口
        # （C3 死锁症状）。这里 try/except 跳过坏单封，其余照常上传。
        batch = []
        for m in msgs:
            try:
                batch.append(normalize_message(
                    m.raw_bytes, account, folder, uidvalidity,
                    m.uid, m.internal_date_ms))
            except Exception as e:
                log.warning("skip imap message uid=%s folder=%s account=%s: %r",
                            m.uid, folder, account.id, e)
        if batch:
            upload_emails(config, batch)
            total += len(batch)
        # 水印始终推进到本窗口最大 uid（含被跳过的畸形单封）——即便整个窗口
        # 都是坏件也要推进，否则账号每轮都重拉同一个坏窗口（与 MAX_SINGLE_BYTES
        # 推水印语义一致）。被跳过的 uid 就此放弃，仅以 warning 日志留痕（与
        # MAX_SINGLE_BYTES 主动跳过的取舍口径一致；真要 100% 留到底只能人工从
        # 日志捞出来单测复现）。若 upload 失败，上面的 upload_emails 已抛错，
        # 此处不执行，水印留在本窗口最大 uid 之下，下一轮续传。
        state.set_last_uid(account.id, folder, max(m.uid for m in msgs))
    return total


def sync_pop3(account: AccountConfig, config: Config, state: SyncState) -> int:
    """POP3 降级同步：只在逻辑收件箱 INBOX 上读取。

    POP3 没有 IMAP 的复杂文件夹结构，配置里除 INBOX 外的 folder 直接忽略。
    水印用 UIDL 集合推进；upload 成功后批量标记 seen。
    """
    if "INBOX" not in account.folders:
        return 0
    conn = connect_pop3(account)
    try:
        msgs = fetch_new_pop3_messages(conn, account, "INBOX", state)
        if not msgs:
            return 0
        # 逐封归一化，单封畸形绝不卡死整批（C3 hardening）：
        # 归一化失败的 UIDL 跳过上传、**不标记 seen**，下一轮 fetch 会重试；
        # 成功归一化的照常批量 mark seen。POP3 的 watermark 就是 seen 集合，
        # 所以跳过的 UIDL 不得标记，留给下一轮（IMAP 多 folder 窗口可以推进
        # last_uid 放弃，POP3 没有对称概念）。
        batch, uploaded_uidls = [], []
        for m in msgs:
            try:
                batch.append(normalize_message(
                    m.raw_bytes, account, "INBOX", uidvalidity=0, uid=0,
                    internal_date_ms=m.internal_date_ms,
                    imap_uid_override=uidl_to_key(account, "INBOX", m.uidl)))
                uploaded_uidls.append(m.uidl)
            except Exception as e:
                log.warning("skip pop3 message uidl=%s account=%s: %r",
                            m.uidl, account.id, e)
        if not batch:
            return 0
        result = upload_emails(config, batch)
        inserted = result.get("inserted", len(batch))
        # 上传成功（200）后批量 seen——只标记**成功上传的这批**（已归一化的），
        # 被跳过的坏 UIDL 不在此列。如果上传失败会抛出，此处不执行，留到下一轮。
        state.add_pop3_seen_many(account.id, "INBOX", uploaded_uidls)
        return inserted
    finally:
        try:
            conn.quit()
        except Exception:
            pass


def sync_account(client_factory, config: Config, account: AccountConfig, state: SyncState) -> dict:
    """协议编排入口：按 account.protocol 选择，IMAP 失败时 auto 降级 POP3。

    - `pop3`：直接 POP3。
    - `imap`：只 IMAP，失败即抛错（显式 imap 禁止降级）。
    - `auto`：先 IMAP；若 IMAP 在连接/选择/读取阶段抛 `IMAPClientError`
      （如 163 的 `EXAMINE Unsafe Login`），且账号无 OAuth，则自动降级到 POP3。
      一旦降级，账号被"钉住"在 POP3（`state.fallback`），不再回头重试 IMAP——
      防止 IMAP 抖动时同一账号出现 imap:/pop3: 两套 imap_uid 键的重复行。

    返回 `{"synced": N, "protocol": "imap"|"pop3"}`。
    """
    if account.protocol == "pop3":
        return {"synced": sync_pop3(account, config, state), "protocol": "pop3"}

    # 已被钉住到 POP3 的账号直接走 POP3（不重试 IMAP）
    if state.is_fallback_pinned(account.id):
        return {"synced": sync_pop3(account, config, state), "protocol": "pop3"}

    client = None
    try:
        client = client_factory(account)
    except Exception:
        # 连接 / 登录阶段（factory 内部）同样允许降级
        if account.protocol == "auto" and not account.oauth:
            return _fallback_to_pop3(config, account, state)
        raise

    try:
        total = sync_imap(client, config, account, state)
        return {"synced": total, "protocol": "imap"}
    except IMAPClientError:
        if account.protocol == "auto" and not account.oauth:
            return _fallback_to_pop3(config, account, state)
        raise
    finally:
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass


def _fallback_to_pop3(config: Config, account: AccountConfig, state: SyncState) -> dict:
    """IMAP 失败后降级到 POP3。

    - POP3 同步成功后才钉住（`state.fallback`），永久不再重试 IMAP：避免 IMAP
      抖动时同一账号出现 imap:/pop3: 两套 imap_uid 键的重复行。
    - 若 POP3 本身也失败，则抛错、不钉住——保留 IMAP 在下轮仍可用的机会，避免
      「IMAP 短暂抖动 + POP3 也挂」把账号永久锁死在 POP3。
    - 边界：若本 run 内 IMAP 已成功 upload 部分 folder 后才失败，POP3 全量重抓
      INBOX 会与 imap: 键重复（unique index 拦不住跨命名空间）。163 的首个
      SELECT 即挂（零 IMAP upload），现实中快速收敛；多 folder 混合场景的跨协议
      去重留待后续（见 CHANGELOG 注释）。
    """
    n = sync_pop3(account, config, state)
    state.set_fallback_pinned(account.id, True)
    log.info("account=%s pinned to POP3 after IMAP failure (synced=%d)", account.id, n)
    return {"synced": n, "protocol": "pop3"}