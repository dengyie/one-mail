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
    # 30s socket 超时与 POP3 一致：界住单个挂死的 IMAP 账号，不让它吃满整轮
    # 240s 预算而饿死同轮其它账号（I3）。
    c = IMAPClient(account.host, port=account.port, ssl=account.use_ssl, timeout=30)
    c.login(account.username, account.password)
    return c


def _account_result(synced: int, dropped: int, protocol: str) -> dict:
    """统一构造 sync_account 的返回形态：

    `{"synced": N, "dropped": M, "protocol": ...}`——`dropped` 是本轮被
    跳过/放弃的邮件数（fetch 层超大超限 + sync 层归一化失败），把隐式的
    per-message warning 聚合为可观测指标（review Important-2）。
    """
    return {"synced": synced, "dropped": dropped, "protocol": protocol}


def sync_imap(client, config: Config, account: AccountConfig, state: SyncState) -> dict:
    """IMAP 增量同步一整个账号（全部 folders），返回 `{"synced", "dropped"}`。

    dropped = 超大单封被跳过（fetch 层 water mark 推过）＋归一化失败被跳过。
    """
    total = 0
    dropped = 0
    for folder in account.folders:
        sel = client.select_folder(folder, readonly=True)
        uidvalidity = int(sel[b"UIDVALIDITY"])
        oversize = []                                   # 本窗口被 MAX_SINGLE_BYTES 跳过的大封 uid
        msgs = fetch_new_messages(client, account, folder, state, oversize=oversize)
        dropped += len(oversize)    # 先计入大封跳过，再判断有无健康邮件
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
                dropped += 1
                log.warning("skip imap message uid=%s folder=%s account=%s: %r",
                            m.uid, folder, account.id, e)
        if batch:
            upload_emails(config, batch)
            total += len(batch)
        # 水印在 upload 成功后才推进，始终进到本窗口最大 uid（含被跳过的畸形
        # 单封）——即便整个窗口都是坏件也要推进，否则一轮轮重拉同一个坏窗口
        # （与 MAX_SINGLE_BYTES 推水印语义一致）。被跳过的 uid 就此放弃，仅以
        # warning 日志留痕（与 MAX_SINGLE_BYTES 主动跳过的取舍口径一致；真要
        # 100% 留到底只能人工从日志捞出来单测复现）。若 upload 失败，上面的
        # upload_emails 抛错，此处不执行，水印留在窗口之下，下一轮续传（boundary
        # test：upload 抛错 → 水印不推进、下轮重拉同一窗口）。
        # 水印按 state 当前值（fetch 层可能已推过整窗内被跳过的超限 uid）与窗口
        # 最大 uid 的较大者写入，保证单调不回落——否则窗口内混入「最大 uid 是超限
        # 单封」时（如 [1,2,3,1000_超限] 只挑 [1,2,3]），此处会把它从 1000 拉回 3，
        # 下轮又重拉 4..1000 死循环（review 新发现；原 `max(m.uid for m in msgs)` 缺失）。
        state.set_last_uid_max(
            account.id, folder, max(m.uid for m in msgs))
    return _account_result(total, dropped, "imap")


def sync_pop3(account: AccountConfig, config: Config, state: SyncState) -> dict:
    """POP3 降级同步：只在逻辑收件箱 INBOX 上读取。

    POP3 没有 IMAP 的复杂文件夹结构，配置里除 INBOX 外的 folder 直接忽略。
    水印用 UIDL 集合推进；upload 成功后批量标记 seen。

    返回 `{"synced", "dropped"}`——dropped 含量子（fetch 层大封跳过）+ 单封
    归一化失败（坏件不标记 seen，留给下一轮）。
    """
    if "INBOX" not in account.folders:
        return _account_result(0, 0, "pop3")
    conn = connect_pop3(account)
    try:
        oversize: list[str] = []
        msgs = fetch_new_pop3_messages(conn, account, "INBOX", state, oversize=oversize)
        if not msgs:
            return _account_result(0, len(oversize), "pop3")
        # 逐封归一化，单封畸形绝不卡死整批（C3 hardening）：
        # 归一化失败的 UIDL 跳过上传、**不标记 seen**，下一轮 fetch 会重试；
        # 成功归一化的照常批量 mark seen。POP3 的 watermark 就是 seen 集合，
        # 所以跳过的 UIDL 不得标记，留给下一轮（IMAP 多 folder 窗口可以推进
        # last_uid 放弃，POP3 没有对称概念）。
        batch, uploaded_uidls = [], []
        dropped = len(oversize)
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
            # 全部归一化失败且无任何已成功上传的邮件：不能静默返回 0。
            # `_fallback_to_pop3` 将任何 <=0 返回值当「POP3 同步成功」并永久钉住
            # 账号到 POP3；这里抛出表示「POP3 本轮失败」——auto 账号下轮重试 IMAP，
            # 显式 pop3 账号由 run_once 捕获、下轮重试同批未 seen 的 UIDL（review
            # Important-1 回归：改动前整批 list-comprehension 崩到这里不执行钉住）。
            n_pending = len(msgs)
            raise RuntimeError(
                f"pop3 {account.id}: all {n_pending} pending messages failed to "
                f"normalize (dropped={dropped}), nothing uploaded and nothing marked seen")
        result = upload_emails(config, batch)
        inserted = result.get("inserted", len(batch))
        # 上传成功（200）后批量 seen——只标记**成功归一化的这批**，被跳过的坏
        # UIDL 不在此列。如果上传失败会抛出，此处不执行，留到下一轮。
        state.add_pop3_seen_many(account.id, "INBOX", uploaded_uidls)
        return _account_result(inserted, dropped, "pop3")
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

    返回 `{"synced": N, "dropped": M, "protocol": "imap"|"pop3"}`。
    """
    if account.protocol == "pop3":
        return sync_pop3(account, config, state)

    # 已被钉住到 POP3 的账号直接走 POP3（不再试 IMAP）
    if state.is_fallback_pinned(account.id):
        return sync_pop3(account, config, state)

    client = None
    try:
        client = client_factory(account)
    except Exception:
        # 连接 / 登录阶段（factory 内部）同样允许降级
        if account.protocol == "auto" and not account.oauth:
            return _fallback_to_pop3(config, account, state)
        raise

    try:
        return sync_imap(client, config, account, state)
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

    - POP3 同步成功后才钉住（`state.fallback`），永久不重试 IMAP：避免 IMAP
      抖动时同一账号出现 imap:/pop3: 两套 imap_uid 键的重复行。
    - 若 POP3 本身也失败，则抛错、不钉住——保留 IMAP 在下轮仍可用的机会。
    - 边界：若本 run 内 IMAP 已成功 upload 部分 folder 后才失败，POP3 全量重抓
      INBOX 会与 imap: 键重复（unique index 拦不住跨命名空间）。163.com 首个
      SELECT 即挂（零 IMAP upload），现实中快速收敛；多文件夹混合场景跨协议
      去重留待后续（见 CHANGELOG 注释）。
    """
    res = sync_pop3(account, config, state)
    state.set_fallback_pinned(account.id, True)
    log.info("account=%s pinned to POP3 after IMAP failure (synced=%d, dropped=%d)",
             account.id, res["synced"], res["dropped"])
    return res
