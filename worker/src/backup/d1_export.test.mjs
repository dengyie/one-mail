import assert from "node:assert/strict";
import test from "node:test";
import {
    D1_EXPORT_MAX_POLLS,
    createD1Export,
    d1ExportEndpoint,
    exportD1ToBucket,
    waitForD1Export,
} from "./d1_export.ts";

const config = {
    accountId: "0123456789abcdef0123456789abcdef",
    databaseId: "5f3e1c0a-9b2d-4e7a-8c61-1d2e3f4a5b6c",
    token: "secret-token",
};

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

test("endpoint targets the configured account and database", () => {
    assert.equal(
        d1ExportEndpoint(config),
        "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef"
            + "/d1/database/5f3e1c0a-9b2d-4e7a-8c61-1d2e3f4a5b6c/export",
    );
});

test("createD1Export posts the polling format and returns the bookmark", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ success: true, result: { at_bookmark: "bookmark-1" } });
    };
    const bookmark = await createD1Export(config, { fetch: fetchImpl });
    assert.equal(bookmark, "bookmark-1");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.authorization, "Bearer secret-token");
    assert.deepEqual(JSON.parse(calls[0].init.body), { output_format: "polling" });
});

test("createD1Export surfaces non-JSON and API errors", async () => {
    await assert.rejects(
        () => createD1Export(config, { fetch: async () => new Response("<html>", { status: 502 }) }),
        /non-JSON/,
    );
    await assert.rejects(
        () => createD1Export(config, {
            fetch: async () => jsonResponse({ success: false, errors: [{ message: "nope" }] }),
        }),
        /nope/,
    );
    await assert.rejects(
        () => createD1Export(config, { fetch: async () => jsonResponse({ success: true, result: {} }) }),
        /at_bookmark/,
    );
});

test("waitForD1Export polls with POST and a current_bookmark body", async () => {
    const calls = [];
    const responses = [
        { success: true, result: { status: "active", at_bookmark: "b2" } },
        { success: true, result: { status: "active", at_bookmark: "b3" } },
        {
            success: true,
            result: {
                status: "complete",
                result: { signed_url: "https://download.example/dump.sql" },
            },
        },
    ];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(responses.shift());
    };
    const url = await waitForD1Export(config, "b1", {
        fetch: fetchImpl,
        sleep: async () => {},
    });
    assert.equal(url, "https://download.example/dump.sql");
    assert.equal(calls.length, 3);
    for (const call of calls) {
        // A GET is rejected with 405 by the real API, so every poll must POST.
        assert.equal(call.init.method, "POST");
        assert.equal(call.url, d1ExportEndpoint(config));
        assert.equal(call.init.headers["content-type"], "application/json");
    }
    assert.equal(JSON.parse(calls[0].init.body).current_bookmark, "b1");
    assert.equal(JSON.parse(calls[1].init.body).current_bookmark, "b2");
    assert.equal(JSON.parse(calls[2].init.body).current_bookmark, "b3");
});

test("waitForD1Export reads the download url from the nested result", async () => {
    // The completion payload nests the download url two levels deep; a top-level
    // `signed_url` is ignored because the API never sends one there.
    const fetchImpl = async () => jsonResponse({
        success: true,
        result: {
            status: "complete",
            signed_url: "https://wrong.example/top-level.sql",
            result: { signed_url: "https://right.example/dump.sql" },
        },
    });
    const url = await waitForD1Export(config, "b1", { fetch: fetchImpl, sleep: async () => {} });
    assert.equal(url, "https://right.example/dump.sql");
});

test("waitForD1Export surfaces an error status", async () => {
    const fetchImpl = async () => jsonResponse({
        success: true,
        result: { status: "error", error: "export cancelled" },
    });
    await assert.rejects(
        () => waitForD1Export(config, "b1", { fetch: fetchImpl, sleep: async () => {} }),
        /export cancelled/,
    );
});

test("waitForD1Export rejects a complete status without a signed url", async () => {
    const fetchImpl = async () => jsonResponse({
        success: true,
        result: { status: "complete", result: {} },
    });
    await assert.rejects(
        () => waitForD1Export(config, "b1", { fetch: fetchImpl, sleep: async () => {} }),
        /without a signed_url/,
    );
});

test("the poll budget fits the free-plan subrequest ceiling", () => {
    // create + polls + download must stay under 50 subrequests per invocation.
    assert.ok(
        D1_EXPORT_MAX_POLLS + 2 <= 50,
        `poll budget ${D1_EXPORT_MAX_POLLS} + 2 exceeds the 50-subrequest free plan limit`,
    );
});

test("waitForD1Export gives up after maxPolls", async () => {
    const fetchImpl = async () => jsonResponse({ success: true, result: {} });
    await assert.rejects(
        () => waitForD1Export(config, "b1", { fetch: fetchImpl, sleep: async () => {}, maxPolls: 3 }),
        /did not finish/,
    );
});

test("waitForD1Export does not sleep after the final poll", async () => {
    const fetchImpl = async () => jsonResponse({ success: true, result: {} });
    let sleeps = 0;
    await assert.rejects(
        () => waitForD1Export(config, "b1", {
            fetch: fetchImpl,
            sleep: async () => { sleeps += 1; },
            maxPolls: 3,
        }),
        /did not finish/,
    );
    assert.equal(sleeps, 2, "only the polls that precede another attempt may sleep");
});

test("exportD1ToBucket streams the download into the bucket", async () => {
    const uploaded = [];
    const bucket = {
        put: async (key, body) => {
            uploaded.push({ key, body });
            return { size: 1234 };
        },
    };
    const responses = [
        jsonResponse({ success: true, result: { at_bookmark: "b1" } }),
        jsonResponse({
            success: true,
            result: { status: "complete", result: { signed_url: "https://download.example/dump.sql" } },
        }),
        new Response("CREATE TABLE t (id INTEGER);", { status: 200 }),
    ];
    const deps = {
        fetch: async (url) => {
            if (url === "https://download.example/dump.sql") return responses.pop();
            return responses.shift();
        },
        sleep: async () => {},
    };
    const bytes = await exportD1ToBucket({ ...config, bucket }, "d1/daily/2026-11-07.sql", deps);
    assert.equal(bytes, 1234);
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].key, "d1/daily/2026-11-07.sql");
    assert.ok(uploaded[0].body);
});

test("exportD1ToBucket rejects a failed download without writing", async () => {
    let putCalled = false;
    const bucket = { put: async () => { putCalled = true; return { size: 0 }; } };
    const responses = [
        jsonResponse({ success: true, result: { at_bookmark: "b1" } }),
        jsonResponse({
            success: true,
            result: { status: "complete", result: { signed_url: "https://download.example/dump.sql" } },
        }),
    ];
    const deps = {
        fetch: async (url) => {
            if (url === "https://download.example/dump.sql") return new Response("", { status: 500 });
            return responses.shift();
        },
        sleep: async () => {},
    };
    await assert.rejects(
        () => exportD1ToBucket({ ...config, bucket }, "d1/daily/2026-11-07.sql", deps),
        /download failed/,
    );
    assert.equal(putCalled, false);
});