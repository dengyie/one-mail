import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { attachmentKey } from "./attachments.ts";
import { attachmentDownloadRateLimit, downloadAttachment, uploadAttachment } from "./attachment_routes.ts";

function appFor(handler, method, path) {
  const app = new Hono();
  app.use("/*", async (c, next) => {
    c.set("unifiedUserAuth", { isAdmin: true, userPayload: null, userRole: "admin" });
    await next();
  });
  app[method](path, handler);
  return app;
}

test("download rechecks attachment membership and returns safe content headers", async () => {
  const key = await attachmentKey("account-a", "mail-a", "att-1");
  const app = appFor(downloadAttachment, "get", "/emails/:id/attachments/:attachmentId");
  const env = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ account_id: "account-a", attachments_json: JSON.stringify([{ id: "att-1", name: "报告.txt", size: 2, mimeType: "text/plain", r2_key: key }]) }) }) }) },
    ATTACHMENTS: { get: async requested => requested === key ? { body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("ok")); c.close(); } }), size: 2, httpMetadata: { contentType: "text/plain" } } : null },
  };
  const response = await app.request("/emails/mail-a/attachments/att-1", {}, env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("upload is bounded and returns the deterministic object key", async () => {
  const writes = [];
  const app = appFor(uploadAttachment, "put", "/attachments/:accountId/:emailId/:attachmentId");
  const env = {
    DB: { prepare: sql => ({ bind: (...params) => ({ run: async () => { writes.push({ sql, params }); return { meta: { changes: 1 } }; } }) }) },
    ATTACHMENTS: { put: async (key, body) => { writes.push({ key, body }); writes.push({ uploaded: await new Response(body).bytes() }); } },
  };
  const response = await app.request("/attachments/account-a/mail-a/att-1", { method: "PUT", headers: { "content-length": "2", "x-one-mail-name": "x.txt", "x-one-mail-mime-type": "text/plain" }, body: "ok" }, env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).r2_key, await attachmentKey("account-a", "mail-a", "att-1"));
  assert.equal(writes.find(entry => entry.body)?.body instanceof ReadableStream, true);
  assert.deepEqual(writes.find(entry => entry.uploaded)?.uploaded, new Uint8Array([111, 107]));
});

test("upload cancels and rejects a chunked body that exceeds the limit", async () => {
  let putCalled = false;
  const app = appFor(uploadAttachment, "put", "/attachments/:accountId/:emailId/:attachmentId");
  const env = {
    DB: { prepare: sql => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }) },
    ATTACHMENTS: { put: async (_key, body) => { putCalled = true; await new Response(body).bytes(); } },
  };
  const oversized = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(30 * 1024 * 1024));
    controller.enqueue(new Uint8Array([1]));
    controller.close();
  } });
  const response = await app.request("/attachments/account-a/mail-a/att-1", {
    method: "PUT", body: oversized, duplex: "half", headers: { "x-one-mail-mime-type": "application/octet-stream" },
  }, env);
  assert.equal(response.status, 413);
  assert.equal(putCalled, true);
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
