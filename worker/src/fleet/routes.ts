import { Hono } from "hono";
import { safeEqual } from "../core/timing.ts";
import { serializeError } from "../core/error_serialization.ts";
import { FleetError } from "./contracts.ts";
import { readFleetJson } from "./http_io.ts";
import { deployedFleetMode } from "./mode.ts";
import { getFleetRegistrySnapshot, requestFleetRegistry } from "./registry_client.ts";
import { configureRequest, metricsRequest } from "./validation.ts";

const PREFIX = "/internal/fleet";
const DEADLINE_MS = 5_000;
const tokenValid = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{32,512}$/.test(value);

function failure(code: string, status: number, requestId: string, retryable = false): Response {
    return Response.json({ ok: false, error_code: code, request_id: requestId, retryable }, {
        status,
        headers: { "Cache-Control": "no-store", ...(retryable ? { "Retry-After": "5" } : {}) },
    });
}

/** Separate service entry point: no browser password, user token or ingest key grants access. */
const api = new Hono<HonoCustomType>();
api.all(`${PREFIX}/*`, async c => {
    const requestId = crypto.randomUUID();
    const abort = new AbortController();
    const cancel = (): void => abort.abort(c.req.raw.signal.reason);
    const timer = setTimeout(() => abort.abort(new Error("fleet request deadline exceeded")), DEADLINE_MS);
    c.req.raw.signal.addEventListener("abort", cancel, { once: true });
    if (c.req.raw.signal.aborted) cancel();
    try {
        if (deployedFleetMode(c.env) !== "observe") return failure("MODE_DISABLED", 404, requestId);
        const path = c.req.path.slice(PREFIX.length);
        const reading = c.req.method === "GET" && path === "/snapshot";
        const planning = c.req.method === "POST" && path === "/plan";
        const writing = c.req.method === "POST" && (path === "/configure" || path === "/metrics");
        if (!reading && !planning && !writing) return failure("NOT_FOUND", 404, requestId);
        const { FLEET_READ_TOKEN: reader, FLEET_CONTROL_TOKEN: controller } = c.env;
        if (!tokenValid(reader) || !tokenValid(controller) || await safeEqual(reader, controller)) {
            return failure("FLEET_AUTH_NOT_CONFIGURED", 503, requestId);
        }
        const authorization = c.req.header("Authorization") ?? "";
        const presented = /^Bearer ([\x21-\x7e]{32,512})$/.exec(authorization)?.[1];
        if (!presented) return failure("UNAUTHORIZED", 401, requestId);
        const [isController, isReader] = await Promise.all([safeEqual(presented, controller), safeEqual(presented, reader)]);
        if (!isController && !isReader) return failure("UNAUTHORIZED", 401, requestId);
        if (writing && !isController) return failure("FORBIDDEN", 403, requestId);
        if (reading) {
            const snapshot = await getFleetRegistrySnapshot(c.env, abort.signal);
            const etag = `"fleet-${snapshot.revision}"`;
            const headers = { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Authorization" };
            // Validation and authorization still run on conditional requests.
            if (c.req.header("If-None-Match") === etag) return new Response(null, { status: 304, headers });
            return Response.json(snapshot, { headers });
        }
        const body = await readFleetJson(c.req.raw, undefined, abort.signal);
        let command = body;
        if (path === "/configure") command = configureRequest(body);
        if (path === "/metrics") command = metricsRequest(body);
        const result = await requestFleetRegistry(c.env, path, { method: "POST", body: command, signal: abort.signal });
        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (cause) {
        if (cause instanceof FleetError) {
            // Domain failures are already diagnosed by the registry. Transport
            // failures retain their local cause and need this boundary log.
            if (cause.code === "REGISTRY_UNAVAILABLE" && cause.cause !== undefined) {
                console.error("fleet service request failed", { request_id: requestId, error: serializeError(cause) });
            }
            return failure(cause.code, cause.status, requestId, cause.retryable);
        }
        // No tokens, payloads or remote response text enter this boundary log.
        console.error("fleet service request failed", { request_id: requestId, error: serializeError(cause) });
        return failure("REGISTRY_UNAVAILABLE", 503, requestId, true);
    } finally {
        clearTimeout(timer);
        c.req.raw.signal.removeEventListener("abort", cancel);
    }
});

export default api;
