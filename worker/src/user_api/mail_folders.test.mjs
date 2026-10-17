import assert from "node:assert/strict";
import test from "node:test";
import { safeFolders, withSpamFolders } from "./mail_folders.ts";

test("safeFolders falls back to INBOX for malformed values", () => {
    assert.deepEqual(safeFolders(null), ["INBOX"]);
    assert.deepEqual(safeFolders(""), ["INBOX"]);
    assert.deepEqual(safeFolders("not json"), ["INBOX"]);
    assert.deepEqual(safeFolders('{"a":1}'), ["INBOX"]);
    assert.deepEqual(safeFolders("[]"), ["INBOX"]);
    assert.deepEqual(safeFolders('["   "]'), ["INBOX"]);
});

test("safeFolders keeps a well-formed list", () => {
    assert.deepEqual(safeFolders('["INBOX","Junk"]'), ["INBOX", "Junk"]);
});

// 归集的目标是「不漏邮件」：垃圾邮件不在 INBOX，必须并入同步范围，否则永远看不到。
test("withSpamFolders appends the discovered spam folder after INBOX", () => {
    assert.deepEqual(withSpamFolders(["INBOX"], ["[Gmail]/垃圾邮件"]),
                     ["INBOX", "[Gmail]/垃圾邮件"]);
    assert.deepEqual(withSpamFolders(["INBOX"], ["Junk"]), ["INBOX", "Junk"]);
});

test("withSpamFolders keeps INBOX first (the aggregator IDLE-monitors folders[0])", () => {
    assert.equal(withSpamFolders(["INBOX"], ["Junk"])[0], "INBOX");
});

test("withSpamFolders dedupes case-insensitively and skips blanks", () => {
    assert.deepEqual(withSpamFolders(["INBOX", "Junk"], ["junk", "  ", "JUNK"]), ["INBOX", "Junk"]);
    assert.deepEqual(withSpamFolders(["INBOX"], []), ["INBOX"]);
    assert.deepEqual(withSpamFolders(["INBOX"], [""]), ["INBOX"]);
});

test("withSpamFolders does not mutate the configured list", () => {
    const configured = ["INBOX"];
    withSpamFolders(configured, ["Junk"]);
    assert.deepEqual(configured, ["INBOX"]);
});
