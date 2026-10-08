import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 回归锁：COUNT(*) 必须显式 opt-in 才执行。
// 统一收件箱前端轮询依赖这一点：无新邮件时探测只读 1 行；
// 否则每次刷新的全量计数会随 emails 表规模线性烧穿 D1 rows_read 免费额度。
// 2026-10-08 就是这条路径把免费档 500 万行/天的额度打爆，/admin/unified/* 全 500。
// 2026-10-08 之前语义是「除非显式传 0，否则计数」，即缺省也计数 —— 已改为 opt-in。
// index.ts / common.ts 是入口模块（extensionless imports，esbuild 解析），
// 无法在 node:test 中直接加载，这里沿用前端的源码契约方式锁行为。

const indexSrc = readFileSync(
    fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8"
);
const commonSrc = readFileSync(
    fileURLToPath(new URL("../common.ts", import.meta.url)), "utf8"
);

test("listEmails parses with_count out of the query string", () => {
    assert.ok(
        indexSrc.includes("const { limit, offset, cursor, with_count, ...rest } = c.req.query();"),
        "with_count must be destructured so it never leaks into the WHERE filters",
    );
    assert.ok(
        indexSrc.includes("const withCount = wantsEmailCount(with_count);"),
        "counting must be opt-in: an absent with_count must not count",
    );
    assert.ok(
        !indexSrc.includes('const withCount = with_count !== "0"'),
        "the old default-on semantics must not come back",
    );
});

test("offset mode forwards skipCount to handleListQuery", () => {
    assert.ok(
        /params(?: as string\[\])?, limit, offset, UNIFIED_EMAIL_ORDER, \[\], \{ skipCount: !withCount \}\)/.test(indexSrc),
        "offset branch must pass skipCount so handleListQuery skips the count query",
    );
});

test("cursor mode guards the COUNT scan behind withCount", () => {
    const countBlock = indexSrc.slice(
        indexSrc.indexOf("// 总数只在首页且显式 opt-in 时才算"),
        indexSrc.indexOf("has_more: hasMore,"),
    );
    assert.ok(countBlock.includes("withCount"), "cursor first page must respect with_count");
    assert.ok(countBlock.includes("decodedCursor"), "later cursor pages must never repeat the count");
    assert.ok(
        countBlock.includes("count: count ?? null"),
        "an uncomputed count must be null, never a fabricated 0 that reads as 'empty mailbox'",
    );
});

test("handleListQuery short-circuits the count query on skipCount", () => {
    const countBranch = commonSrc.slice(
        commonSrc.indexOf("// skipCount 让调用方（如轮询探测）跳过 COUNT(*)"),
        commonSrc.indexOf("if (hiddenFields.length === 0) {"),
    );
    assert.ok(countBranch.includes("options.skipCount"), "skipCount option must guard the count query");
    assert.ok(countBranch.includes("null"), "skipped count must be null, never a fabricated 0");
    assert.ok(countBranch.includes("offset == 0"), "count still only ever runs for the first page");
});
