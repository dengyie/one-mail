import assert from "node:assert/strict";
import test from "node:test";
import { folderType } from "./ingest.ts";

// 归集的目标是「不漏邮件」：垃圾邮件目录必须被识别，否则 worker 导出
// （mail_accounts.ts 只取 folder_type='spam'）不会把它并入同步范围。

test("folderType maps the junk names flagged providers use", () => {
  assert.equal(folderType("Junk"), "spam");
  assert.equal(folderType("Spam"), "spam");
  assert.equal(folderType("Junk Email"), "spam");
  assert.equal(folderType("Junk Mail"), "spam");
  assert.equal(folderType("Junk E-mail"), "spam");
  assert.equal(folderType("  junk  "), "spam");
});

test("folderType maps the localized junk names QQ/163 use without \\Junk flags", () => {
  assert.equal(folderType("垃圾邮件"), "spam");
  assert.equal(folderType("垃圾信件"), "spam");
  assert.equal(folderType("垃圾郵件"), "spam");
  assert.equal(folderType("垃圾電郵"), "spam");
});

test("folderType keeps the Trash-sense 垃圾箱/回收站 distinct from junk", () => {
  assert.equal(folderType("垃圾箱"), "custom");
  assert.equal(folderType("回收站"), "custom");
  assert.equal(folderType("Trash"), "trash");
  assert.equal(folderType("Deleted Items"), "trash");
});
