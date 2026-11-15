import assert from "node:assert/strict";
import test from "node:test";
import { decideUserTokenAuth } from "./user_token_auth.ts";

// 分界契约（PR #171/#172）：401 = 凭据真的失效（前端自愈清凭据并跳登录页）；
// 503 = D1 瞬时故障导致存活无法判定（前端走可重试路径，绝不清凭据）。
// 任何回归把 503 场景改回 401 都会复现「一直掉登录」。

const base = {
    hasUserToken: true,
    hasPayload: true,
    payloadExpired: false,
    livenessUnknown: false,
};

test("valid payload relays", () => {
    assert.deepEqual(decideUserTokenAuth(base), { relay: true, status: 0 });
});

test("liveness unknown wins over missing payload and answers 503, never 401", () => {
    // worker.ts 只在「签名与 exp 均合法、仅存活校验失败」时置 livenessUnknown，
    // 此时 payload 必然缺失 —— 这是本分界的核心场景。
    const d = decideUserTokenAuth({ ...base, hasPayload: false, livenessUnknown: true });
    assert.equal(d.relay, false);
    assert.equal(d.status, 503);
    assert.deepEqual(d, { relay: false, status: 503, error: "database temporarily unavailable", kind: "db_unavailable" });
});

test("liveness unknown with payload present still answers 503", () => {
    const d = decideUserTokenAuth({ ...base, livenessUnknown: true });
    assert.equal(d.status, 503);
});

test("missing payload without liveness flag is a genuine 401", () => {
    const d = decideUserTokenAuth({ ...base, hasPayload: false });
    assert.equal(d.relay, false);
    assert.equal(d.status, 401);
    assert.equal(d.kind, "invalid_token");
});

test("expired payload is a genuine 401", () => {
    const d = decideUserTokenAuth({ ...base, payloadExpired: true });
    assert.equal(d.status, 401);
    assert.equal(d.kind, "invalid_token");
});

test("no user token at all is a defensive 401 (caller guarantees this never happens)", () => {
    const d = decideUserTokenAuth({ ...base, hasUserToken: false });
    assert.equal(d.status, 401);
    assert.equal(d.kind, "invalid_token");
});
