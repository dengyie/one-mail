import assert from "node:assert/strict";
import test from "node:test";
import { recipientIsBlocked } from "./send_guard.ts";

test("the send block list matches a recipient substring and ignores malformed entries", () => {
  assert.equal(recipientIsBlocked("person@spam.test", ["spam.test"]), true);
  assert.equal(recipientIsBlocked("person@ok.test", ["spam.test"]), false);
  assert.equal(recipientIsBlocked("person@ok.test", null), false);
  assert.equal(recipientIsBlocked("person@ok.test", ["", 1]), false);
});
