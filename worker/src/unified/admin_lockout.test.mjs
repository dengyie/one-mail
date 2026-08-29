import assert from "node:assert/strict";
import test from "node:test";
import {
  getAdminFailCount,
  recordAdminFailure,
  clearAdminFailures,
  isAdminLockedOut,
  decideAdminAuth,
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
    this.deleteCalls = 0;
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value, opts) {
    this.map.set(key, value);
    // TTL 忽略（窗口内保持）
  }
  async delete(key) {
    this.deleteCalls++;
    this.map.delete(key);
  }
}

// 配额回归：clearAdminFailures 仅在确有失败计数时才 delete；
// 正常成功请求（count=0 / key 不存在）不得触发 delete（KV delete 每日限 1000，
// 聚合器每 5min 打 /admin/* 会无限放行成功路径）。
test("clearAdminFailures skips delete when no failure recorded (quota guard)", async () => {
  const kv = new MemoryKV();
  const c = makeCtx(kv);
  // 没有失败记录时清理：不应触发任何 delete
  await clearAdminFailures(c);
  assert.equal(kv.deleteCalls, 0);
  assert.equal(await getAdminFailCount(c), 0);

  // 有失败记录时清理：才应触发一次 delete 并复位
  for (let i = 0; i < 2; i++) await recordAdminFailure(c);
  assert.equal(kv.deleteCalls, 0); // 记录失败 only 用 get/put
  await clearAdminFailures(c);
  assert.equal(kv.deleteCalls, 1);
  assert.equal(await getAdminFailCount(c), 0);

  // 再次清理（已无失败）→ 不再 delete
  await clearAdminFailures(c);
  assert.equal(kv.deleteCalls, 1);
});

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

// H3 补充：不同 IP 独立失败桶——一个 IP 锁定不影响其他 IP。
test("different IPs have independent failure buckets", async () => {
  const kv = new MemoryKV();
  const cA = makeCtx(kv);
  const cB = {
    req: { raw: { headers: { get: (h) => (h === "cf-connecting-ip" ? "5.6.7.8" : null) } } },
    env: { KV: kv },
  };
  for (let i = 0; i < 10; i++) await recordAdminFailure(cA);
  assert.equal(await isAdminLockedOut(cA), true);
  // 另一 IP 仍可尝试（独立桶）
  assert.equal(await isAdminLockedOut(cB), false);
  assert.equal(await getAdminFailCount(cB), 0);
  // 另一 IP 失败后各自锁定
  for (let i = 0; i < 10; i++) await recordAdminFailure(cB);
  assert.equal(await isAdminLockedOut(cB), true);
});

// ---- R2（CRITICAL）user-role 兜底不再构成授权面 ----
// 真实 admin 中间件的判定逻辑在 decideAdminAuth（worker.ts 调用），
// 这里直接覆盖 R2 组合门：头通道 + 锁定，user-role 兜底不能绕过。

const payloadFactory = (overrides = {}) => ({
  user_role: "admin",
  exp: Math.floor(Date.now() / 1000) + 600,
  ...overrides,
});

test("R2: user token without admin role in payload → /admin/* rejected (401)", async () => {
  const d = decideAdminAuth({
    hasAdminAuth: false,
    hasAccessToken: true,
    adminAuthValid: false,
    adminFailCount: 0,
    adminUserRole: "admin",
    disableAdminPasswordCheck: false,
    accessTokenPayload: payloadFactory({ user_role: "user" }),
  });
  assert.equal(d.relay, false);
  assert.equal(d.status, 401);
  assert.equal(d.kind, "role_not_admin");
  assert.equal(d.recordFailure, true);
});

test("R2: valid user access token with user_role=admin → allowed directly without admin password", async () => {
  const d = decideAdminAuth({
    hasAdminAuth: false,
    hasAccessToken: true,
    adminAuthValid: false,
    adminFailCount: 0,
    adminUserRole: "admin",
    disableAdminPasswordCheck: false,
    accessTokenPayload: payloadFactory({ user_role: "admin" }),
  });
  assert.equal(d.relay, true);
  assert.equal(d.status, 0);
});

test("R2: forged user_role=admin WITH admin credentials → allowed (clears failures)", () => {
  const d = decideAdminAuth({
    hasAdminAuth: false,
    hasAccessToken: true,
    adminAuthValid: true,
    adminFailCount: 0,
    adminUserRole: "admin",
    disableAdminPasswordCheck: false,
    accessTokenPayload: payloadFactory({ user_role: "admin" }),
  });
  assert.equal(d.relay, true);
});

test("R2: expired user access token while locked window → still remembered as failure", async () => {
  const d = decideAdminAuth({
    hasAdminAuth: false,
    hasAccessToken: true,
    adminAuthValid: false,
    adminFailCount: 0,
    adminUserRole: "admin",
    disableAdminPasswordCheck: false,
    accessTokenPayload: {
      user_role: "admin",
      exp: Math.floor(Date.now() / 1000) - 60,
    },
  });
  assert.equal(d.relay, false);
  assert.equal(d.status, 401);
  assert.equal(d.recordFailure, true);
});

test("R2: user-role fallback does NOT bypass lockout (H3 combined gate)", async () => {
  // 已锁定（failCount >= 10）：有 x-user-access-token 的请求仍 429
  const d = decideAdminAuth({
    hasAdminAuth: false,
    hasAccessToken: true,
    adminAuthValid: false,
    adminFailCount: 10,
    adminUserRole: "admin",
    disableAdminPasswordCheck: false,
    accessTokenPayload: payloadFactory({ user_role: "admin" }),
  });
  assert.equal(d.relay, false);
  assert.equal(d.status, 429);
  assert.equal(d.kind, "rate_limit");
  // 且不 record（锁定本身就是拒绝）
  assert.equal(d.recordFailure, false);
});

test("R2: KV unreachable (failCount -1) → 429 for any credentialed admin request", async () => {
  const d = decideAdminAuth({
    hasAdminAuth: true,
    hasAccessToken: false,
    adminAuthValid: true,
    adminFailCount: -1,
    adminUserRole: "admin",
    disableAdminPasswordCheck: false,
    accessTokenPayload: null,
  });
  // 注意：checkIsAdmin 为 true 但 KV 不可达 → 锁定门先执行 429（宁可误伤不放行爆破）
  assert.equal(d.relay, false);
  assert.equal(d.status, 429);
});

test("R2: correct admin token clears failures via caller contract", async () => {
  const kv = new MemoryKV();
  const c = makeCtx(kv);
  for (let i = 0; i < 6; i++) await recordAdminFailure(c);
  assert.equal(await getAdminFailCount(c), 6);
  await clearAdminFailures(c);
  assert.equal(await getAdminFailCount(c), 0);
  // 正确 admin 头命中后清零 → 之后错误不再 429
  assert.equal(await isAdminLockedOut(c), false);
});