import assert from "node:assert/strict";
import test from "node:test";
import {
  storeOAuthState,
  verifyOAuthState,
  resolveOAuthState,
} from "../unified/oauth_state.ts";

// R3（CRITICAL）：OAuth callback 无条件 require state（fail-closed 防 CSRF 换 code）。
//
// oauth2.ts 依赖 Hono + i18n + utils + models（含无扩展名相对导入），strip-types 下
// 无法直接 import。与 webhook.test.mjs 同一做法：把该 handler 的 state 校验段抽成
// 纯函数 inline（生产代码 oauth2.ts oauth2Login 使用一致的 resolveOAuthState +
// verifyOAuthState 真实实现），逐字对齐覆盖分支：
//  1. 无 state（body 与 query 均缺）→ 拒绝 400
//  2. state 不匹配（KV 无此 state / clientID 不匹配）→ 拒绝 400
//  3. state 有效 + 一次消费 → 通过，二次同 state 拒绝
//  4. state 过期 → 拒绝
//  5. query.state 兜底（body 缺省）→ 通过；旧前端不发 state → 拒绝

// 与 oauth2.ts oauth2Login 的 state 校验段逐字对齐。返回 0=放行，非 0=拒状态码。
async function oauth2CallbackGate(ctx, body, clientID) {
  const state = resolveOAuthState(body && body.state, ctx.queryState);
  if (!state) return 400;
  const valid = await verifyOAuthState(ctx, state, clientID);
  return valid ? 0 : 400;
}

const makeCtx = (mockKV, queryState = undefined) => ({
  env: { KV: mockKV },
  queryState,
});

class MemoryKV {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value, opts) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
}

test("R3: no state in body or query → rejected 400", async () => {
  const ctx = makeCtx(new MemoryKV());
  const r = await oauth2CallbackGate(ctx, { code: "c", clientID: "client_1" }, "client_1");
  assert.equal(r, 400);
});

test("R3: state from URL query works as fallback", async () => {
  const kv = new MemoryKV();
  const ctx = makeCtx(kv, "st_q");
  await storeOAuthState(ctx, "st_q", "client_1");
  // body 缺 state，query 带 state → 兜底放行
  const r = await oauth2CallbackGate(ctx, { code: "c", clientID: "client_1" }, "client_1");
  assert.equal(r, 0);
});

test("R3: state mismatch (nonexistent in KV) → rejected 400", async () => {
  const ctx = makeCtx(new MemoryKV());
  const r = await oauth2CallbackGate(ctx, { code: "c", clientID: "client_1", state: "nope" }, "client_1");
  assert.equal(r, 400);
});

test("R3: state mismatched clientID → rejected 400 (not consumed)", async () => {
  const kv = new MemoryKV();
  const ctx = makeCtx(kv);
  await storeOAuthState(ctx, "st_att", "client_a");
  // 攻击者用另一个 clientID 换 code → 拒绝，且 state 未被消费（正确 clientID 仍可过）
  const r = await oauth2CallbackGate(ctx, { code: "c", clientID: "client_b", state: "st_att" }, "client_b");
  assert.equal(r, 400);
  const ok = await oauth2CallbackGate(ctx, { code: "c", clientID: "client_a", state: "st_att" }, "client_a");
  assert.equal(ok, 0);
});

test("R3: state valid + one-time consume → passes then rejects", async () => {
  const kv = new MemoryKV();
  const ctx = makeCtx(kv);
  await storeOAuthState(ctx, "st_ot", "client_1");
  const first = await oauth2CallbackGate(ctx, { code: "c", clientID: "client_1", state: "st_ot" }, "client_1");
  assert.equal(first, 0);
  // 一次性：二次同 state 拒绝
  const second = await oauth2CallbackGate(ctx, { code: "c", clientID: "client_1", state: "st_ot" }, "client_1");
  assert.equal(second, 400);
});

test("R3: expired state → rejected 400", async () => {
  const kv = new MemoryKV();
  const ctx = makeCtx(kv);
  await storeOAuthState(ctx, "st_exp", "client_1");
  const raw = await kv.get("oauth_state:st_exp");
  const data = JSON.parse(raw);
  data.expires = Date.now() - 1;
  kv.map.set("oauth_state:st_exp", JSON.stringify(data));
  const r = await oauth2CallbackGate(ctx, { code: "c", clientID: "client_1", state: "st_exp" }, "client_1");
  assert.equal(r, 400);
});

test("R3: legacy frontend sends no state → rejected (fail-closed after upgrade)", async () => {
  const kv = new MemoryKV();
  const ctx = makeCtx(kv);
  // 旧前端 callback 只发 {code, clientID}，无 state → 拒绝
  const r = await oauth2CallbackGate(ctx, { code: "c", clientID: "client_1" }, "client_1");
  assert.equal(r, 400);
});

test("R3: resolveOAuthState prioritizes body over query and normalizes empty", () => {
  assert.equal(resolveOAuthState("body-st", "query-st"), "body-st");
  assert.equal(resolveOAuthState(undefined, "query-st"), "query-st");
  assert.equal(resolveOAuthState("", "query-st"), "query-st");
  assert.equal(resolveOAuthState("", ""), "");
  assert.equal(resolveOAuthState(null, undefined), "");
});