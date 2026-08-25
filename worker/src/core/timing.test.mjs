import assert from "node:assert/strict";
import test from "node:test";
import { safeEqual } from "./timing.ts";

test("safeEqual: equal strings → true", async () => {
  assert.equal(await safeEqual("admin-pass-123", "admin-pass-123"), true);
});

test("safeEqual: differing strings → false", async () => {
  assert.equal(await safeEqual("admin-pass-123", "admin-pass-124"), false);
});

test("safeEqual: empty vs non-empty → false", async () => {
  assert.equal(await safeEqual("", "x"), false);
});

test("safeEqual: different lengths → false (length normalized via sha256)", async () => {
  // 长度差异不应造成时序泄露或异常，统一走等长摘要比较
  assert.equal(await safeEqual("short", "a-much-longer-admin-secret-value"), false);
});

test("safeEqual: same string, different length classes → deterministic", async () => {
  assert.equal(await safeEqual("a".repeat(300), "a".repeat(300)), true);
  assert.equal(await safeEqual("a".repeat(300), "a".repeat(300) + "b"), false);
});

test("safeEqual: unicode strings compare correctly", async () => {
  assert.equal(await safeEqual("密码-中文-😀", "密码-中文-😀"), true);
  assert.equal(await safeEqual("密码-中文-😀", "密码-中文-😀x"), false);
});