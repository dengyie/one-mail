import assert from "node:assert/strict";
import test from "node:test";
import { uploadAttachmentObject } from "./storage_client.ts";

const env = {
  ATTACHMENT_STORAGE_URL: "https://storage.example/_one_mail_attachment_storage",
  ATTACHMENT_STORAGE_TOKEN: "t".repeat(32),
};

test("unexpected storage responses abort the in-flight request after cancelling the body", async () => {
  let requestSignal;
  let responseBodyCancelled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requestSignal = init.signal;
    return new Response(new ReadableStream({ cancel() { responseBodyCancelled = true; } }), { status: 200 });
  };
  try {
    await assert.rejects(
      uploadAttachmentObject(env, `unified/${"a".repeat(43)}`, new Uint8Array([1]), 1, "application/octet-stream", "x"),
      /attachment storage request failed/,
    );
    assert.equal(responseBodyCancelled, true);
    assert.equal(requestSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
