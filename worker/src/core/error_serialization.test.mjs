import assert from "node:assert/strict";
import test from "node:test";
import { serializeError } from "./error_serialization.ts";

test("Error message survives JSON.stringify (regression: used to log {})", () => {
  const serialized = serializeError(new Error("D1_ERROR: no such table: outbound_mail_jobs"));
  const roundTripped = JSON.parse(JSON.stringify(serialized));
  assert.equal(roundTripped.message, "D1_ERROR: no such table: outbound_mail_jobs");
  assert.equal(roundTripped.name, "Error");
  assert.ok(roundTripped.stack, "stack must be preserved for diagnosis");
});

test("plain Error serializes to a non-empty object", () => {
  const json = JSON.stringify({ error: serializeError(new Error("boom")) });
  assert.notEqual(json, '{"error":{}}');
  assert.match(json, /boom/);
});

test("Error subclass keeps its name", () => {
  class ShardMapError extends Error {
    constructor(message, options) {
      super(message, options);
      this.name = "ShardMapError";
    }
  }
  assert.equal(serializeError(new ShardMapError("Invalid shard map JSON")).name, "ShardMapError");
});

test("nested cause is preserved, since D1 quota errors often wrap the real cause", () => {
  const serialized = serializeError(
    new Error("Worker request failed", { cause: new Error("free tier daily row read limit") }),
  );
  assert.equal(serialized.cause?.message, "free tier daily row read limit");
  assert.match(JSON.stringify(serialized), /row read limit/);
});

test("non-Error throws are still stringified instead of becoming {}", () => {
  assert.equal(serializeError("plain string").message, "plain string");
  assert.equal(serializeError({ code: 7500 }).message, '{"code":7500}');
  assert.equal(serializeError(undefined).name, "NonError");
});

test("circular non-Error values do not throw while being serialized", () => {
  const circular = {};
  circular.self = circular;
  assert.equal(typeof serializeError(circular).message, "string");
});

test("oversized message and stack are bounded to keep log lines readable", () => {
  const serialized = serializeError(new Error("x".repeat(5000)));
  assert.ok(serialized.message.length <= 500);
  assert.ok((serialized.stack ?? "").length <= 2000);
});