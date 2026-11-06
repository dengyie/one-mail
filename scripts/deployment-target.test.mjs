import assert from "node:assert/strict";
import test from "node:test";
import { parseWranglerToml, resolveDeploymentTarget } from "./deployment-target.mjs";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const DATABASE = "5f3e1c0a-9b2d-4e7a-8c61-1d2e3f4a5b6c";

const TOML = `name = "one-mail"
main = "src/worker.ts"
compatibility_date = "2026-01-01"

[[d1_databases]]
binding = "DB"
database_name = "one_mail_db"
database_id = "${DATABASE}"

[[kv_namespaces]]
binding = "KV"
id = "kv-id"
`;

function respond(result) {
    return new Response(JSON.stringify({ success: true, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function liveFetch({ databases = [{ uuid: DATABASE, name: "one_mail_db" }], scripts = [{ id: "one-mail" }], fail } = {}) {
    return async (url) => {
        if (fail) throw new Error(`boom ${fail}`);
        if (url.includes("/d1/database")) return respond(databases);
        if (url.includes("/workers/scripts")) return respond(scripts);
        if (/\/accounts\/[0-9a-f]+$/.test(url)) return respond({ id: ACCOUNT, name: "acct" });
        throw new Error(`unexpected ${url}`);
    };
}

test("parses the top-level name and every d1 block", () => {
    const parsed = parseWranglerToml(TOML);
    assert.equal(parsed.name, "one-mail");
    assert.equal(parsed.databases.length, 1);
    assert.deepEqual(parsed.databases[0], {
        binding: "DB",
        databaseId: DATABASE,
        databaseName: "one_mail_db",
    });
});

test("parses nothing harmful from an empty file", () => {
    assert.deepEqual(parseWranglerToml(""), { name: null, accountId: null, databases: [] });
});

test("skips without credentials instead of failing the deploy", async () => {
    const result = await resolveDeploymentTarget({ env: {}, tomlText: TOML });
    assert.equal(result.skipped, true);
    assert.equal(result.ok, true);
    assert.equal(result.reason, "missing_cloudflare_credentials");
});

test("skips when the generated wrangler.toml is absent", async () => {
    const result = await resolveDeploymentTarget({
        env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "t" },
        tomlText: "",
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "missing_wrangler_toml");
});

test("resolves a matching account, database and worker", async () => {
    const result = await resolveDeploymentTarget({
        env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "token" },
        tomlText: TOML,
        fetchImpl: liveFetch(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.target.worker, "one-mail");
    assert.deepEqual(result.mismatches, []);
});

test("reports a database that is not visible in the account", async () => {
    const result = await resolveDeploymentTarget({
        env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "token" },
        tomlText: TOML,
        fetchImpl: liveFetch({ databases: [{ uuid: "deadbeef", name: "other" }] }),
    });
    assert.equal(result.ok, false);
    assert.match(result.mismatches.join(" "), /not visible in account/);
});

test("reports a database name drift and a missing worker script", async () => {
    const result = await resolveDeploymentTarget({
        env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "token" },
        tomlText: TOML,
        fetchImpl: liveFetch({
            databases: [{ uuid: DATABASE, name: "renamed_db" }],
            scripts: [{ id: "some-other-worker" }],
        }),
    });
    assert.equal(result.ok, false);
    const joined = result.mismatches.join(" ");
    assert.match(joined, /name toml=one_mail_db live=renamed_db/);
    assert.match(joined, /worker: one-mail not visible/);
});

test("a transient API failure never leaks the token", async () => {
    const result = await resolveDeploymentTarget({
        env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "super-secret-token" },
        tomlText: TOML,
        fetchImpl: liveFetch({ fail: "super-secret-token" }),
    });
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.ok(!result.error.includes("super-secret-token"));
    assert.match(result.error, /\[redacted\]/);
});

test("a non-JSON response is reported, not thrown", async () => {
    const result = await resolveDeploymentTarget({
        env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "token" },
        tomlText: TOML,
        fetchImpl: async () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /non-JSON/);
});