import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 回归锁：raw_mails 列表端点的 COUNT(*) 必须可以被显式关掉。
// 前端后台轮询（MailBox / SimpleIndex）每 10s 打一次 offset=0 的列表；
// 如果每次刷新都跑 count(*)（无可用索引 → 全表扫），rows_read 会随邮箱增长
// 线性烧穿 D1 免费额度（2026-10-08 就是这么打爆的）。
// 契约：这些端点是历史接口，缺省仍然计数；只有显式 with_count=0/false 才跳过，
// 且跳过的计数是 null 而不是 0（0 会被读成「邮箱是空的」）。
// 入口模块是 extensionless imports，node:test 载不动，沿用源码契约的锁法。

const commonSrc = readFileSync(
    fileURLToPath(new URL("../common.ts", import.meta.url)), "utf8"
);
const mailsCrudSrc = readFileSync(
    fileURLToPath(new URL("../mails_api/mails_crud.ts", import.meta.url)), "utf8"
);
const adminMailSrc = readFileSync(
    fileURLToPath(new URL("../admin_api/admin_mail_api.ts", import.meta.url)), "utf8"
);
const userMailSrc = readFileSync(
    fileURLToPath(new URL("../user_api/user_mail_api.ts", import.meta.url)), "utf8"
);

test("handleMailListQuery short-circuits the count query on skipCount", () => {
    const anchor = commonSrc.indexOf("// skipCount 让调用方（如后台轮询）跳过 COUNT(*)");
    assert.notEqual(anchor, -1, "the skipCount branch must exist in common.ts");
    const countBranch = commonSrc.slice(anchor, commonSrc.indexOf("export const commonParseMail"));
    assert.ok(countBranch.includes("options.skipCount"), "skipCount option must guard the count query");
    assert.ok(countBranch.includes("offset == 0"), "count still only ever runs for the first page");
    assert.ok(countBranch.includes("null"), "skipped count must be null, never a fabricated 0");
    assert.ok(
        countBranch.includes("return c.json({ results: resolvedResults, count })"),
        "raw_mails lists resolve raw_blob, so the response shape must keep that contract",
    );
});

test("/api/mails parses with_count and defaults to counting", () => {
    assert.ok(
        mailsCrudSrc.includes("const { limit, offset, with_count } = c.req.query();"),
        "with_count must be destructured out of the query string",
    );
    assert.ok(
        mailsCrudSrc.includes("const withCount = wantsLegacyCount(with_count);"),
        "the legacy default-on semantics live in wantsLegacyCount, not inline",
    );
});

test("/api/mails skips COUNT(*) only when the client opts out", () => {
    assert.ok(
        mailsCrudSrc.includes("const count = off === 0 ? (withCount ? await countRawMails(c, address) : null) : 0;"),
        "an opted-out refresh must return a null count instead of scanning the table",
    );
});

test("admin mail lists forward skipCount to handleMailListQuery", () => {
    assert.ok(
        adminMailSrc.includes("const { address, limit, offset, with_count } = c.req.query();"),
        "/admin/mails must parse with_count",
    );
    assert.ok(
        adminMailSrc.includes("const { limit, offset, with_count } = c.req.query();"),
        "/admin/mails_unknow must parse with_count",
    );
    assert.equal(
        adminMailSrc.split("{ skipCount: !wantsLegacyCount(with_count) }").length - 1, 2,
        "both admin handlers must forward skipCount",
    );
});

test("user mail list forwards skipCount to handleMailListQuery", () => {
    assert.ok(
        userMailSrc.includes("const { address, limit, offset, with_count } = c.req.query();"),
        "/user_api/mails must parse with_count",
    );
    assert.ok(
        userMailSrc.includes("{ skipCount: !wantsLegacyCount(with_count) }"),
        "/user_api/mails must skip COUNT(*) when the client opts out",
    );
});
