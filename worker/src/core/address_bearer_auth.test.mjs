import assert from "node:assert/strict";
import test from "node:test";
import { Jwt } from "hono/utils/jwt";

import { signAddressJwt, verifyActiveAddressBearer } from "./auth.ts";

const dbWithAddress = (row) => ({
  prepare() {
    return {
      bind() { return this; },
      first: async () => row,
    };
  },
});

const context = (row) => ({
  env: {
    JWT_SECRET: "test-secret",
    DB: dbWithAddress(row),
  },
});

test("active address bearer accepts a current exp-bearing credential", async () => {
  const c = context({ name: "test@example.com" });
  const token = await signAddressJwt(c, { address: "test@example.com", address_id: 7 });
  const payload = await verifyActiveAddressBearer(c, `Bearer ${token}`);

  assert.equal(payload?.address, "test@example.com");
  assert.equal(payload?.address_id, 7);
});

test("active address bearer rejects malformed authorization headers", async () => {
  const c = context({ name: "test@example.com" });

  assert.equal(await verifyActiveAddressBearer(c, null), null);
  assert.equal(await verifyActiveAddressBearer(c, "Basic abc"), null);
  assert.equal(await verifyActiveAddressBearer(c, "Bearer"), null);
  assert.equal(await verifyActiveAddressBearer(c, "Bearer one two"), null);
});

test("active address bearer rejects an exp-less signed JWT", async () => {
  const c = context({ name: "test@example.com" });
  const token = await Jwt.sign(
    { address: "test@example.com", address_id: 7 },
    "test-secret",
    "HS256",
  );

  assert.equal(await verifyActiveAddressBearer(c, `Bearer ${token}`), null);
});

test("active address bearer rejects a deleted or replaced address", async () => {
  const token = await signAddressJwt(
    { env: { JWT_SECRET: "test-secret" } },
    { address: "test@example.com", address_id: 7 },
  );

  assert.equal(
    await verifyActiveAddressBearer(context(null), `Bearer ${token}`),
    null,
  );
  assert.equal(
    await verifyActiveAddressBearer(context({ name: "other@example.com" }), `Bearer ${token}`),
    null,
  );
});
