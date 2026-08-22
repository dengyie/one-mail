import assert from "node:assert/strict";
import test from "node:test";
import { Jwt } from "hono/utils/jwt";
import { addressJwtExpSeconds, signAddressJwt, verifyAddressJwt } from "./auth.ts";

const daySec = 86400;

test("addressJwtExpSeconds: no env → ~now+90d", () => {
  const before = Math.floor(Date.now() / 1000);
  const exp = addressJwtExpSeconds({ env: {} });
  const after = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(exp - (before + 90 * daySec)) <= 2, `exp=${exp} before=${before}`);
  assert.ok(exp <= after + 90 * daySec + 2);
});

test("addressJwtExpSeconds: ADDRESS_JWT_TTL_DAYS=30 → ~now+30d", () => {
  const exp = addressJwtExpSeconds({ env: { ADDRESS_JWT_TTL_DAYS: "30" } });
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(exp - (now + 30 * daySec)) <= 2);
});

// 以下边界用例原属 unified/address_token.test.mjs（Task 9 删除该文件后并入此处）。
test("addressJwtExpSeconds: numeric ADDRESS_JWT_TTL_DAYS=30 → ~now+30d", () => {
  const before = Math.floor(Date.now() / 1000);
  const exp = addressJwtExpSeconds({ env: { ADDRESS_JWT_TTL_DAYS: 30 } });
  assert.ok(Math.abs(exp - (before + 30 * daySec)) <= 2, `exp=${exp}`);
});

test('addressJwtExpSeconds: ADDRESS_JWT_TTL_DAYS="abc" (invalid) → falls back to 90d', () => {
  const before = Math.floor(Date.now() / 1000);
  const exp = addressJwtExpSeconds({ env: { ADDRESS_JWT_TTL_DAYS: "abc" } });
  assert.ok(Math.abs(exp - (before + 90 * daySec)) <= 2, `exp=${exp}`);
});

test("addressJwtExpSeconds: ADDRESS_JWT_TTL_DAYS=0 → falls back to 90d", () => {
  const before = Math.floor(Date.now() / 1000);
  const exp = addressJwtExpSeconds({ env: { ADDRESS_JWT_TTL_DAYS: 0 } });
  assert.ok(Math.abs(exp - (before + 90 * daySec)) <= 2, `exp=${exp}`);
});

test("addressJwtExpSeconds: ADDRESS_JWT_TTL_DAYS=-5 → falls back to 90d", () => {
  const before = Math.floor(Date.now() / 1000);
  const exp = addressJwtExpSeconds({ env: { ADDRESS_JWT_TTL_DAYS: -5 } });
  assert.ok(Math.abs(exp - (before + 90 * daySec)) <= 2, `exp=${exp}`);
});

test("addressJwtExpSeconds: string number '45' → ~now+45d", () => {
  const before = Math.floor(Date.now() / 1000);
  const exp = addressJwtExpSeconds({ env: { ADDRESS_JWT_TTL_DAYS: "45" } });
  assert.ok(Math.abs(exp - (before + 45 * daySec)) <= 2, `exp=${exp}`);
});

test("signAddressJwt → verifyAddressJwt roundtrip", async () => {
  const c = { env: { JWT_SECRET: "test-secret", ADDRESS_JWT_TTL_DAYS: "30" } };
  const token = await signAddressJwt(c, { address: "test@example.com", address_id: 7 });
  const payload = await verifyAddressJwt(c, token);
  assert.equal(payload.address, "test@example.com");
  assert.equal(payload.address_id, 7);
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));
});

test("verifyAddressJwt: garbage token → null", async () => {
  const c = { env: { JWT_SECRET: "test-secret" } };
  assert.equal(await verifyAddressJwt(c, "not-a-jwt"), null);
});

test("verifyAddressJwt: wrong secret → null", async () => {
  const token = await signAddressJwt({ env: { JWT_SECRET: "a" } }, { address: "x", address_id: 1 });
  assert.equal(await verifyAddressJwt({ env: { JWT_SECRET: "b" } }, token), null);
});

test("verifyAddressJwt: REJECT_EXPLESS_JWT=true rejects exp-less, false accepts", async () => {
  const token = await Jwt.sign({ address: "x", address_id: 1 }, "test-secret", "HS256");
  const strict = { env: { JWT_SECRET: "test-secret", REJECT_EXPLESS_JWT: "true" } };
  assert.equal(await verifyAddressJwt(strict, token), null);
  const lenient = { env: { JWT_SECRET: "test-secret" } };
  assert.equal((await verifyAddressJwt(lenient, token)).address, "x");
});
