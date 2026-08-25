import assert from "node:assert/strict";
import test from "node:test";

// H4 + H2: /telegram/webhook 来源校验（webhook.test）
//
// index.ts 依赖 Hono + telegraf（Node 下 strip-types 无法解析无扩展名的 ts 相对导入），
// 无法直接 import。故把 webhook 校验逻辑抽成纯函数 inline 到测试里，
// 与 index.ts 的实现逐字对齐（同一判定结构），覆盖分支：
//   1. TELEGRAM_SECRET_TOKEN 配置 + 正确 header -> 放行（proceed）
//   2. TELEGRAM_SECRET_TOKEN 配置 + 错误 header -> 拒绝 401
//   3. TELEGRAM_SECRET_TOKEN 配置 + 缺失 header  -> 拒绝 401
//   4. TELEGRAM_SECRET_TOKEN 未配置 -> 503 fail-closed（H2：不再静默 200，operator 可察觉）
//   5. H2 setWebhook 参数：配置 secret 时携带 secret_token，未配置时不带
//
// 生产代码：worker/src/telegram_api/index.ts 的 webhook handler 与
// /admin/telegram/init 的 setWebhook 参数构造。

// 与 index.tsx 完全相同的恒定时间比较（safeEqual / ../core/timing.ts 的分支拷贝）。
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
  // H2: 未配置 secret -> 503（fail-closed，operator 可察觉），不再静默 200。
  return { status: 503, proceed: false, log: "WEBHOOK_SKIP_NOT_CONFIGURED" };
}

// H2: /admin/telegram/init 构造 setWebhook extra 参数（与 index.ts 逐行对齐）。
function buildSetWebhookExtra(secretToken) {
  return secretToken ? { secret_token: secretToken } : {};
}

// ~= c.env 最小 mock（只含 webhook 校验用到的字段）
const envWithSecret = { TELEGRAM_SECRET_TOKEN: "my-secret-token-2026" };

test("H4 webhook: secret set + correct header -> proceed", async () => {
  const r = await decideWebhookProcessing(
    envWithSecret,
    { "x-telegram-bot-api-secret-token": "my-secret-token-2026" }
  );
  assert.equal(r.proceed, true);
  assert.equal(r.status, 200);
});

test("H4 webhook: secret set + wrong header -> rejected 401", async () => {
  const r = await decideWebhookProcessing(
    envWithSecret,
    { "x-telegram-bot-api-secret-token": "attacker-controlled-value" }
  );
  assert.equal(r.proceed, false);
  assert.equal(r.status, 401);
});

test("H4 webhook: secret set + missing header -> rejected 401", async () => {
  const r = await decideWebhookProcessing(envWithSecret, {});
  assert.equal(r.proceed, false);
  assert.equal(r.status, 401);
});

test("H4 webhook: header is case-sensitive (Telegram spec)", async () => {
  const r = await decideWebhookProcessing(
    envWithSecret,
    { "x-telegram-bot-api-secret-token": "My-Secret-Token-2026" }
  );
  assert.equal(r.proceed, false);
  assert.equal(r.status, 401);
});

test("H2 webhook: secret NOT set -> 503 fail-closed (never handleUpdate)", async () => {
  const r = await decideWebhookProcessing(
    { TELEGRAM_SECRET_TOKEN: undefined },
    {}
  );
  assert.equal(r.proceed, false);
  assert.equal(r.status, 503);
  // proceed=false -> 分支上不调用 bot.handleUpdate（生产代码中该分支仅日志+return）
});

test("H4 webhook: empty secret string treated as not configured (falsy) -> 503", async () => {
  const r = await decideWebhookProcessing(
    { TELEGRAM_SECRET_TOKEN: "" },
    { "x-telegram-bot-api-secret-token": "" }
  );
  assert.equal(r.proceed, false);
  assert.equal(r.status, 503);
});

test("H2 setWebhook: secret configured -> extra carries secret_token", () => {
  const extra = buildSetWebhookExtra("my-secret-token-2026");
  assert.deepEqual(extra, { secret_token: "my-secret-token-2026" });
});

test("H2 setWebhook: secret not configured -> empty extra (keep type compat)", () => {
  const extra = buildSetWebhookExtra(undefined);
  assert.deepEqual(extra, {});
});

test("H2 setWebhook: secret empty string -> treated as not configured", () => {
  const extra = buildSetWebhookExtra("");
  assert.deepEqual(extra, {});
});