import assert from "node:assert/strict";
import test from "node:test";

// H4: /telegram/webhook 来源校验（webhook.test）
//
// index.ts 依赖 Hono + telegraf（Node 下 strip-types 无法解析无扩展名的 ts 相对导入），
// 无法直接 import。故把 webhook 校验逻辑抽成纯函数 inline 到测试里，
// 与 index.ts 的实现逐字对齐（同一判定结构），覆盖三条分支：
//   1. TELEGRAM_SECRET_TOKEN 配置 + 正确 header → 放行（proceed）
//   2. TELEGRAM_SECRET_TOKEN 配置 + 错误 header → 拒绝 401
//   3. TELEGRAM_SECRET_TOKEN 配置 + 缺失 header  → 拒绝 401
//   4. TELEGRAM_SECRET_TOKEN 未配置 → 跳过处理（200，不调用 handleUpdate）
//
// 生产代码：worker/src/telegram_api/index.ts 的 webhook handler。

// 与 index.ts 完全相同的恒定时间比较（safeEqual / ../core/timing.ts 的分支拷贝）。
// 保持零相对 import 以满足 node --test 直跑约束。
const sha256 = async (s) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(digest);
};
const safeEqual = async (a, b) => {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
};

// 与 index.ts webhook handler 相同的判定逻辑（含注释对应处）。
// 返回 { status, proceed, log }，proceed=true 才应调用 bot.handleUpdate。
async function decideWebhookProcessing(env, headers) {
  const secretToken = env.TELEGRAM_SECRET_TOKEN;
  if (secretToken) {
    const headerToken = headers["x-telegram-bot-api-secret-token"];
    const verified = headerToken !== undefined && headerToken !== null
      && (await safeEqual(secretToken, headerToken));
    if (!verified) {
      return { status: 401, proceed: false, log: "WEBHOOK_REJECT" };
    }
    return { status: 200, proceed: true, log: "WEBHOOK_ACCEPT" };
  }
  return { status: 200, proceed: false, log: "WEBHOOK_SKIP_NOT_CONFIGURED" };
}

// ~= c.env 最小 mock（只含 webhook 校验用到的字段）
const envWithSecret = { TELEGRAM_SECRET_TOKEN: "my-secret-token-2026" };

test("H4 webhook: secret set + correct header → proceed", async () => {
  const r = await decideWebhookProcessing(
    envWithSecret,
    { "x-telegram-bot-api-secret-token": "my-secret-token-2026" }
  );
  assert.equal(r.proceed, true);
  assert.equal(r.status, 200);
});

test("H4 webhook: secret set + wrong header → rejected 401", async () => {
  const r = await decideWebhookProcessing(
    envWithSecret,
    { "x-telegram-bot-api-secret-token": "attacker-controlled-value" }
  );
  assert.equal(r.proceed, false);
  assert.equal(r.status, 401);
});

test("H4 webhook: secret set + missing header → rejected 401", async () => {
  const r = await decideWebhookProcessing(envWithSecret, {});
  assert.equal(r.proceed, false);
  assert.equal(r.status, 401);
});

test("H4 webhook: header is case-sensitive (Telegram spec)", async () => {
  // Telegram 要求 secret_token 精确匹配（区分大小写），大小写不同应拒绝
  const r = await decideWebhookProcessing(
    envWithSecret,
    { "x-telegram-bot-api-secret-token": "My-Secret-Token-2026" }
  );
  assert.equal(r.proceed, false);
  assert.equal(r.status, 401);
});

test("H4 webhook: secret NOT set → skip processing (200, never handleUpdate)", async () => {
  const r = await decideWebhookProcessing(
    { TELEGRAM_SECRET_TOKEN: undefined },
    {}
  );
  assert.equal(r.proceed, false);
  assert.equal(r.status, 200);
  // proceed=false → 分支上不调用 bot.handleUpdate（生产代码中该分支仅日志+return）
});

test("H4 webhook: empty secret string treated as not configured (falsy)", async () => {
  const r = await decideWebhookProcessing(
    { TELEGRAM_SECRET_TOKEN: "" },
    { "x-telegram-bot-api-secret-token": "" }
  );
  assert.equal(r.proceed, false);
  assert.equal(r.status, 200);
});