from dataclasses import dataclass
from email.utils import parsedate_to_datetime

from .config import AccountConfig
from .state import SyncState

# 单轮最多拉取的邮件数：明显小于远程邮箱总量，避免首次全量一次 fetch 卡死。
BATCH_SIZE = 200


@dataclass
class RawMessage:
    uid: int
    raw_bytes: bytes
    internal_date_ms: int | None


def make_imap_uid(host: str, folder: str, uidvalidity: int, uid: int) -> str:
    return f"{host}:{folder}:{uidvalidity}:{uid}"


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


def fetch_new_messages(client, account: AccountConfig, folder: str, state: SyncState) -> list[RawMessage]:
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
    # 大批量收件箱：一次只取一个"窗口"（此处为最小的 BATCH_SIZE 个），
    # 由落库端把 last_uid 推进到该窗口内最大 uid；下一轮再取下一窗口。
    # 避免首次同步 last_uid=0 时一次 fetch 整个收件箱导致超时；
    # 且保证海量邮箱最终收敛，不会永久丢弃最早的一批。
    uids = uids[:BATCH_SIZE]
    data = client.fetch(uids, [b"RFC822", b"INTERNALDATE"])
    out = []
    for u in uids:
        body = data.get(u, {})
        raw = body.get(b"RFC822", b"")
        out.append(RawMessage(uid=u, raw_bytes=raw, internal_date_ms=_to_ms(body.get(b"INTERNALDATE"))))
    return out