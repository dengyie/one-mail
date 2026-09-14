import logging
from dataclasses import dataclass
from email.utils import parsedate_to_datetime

from .config import AccountConfig
from .state import SyncState

log = logging.getLogger("one-mail-agg")

# 单轮最多拉取的邮件数：设置为 50 封（兼顾网络传输时间与 D1 写入上限，避免大批次请求顶满 60s 导致 Worker 524 / 503 异常）。
BATCH_SIZE = 50
# 单轮累计原始字节预算：超大附件邮箱（QQ 常见几十 MB 大邮件）一轮抓太多
# 会把 RFC822 全塞进内存触发 OOM（pxed 实测：66MB+65MB 单封在窗口内直接 500MB+）。
BATCH_BYTES = 64 * 1024 * 1024
# 单封原始大小上限：超过即跳过该封并把 last_uid 推过它，避免一封信把
# 容器内存顶爆（pxed 为 K8s cgroup，56MB 附件就足够触发 OOM）。
MAX_SINGLE_BYTES = 30 * 1024 * 1024


@dataclass
class RawMessage:
    uid: int
    raw_bytes: bytes
    internal_date_ms: int | None
    uidl: str | None = None     # POP3 稳定 UIDL；IMAP 路径为 None


def make_imap_uid(account_id: str, host: str, folder: str, uidvalidity: int, uid: int) -> str:
    # 键含账号维度：同主机多账号 + UIDVALIDITY 恒 1 + 每邮箱 uid 从 1 起时，
    # 旧 host-only 键会让不同账号的同一 uid 撞 Worker 的 imap_uid 唯一索引，
    # INSERT OR IGNORE 静默吞掉后续用户整封邮件（高危隐性丢信）。
    return f"{account_id}:{host}:{folder}:{uidvalidity}:{uid}"


def _to_ms(dt) -> int | None:
    if dt is None:
        return None
    if isinstance(dt, (int, float)):
        return int(dt * 1000)
    try:
        return int(dt.timestamp() * 1000)
    except Exception:
        try:
            return int(parsedate_to_datetime(str(dt)).timestamp() * 1000)
        except Exception:
            return None


def fetch_new_messages(client, account: AccountConfig, folder: str, state: SyncState,
                       oversize: list[int] | None = None) -> list[RawMessage]:
    """按 UID 单调窗口拉取新邮件。

    `oversize` 同时记录真正超限和 RFC822.SIZE 未知的 UID，供上层计入 dropped。
    两者水位语义不同：真正超限可永久放弃并推进水位；SIZE 未知必须保留重试。

    关键不变量：**绝不跨过一个需要重试的未知 SIZE UID 继续处理更大的 UID**。
    单一 last_uid 水位无法表达“2 未处理但 3 已提交”这种洞；若继续处理 3，sync
    层最终推进到 3 就会永久丢掉 2。因此遇到第一个未知 SIZE 时截断当前窗口，
    只返回它之前已安全挑出的邮件；下轮从这个洞继续尝试。
    """
    sel = client.select_folder(folder, readonly=True)
    uidvalidity = int(sel[b"UIDVALIDITY"])
    last_uid = state.get_last_uid(account.id, folder)

    known_v = state.get_uidvalidity(account.id, folder)
    if known_v is not None and known_v != uidvalidity:
        # UIDVALIDITY 变化：重拉全量
        state.set_uidvalidity(account.id, folder, uidvalidity)
        last_uid = 0
    elif known_v is None:
        # 首次：记录 UIDVALIDITY，但不重置 last_uid
        state.set_uidvalidity(account.id, folder, uidvalidity)

    uids = client.search(["UID", f"{last_uid + 1}:*"], charset=None)
    uids = [u for u in uids if u > last_uid]
    if not uids:
        return []

    # 首次同步保护（initial_sync_limit）：若上次 last_uid 为 0 且待拉邮件超过 limit，
    # 仅挑最新的 initial_sync_limit 封，并将已跳过的旧邮件推过水印，防止打爆 D1 / OOM。
    if last_uid == 0 and getattr(account, "initial_sync_limit", 0) > 0 and len(uids) > account.initial_sync_limit:
        skipped_uids = uids[:-account.initial_sync_limit]
        uids = uids[-account.initial_sync_limit:]
        log.info("account=%s initial sync limit applied: syncing latest %d msgs, skipping %d older msgs",
                 account.id, len(uids), len(skipped_uids))
        if skipped_uids:
            state.set_last_uid_max(account.id, folder, max(skipped_uids))

    # 先探测 SIZE 再挑窗口，防止把大附件全部拉入内存。
    sizes = client.fetch(uids, [b"RFC822.SIZE"])
    budget = BATCH_BYTES
    picked: list[int] = []
    total = 0
    for u in uids:
        if len(picked) >= BATCH_SIZE:
            break
        raw_size = sizes.get(u, {})
        size = 0
        size_known = False
        if isinstance(raw_size, dict):
            v = raw_size.get(b"RFC822.SIZE")
            if isinstance(v, int):
                size, size_known = v, True
        elif isinstance(raw_size, int):
            size, size_known = raw_size, True

        if not size_known:
            # 未知 SIZE 不能安全读取正文，也不能跨洞处理后续 UID。记录本 UID 后
            # 立即截断窗口；如果前面已有 picked，它们仍可上传并把水位推进到洞前。
            if oversize is not None:
                oversize.append(u)
            log.warning(
                "unknown-size boundary uid=%s folder=%s account=%s "
                "(RFC822.SIZE missing -> stop window, watermark cannot cross this UID)",
                u, folder, account.id,
            )
            break

        if size > MAX_SINGLE_BYTES:
            # SIZE 已知且真的超限：这是明确的永久放弃，可安全推进到该 UID 并继续。
            if oversize is not None:
                oversize.append(u)
            state.set_last_uid_max(account.id, folder, u)
            continue

        total += size
        if total > budget and picked:
            break
        picked.append(u)

    if not picked:
        return []

    data = client.fetch(picked, [b"RFC822", b"INTERNALDATE"])
    out = []
    for u in picked:
        body = data.get(u, {})
        raw = body.get(b"RFC822", b"")
        out.append(RawMessage(uid=u, raw_bytes=raw, internal_date_ms=_to_ms(body.get(b"INTERNALDATE"))))
    return out
