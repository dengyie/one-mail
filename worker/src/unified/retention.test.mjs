import assert from "node:assert/strict";
import test from "node:test";
import { cutoffMs } from "./retention.ts";

test("cutoffMs subtracts N days in ms", () => {
  const now = 1700000000000;
  assert.equal(cutoffMs(90, now), now - 90 * 24 * 60 * 60 * 1000);
  assert.equal(cutoffMs(0, now), now);
});