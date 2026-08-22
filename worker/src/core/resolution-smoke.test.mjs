import assert from "node:assert/strict";
import test from "node:test";
import { SETTINGS_KEYS, JWT_DEFAULTS } from "@one-mail/shared";

test("worker test resolves @one-mail/shared workspace package", () => {
  assert.equal(SETTINGS_KEYS.USER_SETTINGS, "user_settings");
  assert.equal(SETTINGS_KEYS.ROLE_ADDRESS_CONFIG, "role_address_config");
  assert.equal(JWT_DEFAULTS.ADDRESS_TTL_DAYS, 90);
});