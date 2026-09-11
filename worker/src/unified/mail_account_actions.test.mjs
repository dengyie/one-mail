import assert from "node:assert/strict";
import test from "node:test";
import { unsupportedMailAccountAction, mergeRotatedRefreshToken } from "./mail_account_actions.ts";

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

test("mergeRotatedRefreshToken keeps other oauth fields and swaps refresh_token", () => {
  const merged = mergeRotatedRefreshToken(
    JSON.stringify({ provider: "msa", client_id: "cid", refresh_token: "OLD" }), "NEW");
  assert.equal(merged.ok, true);
  const oauth = JSON.parse(merged.oauthJson);
  assert.equal(oauth.refresh_token, "NEW");
  assert.equal(oauth.provider, "msa", "其它 oauth 字段不得丢失");
  assert.equal(oauth.client_id, "cid");
});

test("mergeRotatedRefreshToken fails closed on missing/corrupt/non-object oauth", () => {
  assert.deepEqual(mergeRotatedRefreshToken(null, "NEW"), { ok: false, reason: "no_oauth" });
  assert.deepEqual(mergeRotatedRefreshToken("", "NEW"), { ok: false, reason: "no_oauth" });
  assert.deepEqual(mergeRotatedRefreshToken("not-json{{{", "NEW"), { ok: false, reason: "corrupt_oauth" });
  assert.deepEqual(mergeRotatedRefreshToken('["a"]', "NEW"), { ok: false, reason: "not_object" });
  assert.deepEqual(mergeRotatedRefreshToken('"str"', "NEW"), { ok: false, reason: "not_object" });
});

test("mergeRotatedRefreshToken accepts oauth with extra unknown fields", () => {
  const merged = mergeRotatedRefreshToken(
    JSON.stringify({ provider: "graph", tenant: "consumers", client_id: "c", refresh_token: "O", scope: "x" }),
    "N");
  assert.equal(merged.ok, true);
  const oauth = JSON.parse(merged.oauthJson);
  assert.equal(oauth.tenant, "consumers");
  assert.equal(oauth.refresh_token, "N");
});
