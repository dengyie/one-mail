import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { attachmentKey } from "./attachments.ts";
import { attachmentDownloadRateLimit, downloadAttachment, uploadAttachment } from "./attachment_routes.ts";

const token = "t".repeat(32);
const storageEnv = { ATTACHMENT_STORAGE_URL: "https://storage.example/_one_mail_attachment_storage", ATTACHMENT_STORAGE_TOKEN: token };

function appFor(handler, method, path) {
  const app = new Hono();
  app.use("/*", async (c, next) => {
    c.set("unifiedUserAuth", { isAdmin: true, userPayload: null, userRole: "admin" });
    await next();
  });
  app[method](path, handler);
  return app;
}

test("download rechecks attachment membership and proxies safe content headers", async () => {
  const key = await attachmentKey("account-a", "mail-a", "att-1");
  const app = appFor(downloadAttachment, "get", "/emails/:id/attachments/:attachmentId");
  const env = {
    ...storageEnv,
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ account_id: "account-a", attachments_json: JSON.stringify([{ id: "att-1", name: "报告.txt", size: 2, mimeType: "text/plain", storage_key: key }]) }) }) }) },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), new RegExp(`/unified/${key.slice(8)}$`));
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    return new Response("ok", { headers: { "content-length": "2", "content-type": "text/plain" } });
  };
  try {
    const response = await app.request("/emails/mail-a/attachments/att-1", {}, env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upload is bounded and returns the deterministic storage key", async () => {
  const requests = [];
  const app = appFor(uploadAttachment, "put", "/attachments/:accountId/:emailId/:attachmentId");
  const env = {
    ...storageEnv,
    DB: { prepare: sql => ({ bind: (...params) => ({ run: async () => { requests.push({ sql, params }); return { meta: { changes: 1 } }; } }) }) },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init, body: await new Response(init.body).bytes() });
    return new Response(null, { status: 204 });
  };
  try {
    const response = await app.request("/attachments/account-a/mail-a/att-1", { method: "PUT", headers: { "content-length": "2", "x-one-mail-name": "x.txt", "x-one-mail-mime-type": "text/plain" }, body: "ok" }, env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).storage_key, await attachmentKey("account-a", "mail-a", "att-1"));
    const upload = requests.find(entry => entry.body);
    assert.deepEqual(upload.body, new Uint8Array([111, 107]));
    assert.equal(new Headers(upload.init.headers).get("content-length"), "2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upload rejects bodies without content-length before storage access", async () => {
  let fetchCalled = false;
  const app = appFor(uploadAttachment, "put", "/attachments/:accountId/:emailId/:attachmentId");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return new Response(null, { status: 204 }); };
  try {
    const response = await app.request("/attachments/account-a/mail-a/att-1", { method: "PUT", body: new Uint8Array([1]) }, { ...storageEnv, DB: { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }) } });
    assert.equal(response.status, 411);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upload rejects a body that exceeds the declared content length before storage access", async () => {
  const env = {
    ...storageEnv,
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }) },
  };
  const context = {
    env,
    req: {
      raw: {
        headers: new Headers({ "content-length": "1" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([111, 107]));
            controller.close();
          },
        }),
        signal: new AbortController().signal,
      },
      param(name) {
        return ({ accountId: "account-a", emailId: "mail-a", attachmentId: "att-1" })[name];
      },
    },
    json(body, status) {
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    await new Response(init.body).arrayBuffer();
    return new Response(null, { status: 204 });
  };
  try {
    const response = await uploadAttachment(context);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "content-length mismatch" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upload rejects a generic 200 fallback response from a missing storage proxy", async () => {
  const app = appFor(uploadAttachment, "put", "/attachments/:accountId/:emailId/:attachmentId");
  const env = {
    ...storageEnv,
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }) },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<!doctype html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  try {
    const response = await app.request("/attachments/account-a/mail-a/att-1", {
      method: "PUT",
      headers: { "content-length": "2" },
      body: "ok",
    }, env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "30");
    assert.deepEqual(await response.json(), { error: "attachment storage unavailable" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("attachment download rate limit is keyed to the authenticated principal", async () => {
  let rateKey;
  const app = new Hono();
  app.use("/*", async (c, next) => {
    c.set("unifiedUserAuth", { isAdmin: false, userPayload: { user_id: "user-7" }, userRole: "user" });
    await next();
  });
  app.get("/download", attachmentDownloadRateLimit, c => c.text("ok"));
  const limited = await app.request("/download", { headers: { "cf-connecting-ip": "203.0.113.4" } }, {
    RATE_LIMITER: { limit: async ({ key }) => { rateKey = key; return { success: false }; } },
  });
  assert.equal(limited.status, 429);
  assert.match(rateKey, /user:user-7/);
  assert.equal(limited.headers.get("retry-after"), "60");
});

test("download stream enforces the storage byte limit even with a forged content length", async () => {
  const key = await attachmentKey("account-a", "mail-a", "att-1");
  const app = appFor(downloadAttachment, "get", "/emails/:id/attachments/:attachmentId");
  const env = {
    ...storageEnv,
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ account_id: "account-a", attachments_json: JSON.stringify([{ id: "att-1", size: 1, name: "x", mimeType: "text/plain", storage_key: key }]) }) }) }) },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(30 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  }), { headers: { "content-length": String(30 * 1024 * 1024) } });
  try {
    const response = await app.request("/emails/mail-a/attachments/att-1", {}, env);
    assert.equal(response.status, 200);
    await assert.rejects(() => response.arrayBuffer());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("download stream rejects a truncated storage response", async () => {
  const key = await attachmentKey("account-a", "mail-a", "att-1");
  const app = appFor(downloadAttachment, "get", "/emails/:id/attachments/:attachmentId");
  const env = {
    ...storageEnv,
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ account_id: "account-a", attachments_json: JSON.stringify([{ id: "att-1", size: 5, name: "x", mimeType: "text/plain", storage_key: key }]) }) }) }) },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.close();
    },
  }), { headers: { "content-length": "5" } });
  try {
    const response = await app.request("/emails/mail-a/attachments/att-1", {}, env);
    assert.equal(response.status, 200);
    await assert.rejects(() => response.arrayBuffer(), /attachment unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("download stream rejects a storage response longer than its declared length", async () => {
  const key = await attachmentKey("account-a", "mail-a", "att-1");
  const app = appFor(downloadAttachment, "get", "/emails/:id/attachments/:attachmentId");
  const env = {
    ...storageEnv,
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ account_id: "account-a", attachments_json: JSON.stringify([{ id: "att-1", size: 2, name: "x", mimeType: "text/plain", storage_key: key }]) }) }) }) },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  }), { headers: { "content-length": "2" } });
  try {
    const response = await app.request("/emails/mail-a/attachments/att-1", {}, env);
    assert.equal(response.status, 200);
    await assert.rejects(() => response.arrayBuffer(), /attachment unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
