import assert from "node:assert/strict";
import test from "node:test";
import { encryptCred, decryptCred } from "./cred_crypto.ts";

// 固定测试密钥（32 字节 base64），与生产密钥无关
const TEST_ENV = { MAIL_CRED_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" };

test("encrypt/decrypt round-trip returns original plaintext", async () => {
  const plain = "my-app-password-123!@#";
  const enc = await encryptCred(TEST_ENV, plain);
  assert.notEqual(enc, plain, "ciphertext must not equal plaintext");
  const dec = await decryptCred(TEST_ENV, enc);
  assert.equal(dec, plain);
});

test("each encryption uses a fresh iv — same plaintext yields different ciphertext", async () => {
  const plain = "same-secret";
  const a = await encryptCred(TEST_ENV, plain);
  const b = await encryptCred(TEST_ENV, plain);
  assert.notEqual(a, b, "random iv must produce different ciphertexts");
  // 但都能解回同一明文
  assert.equal(await decryptCred(TEST_ENV, a), plain);
  assert.equal(await decryptCred(TEST_ENV, b), plain);
});

test("decrypt rejects tampered ciphertext (auth tag failure)", async () => {
  const enc = await encryptCred(TEST_ENV, "hello");
  // 翻转密文最后一个字符，破坏 GCM tag
  const tampered = enc.slice(0, -1) + (enc.endsWith("A") ? "B" : "A");
  await assert.rejects(() => decryptCred(TEST_ENV, tampered));
});

test("missing key fails closed — no plaintext storage", async () => {
  await assert.rejects(() => encryptCred({}, "x"), /not set/);
  await assert.rejects(() => decryptCred({}, "anything"), /not set/);
});

test("wrong key fails to decrypt (no silent wrong plaintext)", async () => {
  const enc = await encryptCred(TEST_ENV, "secret");
  const wrongEnv = { MAIL_CRED_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
  await assert.rejects(() => decryptCred(wrongEnv, enc));
});

test("handles unicode / long app-passwords", async () => {
  const plain = "授权码-中文测试-".repeat(20);
  const dec = await decryptCred(TEST_ENV, await encryptCred(TEST_ENV, plain));
  assert.equal(dec, plain);
});
