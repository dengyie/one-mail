/**
 * D1 export via the Cloudflare REST API, streamed straight into R2.
 *
 * The polling protocol is two steps: POST creates the export and returns
 * `at_bookmark`; GET with `current_bookmark` is repeated until it returns a
 * short-lived `signed_url`. The dump is then streamed into the bucket so the
 * Worker never buffers the whole database in memory.
 */

import type { BackupConfig } from "./config.ts";

export const D1_EXPORT_POLL_INTERVAL_MS = 1000;
export const D1_EXPORT_MAX_POLLS = 180;

export type D1ExportDeps = {
    fetch: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    maxPolls?: number;
};

const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

export function d1ExportEndpoint(config: Pick<BackupConfig, "accountId" | "databaseId">): string {
    return `https://api.cloudflare.com/client/v4/accounts/${config.accountId}`
        + `/d1/database/${config.databaseId}/export`;
}

type CloudflareEnvelope = {
    success?: boolean;
    errors?: Array<{ message?: string }>;
    result?: Record<string, unknown>;
};

async function readCloudflareJson(response: Response): Promise<CloudflareEnvelope> {
    const text = await response.text();
    let json: CloudflareEnvelope;
    try {
        json = JSON.parse(text) as CloudflareEnvelope;
    } catch {
        throw new Error(`D1 export API returned non-JSON (HTTP ${response.status})`);
    }
    if (!response.ok || json?.success === false) {
        const message = json?.errors?.[0]?.message ?? `HTTP ${response.status}`;
        throw new Error(`D1 export API error: ${message}`);
    }
    return json;
}

export async function createD1Export(
    config: Pick<BackupConfig, "accountId" | "databaseId" | "token">,
    deps: D1ExportDeps,
): Promise<string> {
    const response = await deps.fetch(d1ExportEndpoint(config), {
        method: "POST",
        headers: {
            authorization: `Bearer ${config.token}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({ output_format: "polling" }),
    });
    const json = await readCloudflareJson(response);
    const bookmark = json?.result?.at_bookmark;
    if (typeof bookmark !== "string" || !bookmark) {
        throw new Error("D1 export API did not return at_bookmark");
    }
    return bookmark;
}

export async function waitForD1Export(
    config: Pick<BackupConfig, "accountId" | "databaseId" | "token">,
    bookmark: string,
    deps: D1ExportDeps,
): Promise<string> {
    const sleep = deps.sleep ?? defaultSleep;
    const maxPolls = deps.maxPolls ?? D1_EXPORT_MAX_POLLS;
    let current = bookmark;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        const url = `${d1ExportEndpoint(config)}`
            + `?current_bookmark=${encodeURIComponent(current)}`;
        const response = await deps.fetch(url, {
            headers: { authorization: `Bearer ${config.token}` },
        });
        const json = await readCloudflareJson(response);
        const result = json?.result ?? {};
        if (typeof result.signed_url === "string" && result.signed_url) {
            return result.signed_url;
        }
        if (typeof result.at_bookmark === "string" && result.at_bookmark) {
            current = result.at_bookmark;
        }
        await sleep(D1_EXPORT_POLL_INTERVAL_MS);
    }
    throw new Error("D1 export did not finish in time");
}

/** Creates, waits for, and stores the export. Returns the stored byte size. */
export async function exportD1ToBucket(
    config: BackupConfig,
    key: string,
    deps: D1ExportDeps,
): Promise<number> {
    const bookmark = await createD1Export(config, deps);
    const signedUrl = await waitForD1Export(config, bookmark, deps);
    const download = await deps.fetch(signedUrl);
    if (!download.ok || !download.body) {
        throw new Error(`D1 export download failed (HTTP ${download.status})`);
    }
    const object = await config.bucket.put(key, download.body, {
        httpMetadata: { contentType: "application/sql" },
    });
    return object.size;
}
