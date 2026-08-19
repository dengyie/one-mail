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