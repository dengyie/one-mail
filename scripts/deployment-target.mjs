#!/usr/bin/env node
/**
 * Deployment target resolution, read-only.
 *
 * Before a deploy can touch production it should prove that the account /
 * D1 database / Worker it is about to use are the ones the checked-in
 * configuration expects. A wrong account or database id is the classic
 * copy-paste failure that backs up (or migrates) the wrong fleet.
 *
 * Availability first: missing credentials or a transient Cloudflare API error
 * make the check `skipped`/`failed` with exit code 0 unless
 * DEPLOYMENT_TARGET_MODE=strict. A flaky read-only check must never block a
 * deploy by itself; a real mismatch is still printed loudly.
 *
 * Usage:
 *   node scripts/deployment-target.mjs [--toml worker/wrangler.toml]
 * Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
 *      DEPLOYMENT_TARGET_MODE=warn|strict (default warn)
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.cloudflare.com/client/v4";
const PER_PAGE = 100;
const MAX_PAGES = 5;

/** Minimal TOML reading: the generated wrangler.toml only needs these keys. */
export function parseWranglerToml(text) {
    const firstSection = text.search(/^\[/m);
    const prefix = firstSection === -1 ? text : text.slice(0, firstSection);
    const name = /\bname\s*=\s*"([^"]+)"/.exec(prefix)?.[1] ?? null;
    const accountId = /\baccount_id\s*=\s*"([^"]+)"/.exec(prefix)?.[1] ?? null;

    const databases = [];
    for (const match of text.matchAll(/\[\[d1_databases\]\]([\s\S]*?)(?=\n\s*\[|$)/g)) {
        const block = match[1];
        databases.push({
            binding: /\bbinding\s*=\s*"([^"]+)"/.exec(block)?.[1] ?? null,
            databaseId: /\bdatabase_id\s*=\s*"([^"]+)"/.exec(block)?.[1] ?? null,
            databaseName: /\bdatabase_name\s*=\s*"([^"]+)"/.exec(block)?.[1] ?? null,
        });
    }
    return { name, accountId, databases };
}

async function cfGet(fetchImpl, token, path) {
    const options = { headers: { authorization: `Bearer ${token}` } };
    if (typeof AbortSignal?.timeout === "function") options.signal = AbortSignal.timeout(15000);
    const response = await fetchImpl(`${API}${path}`, options);
    const text = await response.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        throw new Error(`Cloudflare API returned non-JSON for ${path} (HTTP ${response.status})`);
    }
    if (!response.ok || json?.success === false) {
        const message = json?.errors?.[0]?.message ?? `HTTP ${response.status}`;
        throw new Error(`Cloudflare API error for ${path}: ${message}`);
    }
    return json.result;
}

async function cfList(fetchImpl, token, path) {
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const batch = await cfGet(fetchImpl, token, `${path}?page=${page}&per_page=${PER_PAGE}`);
        if (!Array.isArray(batch)) break;
        items.push(...batch);
        if (batch.length < PER_PAGE) break;
    }
    return items;
}

/**
 * Resolves the live target and compares it with the TOML. Returns a result
 * object and never throws; `error`/`mismatches` are strings with the token
 * scrubbed out.
 */
export async function resolveDeploymentTarget({ env = {}, tomlText, fetchImpl = fetch } = {}) {
    const mode = env.DEPLOYMENT_TARGET_MODE === "strict" ? "strict" : "warn";
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const token = env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) {
        return {
            ok: true, skipped: true, mode,
            reason: "missing_cloudflare_credentials",
        };
    }
    if (!tomlText) {
        return { ok: true, skipped: true, mode, reason: "missing_wrangler_toml" };
    }
    const toml = parseWranglerToml(tomlText);
    const scrub = (value) => String(value).split(token).join("[redacted]");

    try {
        const account = await cfGet(fetchImpl, token, `/accounts/${accountId}`);
        const databases = await cfList(fetchImpl, token, `/accounts/${accountId}/d1/database`);
        const scripts = await cfList(fetchImpl, token, `/accounts/${accountId}/workers/scripts`);
        const scriptNames = scripts.map((script) => script?.id ?? script?.name).filter(Boolean);

        const mismatches = [];
        if (toml.accountId && toml.accountId !== accountId) {
            mismatches.push(scrub(`account_id: toml=${toml.accountId} env=${accountId}`));
        }
        if (!account || String(account.id ?? accountId) !== accountId) {
            mismatches.push(scrub(`account_resolution: expected ${accountId}`));
        }

        for (const database of toml.databases) {
            const known = databases.find((item) => item.uuid === database.databaseId || item.id === database.databaseId);
            if (!database.databaseId) {
                mismatches.push(scrub(`d1 ${database.binding ?? "?"}: database_id missing from wrangler.toml`));
            } else if (!known) {
                mismatches.push(scrub(`d1 ${database.binding ?? "?"}: ${database.databaseId} not visible in account ${accountId}`));
            } else if (database.databaseName && known.name && known.name !== database.databaseName) {
                mismatches.push(scrub(`d1 ${database.binding ?? "?"}: name toml=${database.databaseName} live=${known.name}`));
            }
        }

        if (!toml.name) {
            mismatches.push("worker: name missing from wrangler.toml");
        } else if (!scriptNames.includes(toml.name)) {
            mismatches.push(scrub(`worker: ${toml.name} not visible in account ${accountId}`));
        }

        return {
            ok: mismatches.length === 0,
            skipped: false,
            mode,
            target: {
                account_id: accountId,
                worker: toml.name,
                databases: toml.databases.map((database) => ({
                    binding: database.binding,
                    database_id: database.databaseId,
                    database_name: database.databaseName,
                })),
            },
            mismatches,
        };
    } catch (error) {
        return {
            ok: false,
            skipped: false,
            mode,
            error: scrub(error instanceof Error ? error.message : String(error)),
        };
    }
}

async function main() {
    const args = process.argv.slice(2);
    const tomlIndex = args.indexOf("--toml");
    const tomlPath = resolve(ROOT, tomlIndex === -1 ? "worker/wrangler.toml" : args[tomlIndex + 1]);

    let tomlText = "";
    try {
        tomlText = readFileSync(tomlPath, "utf8");
    } catch {
        tomlText = "";
    }

    const result = await resolveDeploymentTarget({
        env: process.env,
        tomlText,
    });
    console.log(JSON.stringify(result, null, 2));

    if (result.skipped) return;
    const strict = result.mode === "strict";
    if (result.mismatches?.length > 0 || result.error) {
        const detail = result.error ?? result.mismatches.join("; ");
        if (strict) {
            console.error(`Deployment target check failed: ${detail}`);
            process.exitCode = 1;
        } else {
            console.error(`::warning title=Deployment target mismatch::${detail}`);
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}