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


def _nullable_header(msg, name: str) -> str | None:
    value = msg.get(name)
    if value is None:
        return None
    text = _dec(value).strip()
    return text or None


def _references(msg) -> list[str] | None:
    """Return RFC References tokens without inventing thread identity.

    References is useful for later fallback threading, but it is not a provider
    message/thread ID and therefore must never participate in provider-level
    uniqueness. Multiple header lines are preserved in order.
    """
    refs: list[str] = []
    for value in msg.get_all("References", []):
        text = _dec(value).replace("\r", " ").replace("\n", " ")
        refs.extend(token for token in text.split() if token)
    return refs or None


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


def _infer_provider(account: AccountConfig) -> str:
    source = str(getattr(account, "source", "") or "").lower()
    protocol = str(getattr(account, "protocol", "") or "").lower()
    if source.startswith("graph_"):
        return "graph"
    if protocol == "pop3":
        return "pop3"
    return "imap"


def normalize_message(raw_bytes: bytes, account: AccountConfig, folder: str,
                      uidvalidity: int, uid: int, internal_date_ms: int | None,
                      now_ms: int = 0, imap_uid_override: str | None = None,
                      *, provider: str | None = None,
                      provider_message_id: str | None = None,
                      provider_thread_id: str | None = None,
                      source_folder_id: str | None = None,
                      source_key_override: str | None = None) -> dict:
    import time
    msg = message_from_bytes(raw_bytes)
    text, html = _bodies(msg)
    attachments = _attachments(msg)

    # from_addr 兜底：worker ingest 契约要求 from_addr/to_addr 非空。
    # 缺 From 头 / 空 From / 解析出不含 @ 的伪地址 → 用整段头文本 / "unknown"
    # 兜底，避免整个批次因单封畸形邮件在 QQ/163 反复 500（`from_addr required`）卡死。
    from_hdr = _dec(msg.get("From", ""))
    _parsed = parseaddr(from_hdr)[1]
    from_addr = _parsed if ("@" in _parsed) else (from_hdr or "unknown")

    # account_id is the authorization/tenant boundary. to_addr remains the
    # connected mailbox address for compatibility and display, but it is never
    # used to authorize an external mailbox message.
    to_addr = account.username
    provider_name = provider or _infer_provider(account)
    legacy_uid = imap_uid_override or make_imap_uid(
        account.id, account.host, folder, uidvalidity, uid)
    source_key = source_key_override or legacy_uid
    refs = _references(msg)

    return {
        "source": account.source,
        "account_id": account.id,
        "from_addr": from_addr,
        "to_addr": to_addr,
        "subject": _dec(msg.get("Subject", "")),
        "text_body": text,
        "html_body": html,
        "received_at": internal_date_ms or now_ms or int(time.time() * 1000),
        "internal_date": internal_date_ms,
        "headers_json": json.dumps(
            {k: _header_json_stringify(v) for k, v in msg.items()}, ensure_ascii=False
        ),
        "is_read": 0,
        "flags_json": "[]",
        "attachments_json": json.dumps(attachments, ensure_ascii=False),
        "raw_ref": None,
        # Keep the legacy field for rolling deploys and old IMAP-proxy/API
        # consumers. It is no longer the canonical cross-provider model.
        "imap_uid": legacy_uid,
        "provider": provider_name,
        "source_folder": folder,
        "source_folder_id": source_folder_id,
        # Only callers that obtained a provider-stable ID may populate this.
        # IMAP UID is intentionally never promoted into provider_message_id.
        "provider_message_id": provider_message_id,
        "provider_thread_id": provider_thread_id,
        "message_id_header": _nullable_header(msg, "Message-ID"),
        "in_reply_to": _nullable_header(msg, "In-Reply-To"),
        "references_json": json.dumps(refs, ensure_ascii=False) if refs is not None else None,
        "has_attachments": 1 if attachments else 0,
        "source_key": source_key,
        "sync_version": 1,
        # Folder state is not an emails column; Worker consumes it while
        # upserting mail_account_folders from the same ingest batch.
        "source_uidvalidity": uidvalidity if provider_name == "imap" and uidvalidity > 0 else None,
    }
