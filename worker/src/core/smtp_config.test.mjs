import assert from "node:assert/strict";
import test from "node:test";

import {
  SmtpConfigError,
  getSmtpConfigForDomain,
  isValidSmtpOptions,
  loadSmtpOptionsForDomain,
  parseSmtpConfigMap,
  validateSmtpOptions,
} from "./smtp_config.ts";

const startTls587 = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  startTls: true,
  authType: ["plain", "login"],
  credentials: { username: "user", password: "pass" },
};

const implicit465 = {
  host: "smtp.example.com",
  port: 465,
  secure: true,
  authType: ["plain", "login"],
  credentials: { username: "user", password: "pass" },
};

const startTls2525 = {
  host: "smtp.example.com",
  port: 2525,
  secure: false,
  startTls: true,
  authType: ["plain", "login"],
  credentials: { username: "user", password: "pass" },
};

test("parseSmtpConfigMap: missing or empty is no map, not an error", () => {
  assert.equal(parseSmtpConfigMap(null), null);
  assert.equal(parseSmtpConfigMap(undefined), null);
  assert.equal(parseSmtpConfigMap(""), null);
  assert.equal(parseSmtpConfigMap("   "), null);
});

test("parseSmtpConfigMap: illegal JSON preserves cause", () => {
  let caught;
  try {
    parseSmtpConfigMap("{not-json");
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SmtpConfigError);
  assert.match(caught.message, /not valid JSON/);
  assert.ok(caught.cause instanceof SyntaxError);
});

test("parseSmtpConfigMap: non-object payload is a config error", () => {
  assert.throws(() => parseSmtpConfigMap("[]"), SmtpConfigError);
  assert.throws(() => parseSmtpConfigMap(42), SmtpConfigError);
  assert.throws(() => parseSmtpConfigMap("\"smtp\""), SmtpConfigError);
});

test("parseSmtpConfigMap: object secret is accepted and domain lookup is exact", () => {
  const map = parseSmtpConfigMap({
    "Example.COM": startTls587,
    "otp.example.com": implicit465,
  });
  assert.deepEqual(getSmtpConfigForDomain(map, "example.com"), startTls587);
  assert.deepEqual(getSmtpConfigForDomain(map, "OTP.EXAMPLE.COM"), implicit465);
  assert.equal(getSmtpConfigForDomain(map, "mail.example.com"), null);
  assert.equal(getSmtpConfigForDomain(map, "example.com.evil"), null);
});

test("subdomain does not inherit parent SMTP_CONFIG", () => {
  const map = parseSmtpConfigMap({
    "mangoqwq.com": startTls587,
  });
  assert.equal(getSmtpConfigForDomain(map, "otp.mangoqwq.com"), null);
  assert.equal(getSmtpConfigForDomain(map, "verify.mangoqwq.com"), null);
});

test("validateSmtpOptions: 587 STARTTLS and 2525 STARTTLS pass", () => {
  assert.equal(validateSmtpOptions("example.com", startTls587), startTls587);
  assert.equal(validateSmtpOptions("mail.example.com", startTls2525), startTls2525);
});

test("validateSmtpOptions: 465 implicit TLS passes", () => {
  assert.equal(validateSmtpOptions("example.com", implicit465), implicit465);
});

test("validateSmtpOptions: missing host fails", () => {
  assert.throws(
    () => validateSmtpOptions("example.com", { ...startTls587, host: "  " }),
    (error) => error instanceof SmtpConfigError && /host/.test(error.message),
  );
});

test("validateSmtpOptions: non-integer port fails", () => {
  assert.throws(
    () => validateSmtpOptions("example.com", { ...startTls587, port: "587" }),
    (error) => error instanceof SmtpConfigError && /port/.test(error.message),
  );
  assert.throws(
    () => validateSmtpOptions("example.com", { ...startTls587, port: 587.5 }),
    SmtpConfigError,
  );
});

test("validateSmtpOptions: 587 without startTls fails", () => {
  assert.throws(
    () => validateSmtpOptions("example.com", {
      ...startTls587,
      startTls: false,
    }),
    (error) => error instanceof SmtpConfigError && /startTls/.test(error.message),
  );
  assert.throws(
    () => validateSmtpOptions("example.com", {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      credentials: { username: "u", password: "p" },
    }),
    SmtpConfigError,
  );
});

test("validateSmtpOptions: 465 without secure fails", () => {
  assert.throws(
    () => validateSmtpOptions("example.com", {
      ...implicit465,
      secure: false,
    }),
    (error) => error instanceof SmtpConfigError && /465/.test(error.message),
  );
});

test("validateSmtpOptions: authType without password fails", () => {
  assert.throws(
    () => validateSmtpOptions("example.com", {
      ...startTls587,
      credentials: { username: "user", password: "  " },
    }),
    (error) => error instanceof SmtpConfigError && /password/.test(error.message),
  );
  assert.throws(
    () => validateSmtpOptions("example.com", {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      startTls: true,
      authType: ["plain"],
    }),
    SmtpConfigError,
  );
});

test("validateSmtpOptions: other ports need explicit TLS", () => {
  assert.throws(
    () => validateSmtpOptions("example.com", {
      host: "smtp.example.com",
      port: 25,
      secure: false,
      startTls: false,
      credentials: { username: "u", password: "p" },
    }),
    (error) => error instanceof SmtpConfigError && /port 25/.test(error.message),
  );
  const port25StartTls = {
    host: "smtp.example.com",
    port: 25,
    secure: false,
    startTls: true,
    credentials: { username: "u", password: "p" },
  };
  assert.equal(validateSmtpOptions("example.com", port25StartTls), port25StartTls);
});

test("Mailpit 1025 loopback without credentials is the only plaintext exemption", () => {
  const mailpit = { host: "mailpit", port: 1025, secure: false };
  assert.equal(validateSmtpOptions("test.example.com", mailpit), mailpit);
  assert.ok(isValidSmtpOptions({ host: "127.0.0.1", port: 1025, secure: false }));
  assert.ok(isValidSmtpOptions({ host: "localhost", port: 1025 }));
  assert.equal(
    isValidSmtpOptions({ host: "smtp.example.com", port: 1025, secure: false }),
    false,
  );
  assert.equal(
    isValidSmtpOptions({
      host: "mailpit",
      port: 1025,
      secure: false,
      authType: ["plain"],
      credentials: { username: "u", password: "p" },
    }),
    false,
  );
});

test("parseSmtpConfigMap: illegal JSON is a config error even when other channels exist", () => {
  assert.throws(() => parseSmtpConfigMap("{"), SmtpConfigError);
});

test("loadSmtpOptionsForDomain: missing domain is null; bad entry throws", () => {
  const raw = JSON.stringify({
    "example.com": startTls587,
    "broken.example.com": { host: "smtp.example.com", port: 587, secure: false },
  });
  assert.deepEqual(loadSmtpOptionsForDomain(raw, "example.com"), startTls587);
  assert.equal(loadSmtpOptionsForDomain(raw, "other.example.com"), null);
  assert.throws(
    () => loadSmtpOptionsForDomain(raw, "broken.example.com"),
    SmtpConfigError,
  );
  assert.throws(
    () => loadSmtpOptionsForDomain("{", "example.com"),
    SmtpConfigError,
  );
});

