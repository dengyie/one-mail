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
    """`oversize`（可选）：记录被 MAX_SINGLE_BYTES 跳过的大封 **以及未知 SIZE
    （RFC822.SIZE 缺失）被 fail-closed 跳过**的 uid 的可变计数器。由 sync 层传入，
    把「本该在批次里的邮件为何缺席」从隐式 warning 提升为可聚合观测值
    （review Important-2 / 聚合器 dropped）。注意两者水印语义不同：真大封推过
    水印（永久放弃），未知 SIZE 不推水印（下轮重试，绝不丢信，见 H1）。
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
    # 大批量收件箱：一次只取一个"窗口"。数量上限 BATCH_SIZE，
    # 另有累计字节上限 BATCH_BYTES——超大附件邮箱（几十 MB 单封）若按数量
    # 取满会把整批 RFC822 全塞内存触发 OOM。先探测 SIZE 再挑最小的 uid
    # 填充窗口；单封超过预算也会被包含（宁慢勿永久卡死）。
    sizes = client.fetch(uids, [b"RFC822.SIZE"])
    budget = BATCH_BYTES
    picked = []
    total = 0
    for u in uids:
        if len(picked) >= BATCH_SIZE:
            break
        raw_size = sizes.get(u, {})
        size = 0
        size_known = False
        if isinstance(raw_size, dict):            # imapclient: {b"RFC822.SIZE": int}
            v = raw_size.get(b"RFC822.SIZE")
            if isinstance(v, int):
                size, size_known = v, True
        elif isinstance(raw_size, int):           # 其他服务器/库直接返回 int
            size, size_known = raw_size, True
        if (not size_known) or size > MAX_SINGLE_BYTES:
            # 单封超限：跳过（连同把 water mark 推过该封），否则每轮窗口都卡在这封
            # （该封极可能是超大附件，会拉取顶爆容器内存）。
            if not size_known:
                # SIZE 缺失（服务器不支持 RFC822.SIZE，如部分 imap_custom）：
                # 按「未知 = 超限」fail-closed 跳过、绝不把未知大小的邮件整条塞进
                # 内存（与 POP3 LIST 缺失口径一致）；但**不推进 water mark**——
                # 一旦推过，`last_uid+1:*` 永不重试这批，整批新邮件静默丢失
                # （H1）。下一轮仍在原起点重试（repeated attempts 只会多拉
                # SIZE 列表，绝不丢邮件）；待服务器恢复返回 SIZE（或邮件进了
                # size 探测成功的窗口）即自愈。
                if oversize is not None:
                    oversize.append(u)  # H1：unknown-size 同样计入 dropped，synced=0 时有可见计数
                log.warning("unknown-size skip uid=%s folder=%s account=%s "
                            "(RFC822.SIZE missing -> fail-closed, watermark not advanced, will retry)",
                            u, folder, account.id)
                continue                # 关键是：这里不 set_last_uid(u)
            if oversize is not None:
                oversize.append(u)
            if u > state.get_last_uid(account.id, folder):
                state.set_last_uid(account.id, folder, u)
            continue
        total += size
        # 超出预算即截断；但若窗口尚空（首封就超大）仍收下，避免永久卡死
        if total > budget and picked:
            break
        picked.append(u)
    uids = picked
    data = client.fetch(uids, [b"RFC822", b"INTERNALDATE"])
    out = []
    for u in uids:
        body = data.get(u, {})
        raw = body.get(b"RFC822", b"")
        out.append(RawMessage(uid=u, raw_bytes=raw, internal_date_ms=_to_ms(body.get(b"INTERNALDATE"))))
    return out