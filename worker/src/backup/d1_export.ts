/**
 * D1 export via the Cloudflare REST API, streamed straight into R2.
 *
 * The polling protocol is POST-only: the first POST with `output_format:
 * "polling"` creates the export and returns an `at_bookmark`; every subsequent
 * poll is another POST to the same endpoint carrying `current_bookmark` in the
 * body until `status: "complete"` surfaces a short-lived `signed_url` (nested
 * under `result.result`). A GET on the endpoint is rejected with 405, and an
 * export that stops being polled is cancelled — so the loop must keep POSTing
 * until it finishes or its budget runs out. The dump is then streamed into the
 * bucket so the Worker never buffers the whole database in memory.
 */

import type { BackupConfig } from "./config.ts";

// The free Workers plan caps fetch subrequests at 50 per invocation. This
// module's budget is 1 (create) + polls + 1 (download) = polls + 2, so with 45
// polls the export stays at 47 subrequests and leaves headroom for the rest of
// the cron invocation in the same event.
export const D1_EXPORT_POLL_INTERVAL_MS = 1000;
export const D1_EXPORT_MAX_POLLS = 45;

// The same JSON goes into the create call and every poll: `current_bookmark`
// is appended to it once the create returns a bookmark.
const POLL_BODY: Record<string, unknown> = { output_format: "polling" };

// `result.result` is repurposed by the API: the outer `result` is the export
// task, and only upon `status: "complete"` does it carry a nested `result`
// object with the download URL and generated filename.
type ExportCompletion = {
    signed_url?: unknown;
    filename?: unknown;
};

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
        body: JSON.stringify(POLL_BODY),
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
        // The API only accepts POST: a GET on the same endpoint is rejected
        // with 405, and polling stops restarting the export task, so each
        // attempt must be another authenticated POST with the latest bookmark.
        const response = await deps.fetch(d1ExportEndpoint(config), {
            method: "POST",
            headers: {
                authorization: `Bearer ${config.token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ ...POLL_BODY, current_bookmark: current }),
        });
        const json = await readCloudflareJson(response);
        const result = json?.result ?? {};
        if (result.status === "complete") {
            const completion = (result.result ?? {}) as ExportCompletion;
            if (typeof completion.signed_url === "string" && completion.signed_url) {
                return completion.signed_url;
            }
            throw new Error("D1 export completed without a signed_url");
        }
        if (result.status === "error") {
            const detail = typeof result.error === "string" ? result.error : JSON.stringify(result.error ?? {});
            throw new Error(`D1 export failed: ${detail}`);
        }
        if (typeof result.at_bookmark === "string" && result.at_bookmark) {
            current = result.at_bookmark;
        }
        // Do not sleep after the final poll: the loop is about to throw, so the
        // extra interval would only delay the failed-run ledger row.
        if (attempt + 1 < maxPolls) {
            await sleep(D1_EXPORT_POLL_INTERVAL_MS);
        }
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
