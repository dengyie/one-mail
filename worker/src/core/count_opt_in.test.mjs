import assert from "node:assert/strict";
import test from "node:test";
import { wantsEmailCount, wantsLegacyCount } from "./count_opt_in.ts";

// Regression: the total used to be computed whenever `with_count` was anything
// other than the literal "0", so an absent parameter meant a full-table COUNT.
// On 2026-10-08 that full scan is what blew the D1 free-tier rows_read budget.
test("counting is opt-in: an absent parameter must not trigger COUNT", () => {
    assert.equal(wantsEmailCount(undefined), false);
    assert.equal(wantsEmailCount(null), false);
    assert.equal(wantsEmailCount(""), false);
});

test("only an explicit opt-in counts", () => {
    assert.equal(wantsEmailCount("1"), true);
    assert.equal(wantsEmailCount(1), true);
    assert.equal(wantsEmailCount("true"), true);
});

test("unrecognised values fail safe to the cheap path", () => {
    for (const raw of ["0", 0, "false", "no", "yes", "2", "TRUE", {}]) {
        assert.equal(wantsEmailCount(raw), false, `${String(raw)} should not count`);
    }
});

// 历史列表端点（/api/mails、/admin/mails[_unknow]、/user_api/mails）的既有契约是
// 「缺省即计数」，老的调用方（官方前端、外部脚本）不会传 with_count。这条路径不能
// 直接复用 opt-in 语义，否则分页总数会集体消失。
test("legacy list endpoints keep counting when with_count is absent", () => {
    assert.equal(wantsLegacyCount(undefined), true);
    assert.equal(wantsLegacyCount(null), true);
});

test("an empty with_count degrades to the cheap path rather than scanning", () => {
    // ?with_count= / ?with_count 是客户端 bug，宁可少个总数也不要全表扫。
    assert.equal(wantsLegacyCount(""), false);
});

test("legacy list endpoints skip COUNT only on an explicit opt-out", () => {
    for (const raw of ["0", 0, "false"]) {
        assert.equal(wantsLegacyCount(raw), false, `${String(raw)} must skip the count`);
    }
});

test("legacy opt-in values still count", () => {
    for (const raw of ["1", 1, "true"]) {
        assert.equal(wantsLegacyCount(raw), true, `${String(raw)} must count`);
    }
});