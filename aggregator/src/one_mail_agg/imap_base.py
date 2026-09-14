import logging
from dataclasses import dataclass
from email.utils import parsedate_to_datetime

from .config import AccountConfig
from .state import SyncState

log = logging.getLogger("one-mail-agg")

BATCH_SIZE = 50
BATCH_BYTES = 64 * 1024 * 1024
MAX_SINGLE_BYTES = 30 * 1024 * 1024


@dataclass
class RawMessage:
    uid: int
    raw_bytes: bytes
    internal_date_ms: int | None
    uidl: str | None = None


def make_imap_uid(account_id: str, host: str, folder: str, uidvalidity: int, uid: int) -> str:
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


def _size_value(raw_size) -> int | None:
    if isinstance(raw_size, dict):
        value = raw_size.get(b"RFC822.SIZE")
        return value if isinstance(value, int) else None
    if isinstance(raw_size, int):
        return raw_size
    return None


def fetch_new_messages(client, account: AccountConfig, folder: str, state: SyncState,
                       oversize: list[int] | None = None) -> list[RawMessage]:
    """按 UID 单调窗口拉取新邮件。

    `oversize` 保留现有可观测性：SIZE 探测结果里所有未知 UID 都会计入 dropped；
    真正超过 MAX_SINGLE_BYTES 的 UID 在处理到它时也计入。二者水位语义不同。

    关键不变量：**正文窗口绝不跨过需要重试的未知 SIZE UID**。单一 last_uid
    无法表达“UID 2 未完成但 UID 3 已提交”的洞，因此第一个 unknown-size UID
    是本轮硬边界。后面的 SIZE 元数据仍可用于统计，但绝不读取正文或推进水位。
    """
    sel = client.select_folder(folder, readonly=True)
    uidvalidity = int(sel[b"UIDVALIDITY"])
    last_uid = state.get_last_uid(account.id, folder)

    known_v = state.get_uidvalidity(account.id, folder)
    if known_v is not None and known_v != uidvalidity:
        state.set_uidvalidity(account.id, folder, uidvalidity)
        last_uid = 0
    elif known_v is None:
        state.set_uidvalidity(account.id, folder, uidvalidity)

    uids = client.search(["UID", f"{last_uid + 1}:*"], charset=None)
    uids = [u for u in uids if u > last_uid]
    if not uids:
        return []

    if last_uid == 0 and getattr(account, "initial_sync_limit", 0) > 0 and len(uids) > account.initial_sync_limit:
        skipped_uids = uids[:-account.initial_sync_limit]
        uids = uids[-account.initial_sync_limit:]
        log.info("account=%s initial sync limit applied: syncing latest %d msgs, skipping %d older msgs",
                 account.id, len(uids), len(skipped_uids))
        if skipped_uids:
            state.set_last_uid_max(account.id, folder, max(skipped_uids))

    sizes = client.fetch(uids, [b"RFC822.SIZE"])
    size_by_uid = {u: _size_value(sizes.get(u, {})) for u in uids}
    unknown_uids = [u for u in uids if size_by_uid[u] is None]
    if oversize is not None:
        # SIZE metadata for the full candidate set is already in memory. Count every
        # unknown UID for visibility, even though正文 processing stops at the first hole.
        oversize.extend(unknown_uids)

    budget = BATCH_BYTES
    picked: list[int] = []
    total = 0
    for u in uids:
        if len(picked) >= BATCH_SIZE:
            break
        size = size_by_uid[u]

        if size is None:
            log.warning(
                "unknown-size boundary uid=%s folder=%s account=%s "
                "(RFC822.SIZE missing -> stop window, watermark cannot cross this UID; unknown_in_candidate=%d)",
                u, folder, account.id, len(unknown_uids),
            )
            break

        if size > MAX_SINGLE_BYTES:
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
