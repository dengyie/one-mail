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


def test_normalize_header_values_coerced():
    """即使某头值被解析成 Header/bytes（真实故障形态），headers_json 也必须
    可 JSON 序列化（旧代码在此处 TypeError: Header not JSON serializable）。
    """
    from email.header import Header
    from one_mail_agg.normalize import _header_json_stringify

    cases = [
        None,
        b"bytes\xe4\xb8\xad\xe6\x96\x87",
        Header("=?utf-8?B?5rWL6K+V?=", "utf-8"),  # Header 对象（真实故障形态）
        "plain str",
    ]
    for raw in cases:
        s = _header_json_stringify(raw)
        assert isinstance(s, str)  # 防止 json.dumps 抛 TypeError 的关键
        # 值被安全转成字符串（即使是空串），全量 headers_json 能 json.loads