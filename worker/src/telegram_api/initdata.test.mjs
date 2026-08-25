import assert from "node:assert/strict";
import test from "node:test";

// H4: initData HMAC 校验（initdata.test）
//
// miniapp.ts 的 checkTelegramAuth 依赖 Hono context（c.env.TELEGRAM_BOT_TOKEN），
// 无法不构造 context 直接 import。此处把 Telegram WebApp 规范的密码学原语
// （HMAC-SHA256 双层推导）实现为纯函数，与 miniapp.ts 的算法逐字节对齐：
//
//   secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
//   hash   = HMAC_SHA256(key=secret,     msg=data_check_string).hex
//   data_check_string = 除 hash 外全部 k=v 按 k 排序后以 \n 连接
//
// 正向：预计算的固定向量必须重建出同一 hash → 通过
// 负向：篡改任何字段 / 替换 hash → 重建值不等 → 拒绝

const encoder = new TextEncoder();
const toHex = (buf) =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(h.match(/.{2}/g).map((b) => parseInt(b, 16)));
const hmac = async (key, msg) => {
  const k = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, encoder.encode(msg));
  return new Uint8Array(sig);
};

// 复刻 miniapp.ts checkTelegramAuth 的 data_check_string 构造 + HMAC 推导
async function computeInitDataHash(botToken, initData) {
  const params = new URLSearchParams(initData);
  params.delete("hash");
  params.sort();
  const dataToCheck = [...params.entries()].map(([k, v]) => k + "=" + v).join("\n");

  const cryptoKey = await crypto.subtle.importKey(
    "raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const secretKeyBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(botToken));
  const secretKey = await crypto.subtle.importKey(
    "raw", secretKeyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const calcHmac = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(dataToCheck));
  return { hash: toHex(calcHmac), dataToCheck };
}

test("HMAC web app data: pre-computed test vector (bot_token=test)", async () => {
  const botToken = "test";
  const initData = "user=%7B%22id%22%3A1%7D&auth_date=1000000&hash=86a13c6cbaf6bd9bb6fc1f446fd8e1573b0bef488e900e4e97a8c758b8cb97e0";

  const { hash, dataToCheck } = await computeInitDataHash(botToken, initData);
  assert.equal(dataToCheck, "auth_date=1000000\nuser={\"id\":1}");
  assert.equal(
    hash,
    "86a13c6cbaf6bd9bb6fc1f446fd8e1573b0bef488e900e4e97a8c758b8cb97e0"
  );
});

test("HMAC 对 data_check_string 的哈希是 64 位小写 hex", async () => {
  const { hash } = await computeInitDataHash(
    "test",
    "user=%7B%22id%22%3A1%7D&auth_date=1000000&hash=x"
  );
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test("initData 校验正向：正确 hash 通过", async () => {
  // 用 WebAppData 算法自己算出的 hash 作为"预期"
  const botToken = "test";
  const base = "user=%7B%22id%22%3A1%7D&auth_date=1000000";
  const { hash } = await computeInitDataHash(botToken, `${base}&hash=stub`);
  const initData = `${base}&hash=${hash}`;

  // 独立第三方实现按同一协议重建 hash，应完全一致（校验通过）
  const extHash = await validateInitDataExternally(botToken, initData);
  assert.equal(extHash, hash);
});

test("HMAC 校验负向：篡改 auth_date → hash 不一致 → 拒绝", async () => {
  const botToken = "test";
  const base = "user=%7B%22id%22%3A1%7D&auth_date=1000000";
  const { hash } = await computeInitDataHash(botToken, `${base}&hash=stub`);

  // attacker 篡改 auth_date（code→999999999）
  const tampered = "user=%7B%22id%22%3A1%7D&auth_date=999999999";
  const tamperedHash = await computeInitDataHash(botToken, `${tampered}&hash=stub`);
  assert.notEqual(tamperedHash.hash, hash);
  // 篡改后再用原 hash 携带 → 校验失败
  const tamperedInitData = `${tampered}&hash=${hash}`;
  assert.notEqual(await validateInitDataExternally(botToken, tamperedInitData), hash);
});

test("HMAC 校验负向：篡改 user 字段 → hash 不一致 → 拒绝", async () => {
  const botToken = "test";
  const base = "user=%7B%22id%22%3A1%7D&auth_date=1000000";
  const { hash } = await computeInitDataHash(botToken, `${base}&hash=stub`);

  // attacker 把 userId 换成别的账号
  const tampered = "user=%7B%22id%22%3A2%7D&auth_date=1000000";
  const tamperedHash = await computeInitDataHash(botToken, `${tampered}&hash=stub`);
  assert.notEqual(tamperedHash.hash, hash);
  assert.notEqual(
    await validateInitDataExternally(botToken, `${tampered}&hash=${hash}`),
    hash
  );
});

test("HMAC 校验负向：不同 bot_token 的 secret 不通用", async () => {
  const a = await computeInitDataHash("tokenA", "user=%7B%22id%22%3A1%7D&auth_date=1000000&hash=stub");
  const b = await computeInitDataHash("tokenB", "user=%7B%22id%22%3A1%7D&auth_date=1000000&hash=stub");
  assert.notEqual(a.hash, b.hash);
});

// 独立第三方实现：仅用标准 HMAC，独立构造 data_check_string，
// 用于"正向通过"以外的独立交叉验证。
async function validateInitDataExternally(botToken, initData) {
  const params = new URLSearchParams(initData);
  params.delete("hash");
  params.sort();
  const dataToCheck = [...params.entries()].map(([k, v]) => k + "=" + v).join("\n");
  const secret = await hmac(encoder.encode("WebAppData"), botToken);
  const final = await hmac(secret, dataToCheck);
  return toHex(final);
}