import { FLEET_ERROR_CODES, FleetError } from "./contracts.ts";
import type { FleetErrorCode, FleetSnapshot } from "./contracts.ts";
import { abortable, readFleetJson } from "./http_io.ts";
import { counter, epoch, fleetSnapshot, id, record, route, utcInstant } from "./validation.ts";

export const FLEET_REGISTRY_OBJECT_NAME = "one-mail:fleet-registry:v2";
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

export interface RegistryBindings {
    readonly FLEET_REGISTRY?: DurableObjectNamespace;
}

export interface RegistryRequestOptions {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    readonly signal?: AbortSignal;
}

function validatePending(value: unknown): void {
    const pending = record(value, ["operation_id", "mail_account_id", "owner_shard_id", "epoch", "created_at"]);
    id(pending.operation_id); id(pending.mail_account_id); id(pending.owner_shard_id);
    epoch(pending.epoch); utcInstant(pending.created_at);
}

function validateDecision(value: unknown): void {
    const decision = record(value);
    if (decision.ok === false) {
        record(decision, ["ok", "error_code"]);
        if (decision.error_code !== "NO_CAPACITY" && decision.error_code !== "STALE_METRICS") throw new FleetError("INVALID_REQUEST");
        return;
    }
    record(decision, ["ok", "shard_id", "account_key", "score_ppm"]);
    if (decision.ok !== true || counter(decision.score_ppm) > 1_000_000) throw new FleetError("INVALID_REQUEST");
    id(decision.shard_id); id(decision.account_key);
}

function validateSuccess(path: string, body: unknown): Record<string, unknown> {
    if (path === "/snapshot") return fleetSnapshot(body) as unknown as Record<string, unknown>;
    const item = record(body);
    if (item.ok !== true) throw new FleetError("INVALID_REQUEST");
    epoch(item.revision);
    const endpoint = path.split("?", 1)[0];
    if (endpoint === "/configure") record(item, ["ok", "revision"]);
    else if (endpoint === "/metrics") {
        record(item, ["ok", "revision", "consecutive_valid_samples"]);
        if (counter(item.consecutive_valid_samples) > 3) throw new FleetError("INVALID_REQUEST");
    } else if (endpoint === "/plan") {
        record(item, ["ok", "revision", "decision"]);
        validateDecision(item.decision);
    } else if (endpoint === "/import") {
        record(item, ["ok", "revision", "imported"]);
        if (counter(item.imported, true) > 100) throw new FleetError("INVALID_REQUEST");
    } else if (endpoint === "/tombstone") {
        record(item, ["ok", "revision", "tombstone"]);
        const tombstone = record(item.tombstone, ["mail_account_id", "epoch", "owner_shard_id", "updated_at"]);
        id(tombstone.mail_account_id); epoch(tombstone.epoch);
        if (tombstone.owner_shard_id !== undefined && tombstone.owner_shard_id !== null) id(tombstone.owner_shard_id);
        if (tombstone.updated_at !== undefined) utcInstant(tombstone.updated_at);
    } else {
        record(item, ["ok", "revision", "route", "pending"]);
        if (!item.route && !item.pending) throw new FleetError("INVALID_REQUEST");
        if (item.route) route(item.route);
        if (item.pending) validatePending(item.pending);
    }
    return item;
}

function failureFromResponse(value: unknown, status: number): FleetError {
    const body = record(value, ["ok", "error_code", "retryable", "request_id"]);
    if (body.ok !== false || typeof body.retryable !== "boolean" || !FLEET_ERROR_CODES.includes(body.error_code as FleetErrorCode)
        || typeof body.request_id !== "string" || !/^[a-f0-9-]{36}$/.test(body.request_id)) throw new FleetError("INVALID_REQUEST");
    return new FleetError(body.error_code as FleetErrorCode, status, body.retryable);
}

/** Internal binding only; no caller-controlled origin, token or redirect target. */
export async function requestFleetRegistry(env: RegistryBindings, path: string, options: RegistryRequestOptions = {}): Promise<Record<string, unknown>> {
    if (!env.FLEET_REGISTRY) throw new FleetError("REGISTRY_UNAVAILABLE", 503, true);
    if (!/^\/(?:snapshot|route(?:\?mail_account_id=[A-Za-z0-9_.:@%~-]+)?|configure|import|metrics|plan|allocate|confirm|tombstone)$/.test(path)) throw new FleetError("INVALID_REQUEST");
    if (options.signal?.aborted) throw new FleetError("REGISTRY_UNAVAILABLE", 503, true, options.signal.reason);
    const abort = new AbortController();
    const cancel = (): void => abort.abort(options.signal?.reason);
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => abort.abort(new Error("fleet registry deadline exceeded")), REQUEST_TIMEOUT_MS);
    try {
        const stub = env.FLEET_REGISTRY.get(env.FLEET_REGISTRY.idFromName(FLEET_REGISTRY_OBJECT_NAME));
        const response = await abortable(stub.fetch(`https://fleet-registry.internal${path}`, {
            method: options.method ?? "GET",
            headers: { "Content-Type": "application/json" },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            redirect: "error",
            signal: abort.signal,
        }), abort.signal);
        let parsed: Record<string, unknown> | FleetError;
        try {
            const body = await abortable(readFleetJson(response, MAX_SNAPSHOT_BYTES, abort.signal), abort.signal);
            parsed = response.ok ? validateSuccess(path, body) : failureFromResponse(body, response.status);
        } catch (cause) {
            throw new FleetError("REGISTRY_UNAVAILABLE", 503, true, cause);
        }
        if (parsed instanceof FleetError) throw parsed;
        return parsed;
    } catch (cause) {
        if (cause instanceof FleetError) throw cause;
        throw new FleetError("REGISTRY_UNAVAILABLE", 503, true, cause);
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", cancel);
    }
}

export async function getFleetRegistrySnapshot(env: RegistryBindings, signal?: AbortSignal): Promise<FleetSnapshot> {
    return fleetSnapshot(await requestFleetRegistry(env, "/snapshot", { signal }));
}
