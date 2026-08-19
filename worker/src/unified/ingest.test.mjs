import assert from "node:assert/strict";
import test from "node:test";
import { toEmailInsertParams } from "./ingest.ts";

test("toEmailInsertParams fills defaults and keeps imap_uid", () => {
  const p = toEmailInsertParams({
    source: "imap_qq", account_id: "qq", from_addr: "a@b.com", to_addr: "me@qq.com",
    subject: "s", imap_uid: "h:INBOX:1:5",
  }, "uuid-1", 1700000000000);
  assert.equal(p[0], "uuid-1");           // id
  assert.equal(p[1], "imap_qq");          // source
  assert.equal(p[8], 1700000000000);      // received_at default = now
  assert.equal(p[11], 0);                 // is_read default
  assert.equal(p[15], "h:INBOX:1:5");     // imap_uid
});

test("toEmailInsertParams throws when from/to missing", () => {
  assert.throws(() => toEmailInsertParams({ source: "imap_qq" }, "id", 1));
});