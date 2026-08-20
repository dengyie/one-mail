import assert from "node:assert/strict";
import test from "node:test";
import { extractVerifCode } from "./verifcode.ts";

test("extracts 6-digit code", () => {
  assert.equal(extractVerifCode("Your verification code is 123456, valid 5 min"), "123456");
  assert.equal(extractVerifCode("验证码：889900，5分钟内有效"), "889900");
});

test("returns null when no code", () => {
  assert.equal(extractVerifCode("hello there, no digits here"), null);
});

test("prefers code near keyword", () => {
  assert.equal(extractVerifCode("order 20260819 placed, code 445566"), "445566");
});