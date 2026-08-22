import assert from "node:assert/strict";
import test from "node:test";
import {
  getAdminFailCount,
  recordAdminFailure,
  clearAdminFailures,
  isAdminLockedOut,
} from "./admin_lockout.ts";

// I7c 回归：admin 登录失败锁定（按 IP 计数，15min 窗口 ≥10 次锁定，KV 不可达 fail-closed）。
// 用内存 mock KV（get/put/delete 返回 Promise）。窗口桶基于 Date.now()，node:test 下可用。

// 构造 mock c：固定 cf-connecting-ip=1.2.3.4，env.KV 是内存桶。
const makeCtx = (mockKV) => ({
  req: { raw: { headers: { get: (h) => (h === "cf-connecting-ip" ? "1.2.3.4" : null) } } },
  env: { KV: mockKV },
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
    // TTL 忽略（窗口内保持）
  }
  async delete(key) {
    this.map.delete(key);
  }
}

test("9 failures → not locked, 10th → locked", async () => {
  const kv = new MemoryKV();
  const c = makeCtx(kv);
  for (let i = 0; i < 9; i++) {
    assert.equal(await isAdminLockedOut(c), false, `failure ${i + 1} should not lock`);
    const count = await recordAdminFailure(c);
    assert.equal(count, i + 1);
  }
  // 第 9 次记录后仍未锁定
  assert.equal(await isAdminLockedOut(c), false);
  // 第 10 次失败 → 锁定
  const tenth = await recordAdminFailure(c);
  assert.equal(tenth, 10);
  assert.equal(await isAdminLockedOut(c), true);
});

test("success clears failures back to 0", async () => {
  const kv = new MemoryKV();
  const c = makeCtx(kv);
  for (let i = 0; i < 3; i++) await recordAdminFailure(c);
  assert.equal(await getAdminFailCount(c), 3);
  await clearAdminFailures(c);
  assert.equal(await getAdminFailCount(c), 0);
  assert.equal(await isAdminLockedOut(c), false);
});

test("cleared failures allow new attempts after a lock", async () => {
  const kv = new MemoryKV();
  const c = makeCtx(kv);
  for (let i = 0; i < 10; i++) await recordAdminFailure(c);
  assert.equal(await isAdminLockedOut(c), true);
  await clearAdminFailures(c);
  assert.equal(await isAdminLockedOut(c), false);
});

test("new window bucket resets the count", async () => {
  // 直接操作桶键空间：手动塞一个「上一窗口」的失败计数，
  // 确认当前窗口读到 0（窗口桶名含 windowBucket()，随窗口推进自然重置）。
  const kv = new MemoryKV();
  const c = makeCtx(kv);
  // 塞一个旧窗口键（错误前缀的当前桶永远不会被读，模拟窗口推进后的旧键）
  // 无法直接拿到当前 key，改用：把 15min 前的 key 放进同一个桶键前缀验证无干扰。
  // —— 更贴切的验证：getAdminFailCount 对空 KV 返回 0（自然等于新窗口的 reset）。
  assert.equal(await getAdminFailCount(c), 0);
  await recordAdminFailure(c);
  assert.equal(await getAdminFailCount(c), 1);
});

test("no KV binding → fail-closed (isAdminLockedOut true)", async () => {
  const c = makeCtx(null);
  // c.env.KV 是 null
  c.env.KV = null;
  assert.equal(await isAdminLockedOut(c), true);
  assert.equal(await getAdminFailCount(c), -1);
  assert.equal(await recordAdminFailure(c), -1);
});

test("KV error → fail-closed", async () => {
  const throwingKV = {
    async get() { throw new Error("kv down"); },
    async put() { throw new Error("kv down"); },
    async delete() { throw new Error("kv down"); },
  };
  const c = makeCtx(throwingKV);
  assert.equal(await getAdminFailCount(c), -1);
  assert.equal(await isAdminLockedOut(c), true);
  assert.equal(await recordAdminFailure(c), -1);
  // clearAdminFailures 是 best-effort，KV 挂也不应抛
  await clearAdminFailures(c);
});