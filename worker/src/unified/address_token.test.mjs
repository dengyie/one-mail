import assert from "node:assert/strict";
import test from "node:test";
import { addressJwtExpSeconds } from "./address_token.ts";

// I7a 回归：地址 JWT exp 时长。函数只读 c.env.ADDRESS_JWT_TTL_DAYS，
// mock 最小 context。// 时间窗宽松，避免 CI 亚毫秒抖动。

const daySec = 86400;

test("no env → ~now+90d", () => {
  const before = Math.floor(Date.now() / 1000);
  const exp = addressJwtExpSeconds({ env: {} });
  const after = Math.floor(Date.now() / 1000);
  // 90 天窗口内（上下各容差 2s）
  assert.ok(Math.abs(exp - (before + 90 * daySec)) <= 2, `exp=${exp} before=${before}`);
  assert.ok(exp <= after + 90 * daySec + 2);
});

test("ADDRESS_JWT_TTL_DAYS=30 → ~now+30d", () => {
  const before = Math.floor(Date.now() / 1000);
  const exp = addressJwtExpSeconds({ env: { ADDRESS_JWT_TTL_DAYS: 30 } });
  assert.ok(Math.abs(exp - (before + 30 * daySec)) <= 2, `exp=${exp}`);
});

test('ADDRESS_JWT_TTL_DAYS="abc" (invalid) → falls back to 90d', () => {
  const before = Math.floor(Date.now() / 1000);
  const exp = addressJwtExpSeconds({ env: { ADDRESS_JWT_TTL_DAYS: "abc" } });
  assert.ok(Math.abs(exp - (before + 90 * daySec)) <= 2, `exp=${exp}`);
});

test("ADDRESS_JWT_TTL_DAYS=0 → falls back to 90d", () => {
  const before = Math.floor(Date.now() / 1000);
  const exp = addressJwtExpSeconds({ env: { ADDRESS_JWT_TTL_DAYS: 0 } });
  assert.ok(Math.abs(exp - (before + 90 * daySec)) <= 2, `exp=${exp}`);
});

test("ADDRESS_JWT_TTL_DAYS=-5 → falls back to 90d", () => {
  const before = Math.floor(Date.now() / 1000);
  const exp = addressJwtExpSeconds({ env: { ADDRESS_JWT_TTL_DAYS: -5 } });
  assert.ok(Math.abs(exp - (before + 90 * daySec)) <= 2, `exp=${exp}`);
});

test("ADDRESS_JWT_TTL_DAYS string number '45' → ~now+45d", () => {
  const before = Math.floor(Date.now() / 1000);
  const exp = addressJwtExpSeconds({ env: { ADDRESS_JWT_TTL_DAYS: "45" } });
  assert.ok(Math.abs(exp - (before + 45 * daySec)) <= 2, `exp=${exp}`);
});