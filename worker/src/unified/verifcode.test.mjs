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
  assert.equal(extractVerifCode("请在验证页面输入以下代码： 269204，有效时间10分钟"), "269204");
  assert.equal(extractVerifCode("动态码: 654321"), "654321");
  assert.equal(extractVerifCode("您的授权码是 789012"), "789012");
});