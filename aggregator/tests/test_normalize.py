import json

from one_mail_agg.normalize import normalize_message
from one_mail_agg.config import AccountConfig
from email import message_from_bytes

RAW = (b"From: Alice <alice@ex.com>\r\nTo: me@qq.com\r\n"
       b"Subject: Code 123456\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
       b"Your code is 123456\r\n")


def acc():
    return AccountConfig(id="qq", source="imap_qq", host="imap.qq.com", port=993,
                         username="me@qq.com", password="p")


def test_normalize_basic_fields():
    e = normalize_message(RAW, acc(), "INBOX", uidvalidity=7, uid=123, internal_date_ms=1700000000000)
    assert e["source"] == "imap_qq"
    assert e["account_id"] == "qq"
    assert e["from_addr"] == "alice@ex.com"
    assert e["to_addr"] == "me@qq.com"
    assert e["subject"] == "Code 123456"
    assert "123456" in e["text_body"]
    assert e["imap_uid"] == "imap.qq.com:INBOX:7:123"
    assert e["internal_date"] == 1700000000000
    assert e["is_read"] == 0


def test_normalize_header_not_json_serializable():
    """真实邮件里某些头（如含 WS 折行+encoded-word 的畸形头）会被解析成
    email.header.Header/bytes 值，裸 json.dumps 会 TypeError。修复后应串行化成功。
    """
    raw = (b"From: Alice <alice@ex.com>\r\n"
           b"To: me@qq.com\r\n"
           b"Subject: Header injection test\r\n"
           b"X-Junk: first\r\n"
           b" content\r\n"
           b"Content-Type: text/plain; charset=utf-8\r\n\r\n"
           b"body\r\n")
    e = normalize_message(raw, acc(), "INBOX", uidvalidity=7, uid=124, internal_date_ms=1700000000000)
    assert e["subject"] == "Header injection test"
    headers = json.loads(e["headers_json"])
    assert isinstance(headers, dict)
    assert "Subject" in headers
    for v in headers.values():
        assert isinstance(v, str)


def test_normalize_pop3_uid_override():
    """POP3 路径没有 IMAP UIDVALIDITY/UID，调用方用 imap_uid_override 传稳定键，
    归一化结果的 imap_uid 必须用该值，而非默认的 host:folder:uidvalidity:uid。"""
    from one_mail_agg.config import AccountConfig
    pop = AccountConfig(id="163", source="imap_163", host="imap.163.com", port=993,
                        username="x@163.com", password="p", protocol="pop3",
                        pop3_host="pop.163.com", pop3_port=995, pop3_ssl=True)
    e = normalize_message(RAW, pop, "INBOX", uidvalidity=1, uid=42,
                          internal_date_ms=None,
                          imap_uid_override="pop3:pop.163.com:INBOX:UIDL-ABC123")
    assert e["imap_uid"] == "pop3:pop.163.com:INBOX:UIDL-ABC123"
    # 不传 override 时必须严格保持旧 IMAP 输出
    e_imap = normalize_message(RAW, acc(), "INBOX", uidvalidity=7, uid=123, internal_date_ms=None)
    assert e_imap["imap_uid"] == "imap.qq.com:INBOX:7:123"


def test_normalize_header_values_coerced():
    """即使某头被解析成 Header/bytes 字节，headers_json 也必须可 JSON 序列化。"""
    from email.header import Header
    from one_mail_agg.normalize import _header_json_stringify

    cases = [
        None,
        b"bytes\xe4\xb8\xad\xe6\x96\x87",
        Header("=?utf-8?B?5wWL6K+V?=", "utf-8"),  # Header 对象（真实故障形态）
        "plain str",
    ]
    for raw in cases:
        s = _header_json_stringify(raw)
        assert isinstance(s, str)  # 防止 json.dumps 抛 TypeError 的关键
        # 值被安全转成字符串（即使是空串），全量 headers_json 能 json.loads


def test_normalize_missing_from_falls_back_to_unknown():
    """缺 From 头的邮件 from_addr 兜底为 'unknown'，保证 Worker ingest 不接受
    空字符串（HTTP 500 from_addr/to_addr required），否则整个批次卡死。

    回归：QQ 收件箱曾因单封缺 From 邮件整批反复 500，last_uid 卡住不推进。
    """
    raw = (b"To: me@qq.com\r\nSubject: no sender\r\n"
           b"Content-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n")
    e = normalize_message(raw, acc(), "INBOX", uidvalidity=7, uid=999, internal_date_ms=None)
    assert e["from_addr"] == "unknown"
    assert e["to_addr"] == "me@qq.com"


def test_normalize_from_without_address_falls_back():
    """From 头只有显示名、无地址时，也必须给出有效 from_addr（非空）。"""
    raw = (b"From: just a name\r\nTo: me@qq.com\r\n"
           b"Content-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n")
    e = normalize_message(raw, acc(), "INBOX", uidvalidity=7, uid=1000, internal_date_ms=None)
    assert e["from_addr"]  # 非空
    assert e["from_addr"] == "just a name"


def _raw_with_bad_attachment(binary: bytes) -> bytes:
    return (b"From: alice@ex.com\r\nTo: me@qq.com\r\nSubject: has bad attach\r\n"
            b"Content-Type: multipart/mixed; boundary=b\r\n\r\n"
            b"--b\r\nContent-Type: application/octet-stream\r\n"
            b"Content-Disposition: attachment; filename=x.bin\r\n"
            b"Content-Transfer-Encoding: base64\r\n\r\n"
            + binary + b"\r\n--b--\r\n")


def test_normalize_corrupt_attachment_does_not_wedge_sync():
    """C3 goal: 畸形附件（base64 垃圾/二进制乱码）不能毁掉整批 sync。
    Py3.11 a2b_base64 对坏字节宽松忽略（解码出垃圾 bytes）——所以不抛错，
    但这正是危险之处：不同 Python 版本/VPS 与本地解释器行为不同，
    一旦解码从宽松变严格（3.13+ 曾讨论收紧），单封坏件会让
    normalize_message 抛错、水印不推进、账号死锁。因此：消息必须
    仍能被规范化成一行、imap_uid 可用，attachments_json 是合法数组。"""
    raw = _raw_with_bad_attachment(b"@@@@@@not-valid-base64@@@@@@")
    e = normalize_message(raw, acc(), "INBOX", uidvalidity=7, uid=1001, internal_date_ms=None)
    assert e["imap_uid"] == "imap.qq.com:INBOX:7:1001"  # 水印照常，同步不卡死
    atts = json.loads(e["attachments_json"])
    assert isinstance(atts, list)                     # attachments_json 恒为合法数组
    assert all({"name", "size", "mimeType"} <= set(a) for a in atts)  # 条目结构完整


def test_attachments_guard_skips_part_whose_decode_raises():
    """C3 mechanism: _attachments 对 get_payload(decode=True) 的 except 分支。
    直接打桩让该调用抛错，证明异常被吞掉、附件被跳过，而不是传给整批 sync。
    （当前解释器上真实坏 base64 不会抛，此测试用桩显式覆盖守卫分支。）"""
    from one_mail_agg import normalize as N

    msg = message_from_bytes(_raw_with_bad_attachment(b"x"))
    part = next((p for p in msg.walk() if p.get_content_disposition() == "attachment"), None)
    assert part is not None

    def bomb(_dc=None, **kw):
        raise ValueError("simulated strict base64 decode crash")

    part.get_payload = bomb                      # 桩：模拟严格模式下解码头抛错
    assert N._attachments(msg) == []             # 守卫吞掉、跳过该附件
