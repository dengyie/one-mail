import assert from "node:assert/strict";
import test from "node:test";

import { generateRandomPassword } from "./password.ts";

test("generated passwords use the charset and fixed length", () => {
  for (let i = 0; i < 50; i++) {
    const pwd = generateRandomPassword();
    assert.equal(pwd.length, 8);
    assert.match(pwd, /^[a-z0-9]{8}$/);
  }
});

test("generated passwords are not trivially predictable constants", () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(generateRandomPassword());
  assert.ok(seen.size > 90, `expected high entropy, got ${seen.size} unique of 100`);
});
