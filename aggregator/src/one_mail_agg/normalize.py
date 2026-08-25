import json
from email import message_from_bytes
from email.header import decode_header, make_header
from email.utils import parseaddr

from .config import AccountConfig
from .imap_base import make_imap_uid


def _dec(v) -> str:
    if not v:
        return ""
    try:
        return str(make_header(decode_header(v)))
    except Exception:
        return str(v)


def _header_json_stringify(v) -> str:
    """把单个 header 值变成可 JSON 序列化的 str。

    `message from email.message` 某些畸形头会被解析成 `email.header.Header`
    或 bytes 对象，json.dumps 不能直接序列化（TypeError: ... not JSON
    serializable）。统一折成字符串，保留头名与原始内容，不丢头。
    """
    if v is None:
        return ""
    if isinstance(v, bytes):
        return v.decode("utf-8", errors="replace")
    if hasattr(v, "encode"):  # str / Header，均可转 str
        return str(v)
    return str(v)


def _bodies(msg) -> tuple[str, str]:
    text, html = "", ""
    parts = msg.walk() if msg.is_multipart() else [msg]
    for p in parts:
        ctype = p.get_content_type()
        disp = str(p.get("Content-Disposition", ""))
        if "attachment" in disp:
            continue
        try:
            payload = p.get_payload(decode=True) or b""
            charset = p.get_content_charset() or "utf-8"
            s = payload.decode(charset, errors="replace")
        except Exception:
            continue
        if ctype == "text/plain" and not text:
            text = s
        elif ctype == "text/html" and not html:
            html = s
    return text, html


def _attachments(msg) -> list[dict]:
    out = []
    parts = msg.walk() if msg.is_multipart() else []
    for p in parts:
        disp = str(p.get("Content-Disposition", ""))
        if "attachment" not in disp:
            continue
        # 附件 base64/quoted-printable 损坏时 get_payload(decode=True) 会抛
        # binascii.Error/ValueError；这里与 _bodies 一样容错跳过，避免单封畸形
        # 附件让整批 sync 崩溃、水印不推进导致账号永久死锁（C3，与 from_addr 兜底同类）。
        try:
            payload = p.get_payload(decode=True) or b""
        except Exception:
            continue
        out.append({"name": _dec(p.get_filename() or ""), "size": len(payload),
                    "mimeType": p.get_content_type()})
    return out


def normalize_message(raw_bytes: bytes, account: AccountConfig, folder: str,
                      uidvalidity: int, uid: int, internal_date_ms: int | None,
                      now_ms: int = 0, imap_uid_override: str | None = None) -> dict:
    import time
    msg = message_from_bytes(raw_bytes)
    text, html = _bodies(msg)

    # from_addr 兜底：worker ingest 契约要求 from_addr/to_addr 非空。
    # 缺 From 头 / 空 From / 解析出不含 @ 的伪地址 → 用整段头文本 / "unknown"
    # 兜底，避免整个批次因单封畸形邮件在 QQ/163 反复 500（`from_addr required`）卡死。
    from_hdr = _dec(msg.get("From", ""))
    _parsed = parseaddr(from_hdr)[1]
    from_addr = _parsed if ("@" in _parsed) else (from_hdr or "unknown")
    # to_addr 恒等于 account.username，不再取 To: 头。
    # 归属语义：聚合器是用「该邮箱凭据」登录抓取的，抓到的所有邮件必然属于该
    # 邮箱主人。统一收件箱按 to_addr 做归属隔离（resolveScope 把 to_addr IN 作用域
    # 过滤给用户），若取 To: 头则 alias（user+tag@）、邮件列表转发、bcc、多收件人
    # 等场景下 to_addr ≠ username → 邮件变孤儿（谁的 scope 都匹配不到），用户看不到
    # 本该属于自己邮箱的邮件（可达性缺口，非泄漏——隔离层已拦住跨租户串看）。
    # 固定取 username 保证每封抓回来的邮件都能被邮箱主人看到；原 To: 头仍在
    # headers_json 里完整保留，展示需求不受影响。
    to_addr = account.username
    return {
        "source": account.source,
        "account_id": account.id,
        "from_addr": from_addr,
        "to_addr": to_addr,
        "subject": _dec(msg.get("Subject", "")),
        "text_body": text,
        "html_body": html,
        "received_at": now_ms or int(time.time() * 1000),
        "internal_date": internal_date_ms,
        "headers_json": json.dumps(
            {k: _header_json_stringify(v) for k, v in msg.items()}, ensure_ascii=False
        ),
        "is_read": 0,
        "flags_json": "[]",
        "attachments_json": json.dumps(_attachments(msg), ensure_ascii=False),
        "raw_ref": None,
        "imap_uid": imap_uid_override or make_imap_uid(account.id, account.host, folder, uidvalidity, uid),
    }