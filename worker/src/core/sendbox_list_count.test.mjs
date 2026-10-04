import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const commonSrc = readFileSync(
    fileURLToPath(new URL("../common.ts", import.meta.url)), "utf8"
);
const sendMailSrc = readFileSync(
    fileURLToPath(new URL("../mails_api/send_mail_api.ts", import.meta.url)), "utf8"
);
const adminSendboxSrc = readFileSync(
    fileURLToPath(new URL("../admin_api/sendbox_api.ts", import.meta.url)), "utf8"
);

test("handleListQuery short-circuits the count query on skipCount", () => {
    const countBranch = commonSrc.slice(
        commonSrc.indexOf("// skipCount 让调用方（如轮询探测）跳过 COUNT(*)"),
        commonSrc.indexOf("if (hiddenFields.length === 0) {"),
    );
    assert.ok(countBranch.includes("options.skipCount"), "skipCount option must guard the count query");
    assert.ok(countBranch.includes("null"), "skipped count must be null, never a fabricated 0");
    assert.ok(countBranch.includes("offset == 0"), "count still only ever runs for the first page");
});

test("sendbox list parses with_count and channel out of the query string", () => {
    assert.ok(
        sendMailSrc.includes("const { source, q, from, to, channel, with_count } = c.req.query();"),
        "user sendbox must parse with_count and channel",
    );
    assert.ok(
        sendMailSrc.includes("withCount: with_count !== \"0\""),
        "with_count defaults to on; only the literal 0 disables counting",
    );
    assert.ok(
        adminSendboxSrc.includes("const { address, limit, offset, source, q, from, to, channel, with_count } = c.req.query();"),
        "admin sendbox must parse with_count and channel",
    );
});

test("querySendboxList forwards skipCount to handleListQuery", () => {
    assert.ok(
        sendMailSrc.includes("{ skipCount: input.withCount === false }"),
        "sendbox list must skip COUNT(*) when with_count=0",
    );
    assert.ok(
        sendMailSrc.includes("count: input.withCount === false ? null : 0"),
        "empty fail-closed probes must still return null count",
    );
});

test("saveSendbox falls back to the 3-column INSERT after a missing-column error", () => {
    assert.ok(
        sendMailSrc.includes("INSERT INTO sendbox (address, raw, source, channel, provider_message_id)"),
        "primary INSERT writes the new columns",
    );
    assert.ok(
        sendMailSrc.includes("INSERT INTO sendbox (address, raw) VALUES (?, ?)"),
        "fallback INSERT must land history on pre-migration D1",
    );
    assert.ok(
        sendMailSrc.includes("/no such column|has no column named/i"),
        "fallback must only run for missing-column errors",
    );
});

test("sent replay still ensures a sendbox row exists", () => {
    assert.ok(sendMailSrc.includes("if (sendMailLimitReservation?.replay === \"sent\")"), "sent replay is handled before returning");
    assert.ok(sendMailSrc.includes("await saveSendboxIfMissing("), "sent replay must try to backfill sendbox");
    assert.ok(sendMailSrc.includes("reservation_id: sendMailLimitReservation.id ?? null"), "reservation id is passed into sendbox");
    assert.ok(
        sendMailSrc.includes("json_extract(raw, '$.reservation_id') = ?"),
        "backfill looks up an existing row by reservation id",
    );
});
