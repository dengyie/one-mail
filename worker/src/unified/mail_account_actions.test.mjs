import assert from "node:assert/strict";
import test from "node:test";
import { unsupportedMailAccountAction } from "./mail_account_actions.ts";

test("unsupported action responses are explicit and never queued", () => {
  const testResult = unsupportedMailAccountAction("connection_test", "a1");
  assert.deepEqual(testResult, {
    status: "unsupported",
    code: "worker_connection_test_unavailable",
    message: "Connection testing is not available on the Worker yet.",
    account_id: "a1",
  });
  const syncResult = unsupportedMailAccountAction("sync", "a1");
  assert.equal(syncResult.status, "unsupported");
  assert.equal(syncResult.code, "worker_sync_dispatch_unavailable");
  assert.equal(syncResult.queued, undefined);
});
