import assert from "node:assert/strict";
import test from "node:test";
import { mergeRoleAddressConfigs } from "./rbac_config.ts";

// C2 [安全] 回归：saveRoleAddressConfig 由整表替换改 merge（PATCH 语义）。
// 前端只提交被编辑的 role，若后端全量替换，admin B 的保存会清掉 admin A 配的其他 role。
// merge 后：incoming 覆盖同名 role，未提及的 role 保留——两 admin 并发配不同角色互不覆盖。

test("mergeRoleAddressConfigs: null existing → just incoming", () => {
  assert.deepEqual(
    mergeRoleAddressConfigs(null, { user: { maxAddressCount: 5 } }),
    { user: { maxAddressCount: 5 } }
  );
});

test("mergeRoleAddressConfigs: unspecified roles preserved, submitted role overwritten", () => {
  assert.deepEqual(
    mergeRoleAddressConfigs(
      { user: { maxAddressCount: 5 }, vip: { maxMailAccountCount: 10 } },
      { vip: { maxMailAccountCount: 9 } }
    ),
    { user: { maxAddressCount: 5 }, vip: { maxMailAccountCount: 9 } }
  );
});

test("mergeRoleAddressConfigs: empty incoming → unchanged", () => {
  assert.deepEqual(
    mergeRoleAddressConfigs({ user: { maxAddressCount: 5 } }, {}),
    { user: { maxAddressCount: 5 } }
  );
});

test("mergeRoleAddressConfigs: undefined existing → just incoming", () => {
  assert.deepEqual(
    mergeRoleAddressConfigs(undefined, { admin: {} }),
    { admin: {} }
  );
});