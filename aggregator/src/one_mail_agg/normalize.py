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
        payload = p.get_payload(decode=True) or b""
        out.append({"name": _dec(p.get_filename() or ""), "size": len(payload),
                    "mimeType": p.get_content_type()})
    return out


def normalize_message(raw_bytes: bytes, account: AccountConfig, folder: str,
                      uidvalidity: int, uid: int, internal_date_ms: int | None,
                      now_ms: int = 0, imap_uid_override: str | None = None) -> dict:
    import time
    msg = message_from_bytes(raw_bytes)
    text, html = _bodies(msg)
    return {
        "source": account.source,
        "account_id": account.id,
        "from_addr": parseaddr(_dec(msg.get("From", "")))[1] or _dec(msg.get("From", "")),
        "to_addr": parseaddr(_dec(msg.get("To", "")))[1] or account.username,
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
        "imap_uid": imap_uid_override or make_imap_uid(account.host, folder, uidvalidity, uid),
    }