import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { hashPasswordForStorage, verifyPassword } from "./password.ts";

const legacyHash = (password) => createHash("sha256").update(password).digest("hex");

test("stores a salted PBKDF2 record and verifies raw passwords", async () => {
  const first = await hashPasswordForStorage("correct horse battery staple");
  const second = await hashPasswordForStorage("correct horse battery staple");

  assert.match(first, /^pbkdf2-sha256-v2\$120000\$/);
  assert.notEqual(first, second, "each password record must use a fresh salt");
  assert.deepEqual(
    await verifyPassword("correct horse battery staple", first),
    { valid: true, needsRehash: false },
  );
  assert.deepEqual(
    await verifyPassword("wrong password", first),
    { valid: false, needsRehash: false },
  );
});

test("keeps the old SHA-256 client protocol working in both directions", async () => {
  const raw = "legacy-compatible-password";
  const hashed = legacyHash(raw);
  const storedFromRaw = await hashPasswordForStorage(raw);
  const storedFromLegacyClient = await hashPasswordForStorage(hashed);

  assert.deepEqual(await verifyPassword(hashed, storedFromRaw), {
    valid: true,
    needsRehash: false,
  });
  assert.deepEqual(await verifyPassword(raw, storedFromLegacyClient), {
    valid: true,
    needsRehash: false,
  });
  assert.deepEqual(await verifyPassword(raw, hashed), {
    valid: true,
    needsRehash: true,
  });
  assert.deepEqual(await verifyPassword(hashed, raw), {
    valid: true,
    needsRehash: true,
  });
});

test("rejects malformed PBKDF2 records without throwing", async () => {
  assert.deepEqual(
    await verifyPassword("anything", "pbkdf2-sha256-v2$1$bad$bad$bad"),
    { valid: false, needsRehash: false },
  );
});
