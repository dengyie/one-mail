import assert from "node:assert/strict";
import test from "node:test";
import { runPostIngest } from "./post_ingest.ts";

const env = {};

function params(overrides = {}) {
    const parsedEmailContext = { rawEmail: "Subject: hi\r\n\r\nhello", ...overrides };
    return {
        rawEmail: parsedEmailContext.rawEmail,
        from: "a@example.com",
        toAddress: "box@mangoqwq.com",
        messageId: "<id@example.com>",
        headers: new Headers({ "message-id": "<id@example.com>" }),
        parsedEmailContext,
    };
}

function recorder() {
    const calls = [];
    return {
        calls,
        deps: {
            extractEmailInfo: async (...args) => {
                calls.push(["extract", args[1], args[2], args[3]]);
                return { code: "123456" };
            },
            sendMailToTelegram: async (...args) => {
                calls.push(["telegram", args[1], args[4]?.code ?? null]);
            },
            triggerWebhook: async (...args) => {
                calls.push(["webhook", args[1], args[4]?.code ?? null]);
            },
            commonParseMail: async () => ({ text: "plain body" }),
            triggerAnotherWorker: async (_c, mail, text) => {
                calls.push(["rpc", mail.to, text]);
            },
        },
    };
}

test("runs all post-ingest side effects with the extracted result", async () => {
    const { calls, deps } = recorder();
    await runPostIngest(env, params(), deps);
    assert.deepEqual(calls.map((call) => call[0]), ["extract", "telegram", "webhook", "rpc"]);
    assert.equal(calls[1][2], "123456");
    assert.equal(calls[2][2], "123456");
    assert.equal(calls[3][2], "plain body");
});

test("ai extraction failure does not block telegram or webhook", async () => {
    const { calls, deps } = recorder();
    deps.extractEmailInfo = async () => {
        throw new Error("ai down");
    };
    await runPostIngest(env, params(), deps);
    assert.deepEqual(calls.map((call) => call[0]), ["telegram", "webhook", "rpc"]);
    assert.equal(calls[0][2], null);
});

test("telegram failure does not block webhook or peer fan-out", async () => {
    const { calls, deps } = recorder();
    deps.sendMailToTelegram = async () => {
        throw new Error("telegram down");
    };
    await runPostIngest(env, params(), deps);
    assert.deepEqual(calls.map((call) => call[0]), ["extract", "webhook", "rpc"]);
});

test("parse failure still fans out with an empty text body", async () => {
    const { calls, deps } = recorder();
    deps.commonParseMail = async () => {
        throw new Error("parse failed");
    };
    await runPostIngest(env, params(), deps);
    assert.deepEqual(calls.map((call) => call[0]), ["extract", "telegram", "webhook"]);
});

test("never rejects even when every dependency fails", async () => {
    const { deps } = recorder();
    for (const key of Object.keys(deps)) {
        deps[key] = async () => {
            throw new Error(`${key} failed`);
        };
    }
    await assert.doesNotReject(() => runPostIngest(env, params(), deps));
});
