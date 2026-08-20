import json

from one_mail_agg.normalize import normalize_message
from one_mail_agg.config import AccountConfig

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