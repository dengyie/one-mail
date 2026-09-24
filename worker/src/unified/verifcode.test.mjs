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
  assert.equal(extractVerifCode("登录口令：5678"), "5678");
  assert.equal(extractVerifCode("Your passcode is 9876"), "9876");
});

test("does not extract copyright years, street numbers or date components as codes", () => {
  // 无关键词时，4 位独立数字（版权年份、门牌号、邮编）不得被提取为验证码
  assert.equal(extractVerifCode("© 2026 Google LLC 1600 Amphitheatre Pkwy"), null);
  assert.equal(extractVerifCode("Copyright 2024 GitHub Inc. All rights reserved."), null);
  assert.equal(extractVerifCode("Notice updated in 2025 by admin"), null);

  // 关键词紧邻日期时，连字符/斜杠/中文年日期不得被误提取，应匹配真实验证码
  assert.equal(extractVerifCode("验证码已于 2026-09-24 10:00:00 发送，您的动态码为 889900"), "889900");
  assert.equal(extractVerifCode("验证码已于 2026年09月24日 发送，您的动态码为 889900"), "889900");
  assert.equal(extractVerifCode("code sent on 2026/09/24, passcode is 456789"), "456789");
});

test("does not truncate long numbers (phone numbers, order ids, timestamps) into codes", () => {
  assert.equal(extractVerifCode("验证码已发送至手机: 13812345678"), null);
  assert.equal(extractVerifCode("代码对应订单号: 202609240012"), null);
  assert.equal(extractVerifCode("验证码已发送至 13812345678，验证码是 889900"), "889900");
  assert.equal(extractVerifCode("安全码：99887766（8位安全码有效）"), "99887766");
  assert.equal(extractVerifCode("安全码：998877665（9位长数字不应被截断）"), null);
});