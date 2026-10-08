import assert from "node:assert/strict";
import test from "node:test";
import { wantsEmailCount } from "./count_opt_in.ts";

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