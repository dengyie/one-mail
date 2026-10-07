import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { Hono } from "hono";

// Keep the real Worker dispatch, mode, fleet authentication and registry client.
// Unrelated provider modules are excluded so this suite requires no mail runtime.
globalThis.fleetEntrypointHono = Hono;
globalThis.fleetEntrypointCalls = { browserPassword: 0, email: 0, scheduled: 0 };
const emptyApi = "export const api=new globalThis.fleetEntrypointHono();";
const defaultApi = "export default new globalThis.fleetEntrypointHono();";
const boundaries = {
    "./core/auth": "export const verifyActiveAddressBearer=async()=>{throw new Error('unexpected address authentication')};",
    "./core/user_identity": "export const isActiveUser=async()=>{throw new Error('unexpected user lookup')};",
    "./commom_api": emptyApi,
    "./open_api/auth": emptyApi,
    "./mails_api": emptyApi,
    "./user_api": emptyApi,
    "./admin_api": emptyApi,
    "./mails_api/send_mail_api": emptyApi,
    "./telegram_api": emptyApi,
    "./unified": defaultApi,
    "./unified/shard_routes.ts": defaultApi,
    "./user_api/passkey_challenge_do.ts": "export class PasskeyChallengeDurableObject {}",
    "./i18n": "export default {getMessages:()=>({CustomAuthPasswordMsg:'browser password required'})};",
    "./email": "export const email=async()=>{globalThis.fleetEntrypointCalls.email++;throw new Error('unexpected mail provider I/O')};",
    "./scheduled": "export const scheduled=async()=>{globalThis.fleetEntrypointCalls.scheduled++;throw new Error('unexpected scheduled I/O')};",
    "./utils": "export const getPasswords=()=>{globalThis.fleetEntrypointCalls.browserPassword++;return ['browser-only-secret']};export const getBooleanValue=value=>!!value;export const getDomains=()=>['example.com'];export const checkIsAdmin=async()=>false;",
    "./ip_blacklist": "export const checkAccessControl=async()=>{throw new Error('unexpected rate-limit I/O')};",
    "./unified/admin_lockout": "export const recordAdminFailure=async()=>{};export const clearAdminFailures=async()=>{};export const decideAdminAuth=async()=>({relay:false});export const getAdminFailCount=async()=>0;",
};
const hooks = registerHooks({
    resolve(specifier, context, next) {
        if (context.parentURL?.endsWith("/worker.ts") && boundaries[specifier]) return { url: `data:text/javascript,${encodeURIComponent(boundaries[specifier])}`, shortCircuit: true };
        try { return next(specifier, context); }
        catch (cause) {
            if (!specifier.startsWith(".")) throw cause;
            for (const suffix of [".ts", "/index.ts"]) {
                const target = new URL(specifier + suffix, context.parentURL);
                if (existsSync(target)) return next(target.href, context);
            }
            throw cause;
        }
    },
});
const { default: worker } = await import("../worker.ts");
hooks.deregister();

const READ = "r".repeat(40);
const CONTROL = "c".repeat(40);
const snapshot = { v: 2, revision: "1", published_at: "2026-10-08T12:00:00Z", mailbox_routes: {}, shards: {} };
const context = { waitUntil() { throw new Error("unexpected background task"); } };

function fixture() {
    const calls = { assets: 0, registry: 0 };
    const env = {
        FLEET_MODE: "observe", FLEET_READ_TOKEN: READ, FLEET_CONTROL_TOKEN: CONTROL,
        ASSETS: { async fetch() { calls.assets++; return new Response("browser asset"); } },
        FLEET_REGISTRY: {
            idFromName(name) { assert.equal(name, "one-mail:fleet-registry:v2"); return name; },
            get() { return { async fetch() { calls.registry++; return Response.json(snapshot); } }; },
        },
    };
    return { env, calls };
}

test("actual Worker fleet service bypasses ASSETS and browser password but requires service credentials", async () => {
    const { env, calls } = fixture();
    const before = globalThis.fleetEntrypointCalls.browserPassword;
    const uri = "https://main.example/internal/fleet/snapshot";
    const missing = await worker.fetch(new Request(uri, { headers: { "x-custom-auth": "browser-only-secret", "x-admin-auth": CONTROL } }), env, context);
    assert.equal(missing.status, 401);
    const success = await worker.fetch(new Request(uri, { headers: { Authorization: `Bearer ${READ}` } }), env, context);
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), snapshot);
    assert.deepEqual(calls, { assets: 0, registry: 1 });
    assert.equal(globalThis.fleetEntrypointCalls.browserPassword, before);
    // The normal browser middleware still handles ordinary API requests.
    const browser = await worker.fetch(new Request("https://main.example/api/ping"), env, context);
    assert.equal(browser.status, 401);
    assert.equal(await browser.text(), "browser password required");
});

test("unsupported fleet modes stop fetch, email and scheduled before database, assets, KV or provider I/O", async () => {
    for (const mode of ["allocate", "rebalance", "Observe", "invalid"]) {
        const env = { FLEET_MODE: mode };
        for (const key of ["DB", "KV", "ASSETS", "FLEET_REGISTRY", "SHARD_MODE"]) Object.defineProperty(env, key, { get() { throw new Error(`unexpected ${key} access`); } });
        const response = await worker.fetch(new Request("https://main.example/api/unified/emails"), env, context);
        assert.equal(response.status, 503);
        assert.equal((await response.json()).error_code, "MODE_DISABLED");
        const rejections = [];
        await worker.email({ setReject: message => rejections.push(message) }, env, context);
        assert.deepEqual(rejections, ["unsupported fleet mode; data routing is unavailable"]);
        await assert.rejects(worker.scheduled({}, env, context), /MODE_DISABLED/);
    }
    assert.equal(globalThis.fleetEntrypointCalls.email, 0);
    assert.equal(globalThis.fleetEntrypointCalls.scheduled, 0);
});

test("shard-mode Worker never hosts fleet HTTP endpoints or consults the registry", async () => {
    const { env, calls } = fixture();
    env.SHARD_MODE = "1";
    env.SHARD_ID = "shard-b";
    for (const [method, path] of [["GET", "snapshot"], ["POST", "configure"], ["POST", "metrics"], ["POST", "plan"]]) {
        const response = await worker.fetch(new Request(`https://shard.example/internal/fleet/${path}`, { method, headers: { Authorization: `Bearer ${CONTROL}` }, body: method === "POST" ? "{}" : undefined }), env, context);
        assert.equal(response.status, 404);
    }
    assert.deepEqual(calls, { assets: 0, registry: 0 });
});
