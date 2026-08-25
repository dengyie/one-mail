import assert from "node:assert/strict";
import test from "node:test";
import { storeOAuthState, verifyOAuthState } from "./oauth_state.ts";

// H6 回归：OAuth state 后端校验。store 在 login_url 写入 KV（10min TTL），
// callback 提供 state 时 verify（幂等消费，一次性），防 CSRF 换 code。

const makeCtx = (mockKV) => ({ env: { KV: mockKV } });

class MemoryKV {
  constructor() {
    this.map = new Map();
    this.ttl = new Map();
  }
  async get(key) {
    if (!this.map.has(key)) return null;
    return this.map.get(key);
  }
  async put(key, value, opts) {
    this.map.set(key, value);
    if (opts && typeof opts.expirationTtl === "number") this.ttl.set(key, opts.expirationTtl);
  }
  async delete(key) {
    this.map.delete(key);
    this.ttl.delete(key);
  }
  numKeys() {
    return this.map.size;
  }
}

test("storeOAuthState + verifyOAuthState roundtrip", async () => {
  const kv = new MemoryKV();
  const c = makeCtx(kv);
  assert.equal(await storeOAuthState(c, "st_abc", "client_1"), true);
  // 存入 KV，key 带前缀
  assert.equal(kv.numKeys(), 1);
  assert.equal(kv.ttl.get("oauth_state:st_abc"), Math.ceil((10 * 60 * 1000) / 1000) + 30);
  // verify 匹配
  assert.equal(await verifyOAuthState(c, "st_abc", "client_1"), true);
});

test("verifyOAuthState is one-time (consumed after first verify)", async () => {
  const kv = new MemoryKV();
  const c = makeCtx(kv);
  await storeOAuthState(c, "st_ot", "client_1");
  assert.equal(await verifyOAuthState(c, "st_ot", "client_1"), true);
  // 二次 verify 应为 false：已消费删除
  assert.equal(await verifyOAuthState(c, "st_ot", "client_1"), false);
  assert.equal(kv.numKeys(), 0);
});

test("verifyOAuthState with wrong clientID → false (and state NOT consumed)", async () => {
  const kv = new MemoryKV();
  const c = makeCtx(kv);
  await storeOAuthState(c, "st_attacker", "client_a");
  // 攻击者用另一个 clientID 尝试换 code → 拒绝
  assert.equal(await verifyOAuthState(c, "st_attacker", "client_b"), false);
  // 不匹配时不消费：正确 clientID 之后仍可校验通过
  assert.equal(await verifyOAuthState(c, "st_attacker", "client_a"), true);
});

test("verifyOAuthState with non-existent state → false", async () => {
  const c = makeCtx(new MemoryKV());
  assert.equal(await verifyOAuthState(c, "nope", "client_1"), false);
});

test("verifyOAuthState with expired state → false (TTL 兜底 + expires 校验)", async () => {
  const kv = new MemoryKV();
  const c = makeCtx(kv);
  await storeOAuthState(c, "st_exp", "client_1");
  // 手动把 expires 拨到过去，验证服务端超时拒绝（模拟 KV 未按 TTL 清掉的情形）
  const raw = await kv.get("oauth_state:st_exp");
  const data = JSON.parse(raw);
  data.expires = Date.now() - 1;
  kv.map.set("oauth_state:st_exp", JSON.stringify(data));
  assert.equal(await verifyOAuthState(c, "st_exp", "client_1"), false);
});

test("no KV binding → verify fail-closed (false)", async () => {
  const c = makeCtx(null);
  assert.equal(await verifyOAuthState(c, "st", "client_1"), false);
});

test("no KV binding → store returns false (state 不落库)", async () => {
  const c = makeCtx(null);
  assert.equal(await storeOAuthState(c, "st", "client_1"), false);
});

test("KV error → fail-closed (verify false, store false)", async () => {
  const throwingKV = {
    async get() { throw new Error("kv down"); },
    async put() { throw new Error("kv down"); },
    async delete() { throw new Error("kv down"); },
  };
  const c = makeCtx(throwingKV);
  assert.equal(await storeOAuthState(c, "st", "client_1"), false);
  assert.equal(await verifyOAuthState(c, "st", "client_1"), false);
});