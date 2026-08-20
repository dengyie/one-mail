"""POP3 读取源：为 IMAP 不可用的账号（如 163 的 `Unsafe Login`）提供降级同步。

使用 stdlib `poplib`，不引入新依赖。键空间、字节预算与 IMAP 对齐，但水印语义不同：
POP3 没有 IMAP 的 UIDVALIDITY/UID，服务器维持的稳定标识是 UIDL；而且 POP3 的
message number 会在邮件删除后重排，**不能**当作水印。因此这里按 UIDL 集合推进
（`state.pop3_seen`），未成功上传的 UIDL 保留到下一轮重试。

POP3 只有一个逻辑收件箱（INBOX），配置里的其它 folder 不适用，会被安全忽略。
"""
import logging
import poplib
import ssl

from email.utils import parsedate_to_datetime

log = logging.getLogger("one-mail-agg")

from .config import AccountConfig
from .state import SyncState
from .imap_base import BATCH_SIZE, BATCH_BYTES, MAX_SINGLE_BYTES, RawMessage

# POP3 无 UIDVALIDITY，稳定键命名空间前缀
POP3_UID_PREFIX = "pop3:"

# 模块级别名，便于测试 monkeypatch
POP3 = poplib.POP3
POP3_SSL = poplib.POP3_SSL


def connect_pop3(account: AccountConfig):
    """按 account 的 POP3 参数建立连接。

    - use_ssl=True：SSL 包装的 995 端口（POP3S）。
    - use_ssl=False 且 pop3_use_stls=True：先明文再 STLS 升级。
    - 否则明文 110。所有连接严格 finally QUIT。
    """
    host = account.resolve_pop3_host()
    port = account.resolve_pop3_port()
    use_ssl = account.resolve_pop3_use_ssl()
    tls_ctx = None
    if use_ssl:
        # 新版 POP3_SSL 使用 context 参数；尽量走系统（ca）证书。
        try:
            tls_ctx = ssl.create_default_context()
        except Exception:
            pass
    if use_ssl:
        conn = POP3_SSL(host, port, timeout=30, context=tls_ctx)
    else:
        conn = POP3(host, port, timeout=30)
        if account.pop3_use_stls:
            conn.stls()
    try:
        conn.user(account.username)
        conn.pass_(account.password)
    except Exception:
        try:
            conn.quit()
        except Exception:
            pass
        raise
    return conn


def uidl_to_key(account: AccountConfig, folder: str, uidl: str) -> str:
    """POP3 稳定键：imap_uid 字段保存的 `pop3:` 命名空间值，与 IMAP 的
    host:folder:uidvalidity:uid 区分，且不会被 message-number 重排影响。"""
    return f"{POP3_UID_PREFIX}{account.resolve_pop3_host()}:{folder}:{uidl}"


def fetch_new_pop3_messages(conn, account: AccountConfig, folder: str,
                            state: SyncState) -> list[RawMessage]:
    """一次性取回 POP3 INBOX 中尚未 seen 的新邮件，返回 `RawMessage` 列表。

    与 IMAP 同样受 BATCH_SIZE / BATCH_BYTES / MAX_SINGLE_BYTES 约束：先 LIST 探测
    单封大小，超限单封跳过（并标记 seen），预算累计超限则截断窗口，避免一窗把
    整个收件箱塞内存（QQ 66MB 附件教训在 POP3 同样适用）。
    """
    seen = state.get_pop3_seen(account.id, folder)
    # UIDL 返回（msg_num, msg）; 过滤掉已见的
    uidls = _uidl_list(conn)
    pending = [(n, uid) for n, uid in uidls if uid not in seen]
    if not pending:
        return []

    # LIST 探测单封大小，过滤超大
    sizes = _list_sizes(conn)          # str(msg_num) -> int bytes

    budget = BATCH_BYTES
    total = 0
    picked: list[tuple[int, str]] = []    # (msg_num, uidl)
    for n, uidl in pending:
        if len(picked) >= BATCH_SIZE:
            break
        size = sizes.get(str(n))
        if size is None:
            # LIST 缺失/解析失败：保守按超大处理（防未知尺寸旁路字节预算）
            size = MAX_SINGLE_BYTES + 1
        if size > MAX_SINGLE_BYTES:
            # 单封超限：跳过并标记 seen，避免下一轮再次拉同一封（懒上传语义：超限封跳过不重试）
            state.add_pop3_seen(account.id, folder, uidl)
            log.warning("pop3 skip oversize %s@%s folder=%s uidl=%s size=%d > %d",
                        account.id, account.resolve_pop3_host(), folder, uidl, size,
                        MAX_SINGLE_BYTES)
            continue
        total += size
        if total > budget and picked:
            break
        picked.append((n, uidl))
    if not picked:
        return []

    out: list[RawMessage] = []
    for msg_num, uidl in picked:
        _resp, lines, _octets = conn.retr(msg_num)   # lines: [bytes...] 不含终止符
        raw_bytes = b"\r\n".join(lines)
        # POP3 无 INTERNALDATE；用 Date 头尽力而为（解析失败 None 让 normalize 回退本地时间）
        internal_date_ms = _header_date_ms(raw_bytes)
        out.append(RawMessage(uid=msg_num, raw_bytes=raw_bytes,
                              internal_date_ms=internal_date_ms,
                              uidl=uidl))
    return out


def _uidl_list(conn) -> list[tuple[int, str]]:
    """返回 [(msg_num(int), uidl), ...]。message number 用于 RETR。"""
    _resp, lines, _octets = conn.uidl()
    out = []
    for line in lines:
        try:
            parts = line.split()
            if len(parts) >= 2:
                out.append((int(parts[0]), parts[1].decode()))
        except Exception:
            continue
    return out


def _list_sizes(conn) -> dict[str, int]:
    """返回 {msg_num_str: size_bytes}。LIST 返回行是 b"<num> <size>"。"""
    _resp, lines, _octets = conn.list()
    out = {}
    for line in lines:
        try:
            parts = line.split()
            if len(parts) >= 2:
                out[parts[0].decode()] = int(parts[1])
        except Exception:
            continue
    return out


def _header_date_ms(raw: bytes) -> int | None:
    """POP3 无 INTERNALDATE，用 Header Date（RFC2822）尽力而为；解析失败返回 None。"""
    import email
    msg = email.message_from_bytes(raw)
    d = msg.get("Date")
    if not d:
        return None
    try:
        dt = parsedate_to_datetime(d)
        return int(dt.timestamp() * 1000)
    except Exception:
        return None