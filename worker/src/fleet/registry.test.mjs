import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { FleetRegistryDurableObject } from "./registry_do.ts";
import { fleetConfig, fleetSnapshot, epoch, nextEpoch, utcDate, utcInstant } from "./validation.ts";
import { choosePlacement, updateMetricSeries } from "./placement.ts";
import { getFleetRegistrySnapshot, requestFleetRegistry, FLEET_REGISTRY_OBJECT_NAME } from "./registry_client.ts";
import { readFleetJson } from "./http_io.ts";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const instant = milliseconds => new Date(milliseconds).toISOString();
const clone = value => value === undefined ? undefined : structuredClone(value);

class Storage {
    values = new Map();
    tail = Promise.resolve();
    failOnKey = null;
    transaction(callback) {
        const work = this.tail.then(async () => {
            const values = clone(this.values);
            const txn = {
                get: async key => Array.isArray(key)
                    ? new Map(key.filter(item => values.has(item)).map(item => [item, clone(values.get(item))]))
                    : clone(values.get(key)),
                put: async (key, value) => {
                    if (key === this.failOnKey) { this.failOnKey = null; throw new Error("simulated durable write failure"); }
                    values.set(key, clone(value));
                },
                delete: async key => values.delete(key),
                list: async options => new Map([...values].filter(([key]) => (!options.prefix || key.startsWith(options.prefix)) && (!options.end || key < options.end)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, options.limit).map(([key, value]) => [key, clone(value)])),
            };
            const result = await callback(txn);
            this.values = values;
            return result;
        });
        this.tail = work.then(() => undefined, () => undefined);
        return work;
    }
}

const account = key => ({ account_key: key, provider_account_id: `provider-${key}`, enabled: true, credential_ref: `metrics-${key}`, daily_read_limit: 5_000_000, daily_write_limit: 100_000, worker_request_limit: 100_000, metrics_observed_at: null });
const shard = (key, accountKey) => ({ shard_id: key, account_key: accountKey, database_id: `database-${key}`, credential_ref: `token-${key}`, base_url: `https://${key}.example.com`, state: "healthy", schema_version: 1, protocol_version: 2, storage_limit_bytes: 500_000_000, observed_size_bytes: 0 });
const config = () => ({ accounts: [account("main"), account("remote")], shards: [shard("primary", "main"), shard("shard-b", "remote")], primary_shard_id: "primary", required_schema_version: 1, required_protocol_version: 2, allocation_budget: { reserved_read: 10_000, reserved_write: 1000, reserved_worker_requests: 100, reserved_bytes: 1_000_000 }, max_mailboxes: 1000 });
const report = (accountKey = "remote", observedAt = NOW, overrides = {}) => ({ snapshot: { account_key: accountKey, utc_date: "2026-10-08", observed_at: instant(observedAt), source: "cloudflare_graphql", rows_read: 1000, rows_written: 100, worker_requests: 100, confidence: "authoritative", shard_sizes: { "shard-b": 0 } }, projected_rows_read: 1000, projected_rows_written: 100, projected_worker_requests: 100, ...overrides });
const input = custom => ({ config: config(), metrics: { remote: { report: report(), consecutive_valid_samples: 3 } }, account_reservations: {}, shard_reserved_bytes: {}, affinity_shards: new Set(), now: NOW, ...custom });

async function invoke(registry, path, body) {
    const response = await registry.fetch(new Request(`https://registry.test${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
    return { status: response.status, headers: response.headers, body: await response.json() };
}

async function fixture(t, { mode = "allocate", customConfig = config() } = {}) {
    t.mock.method(Date, "now", () => NOW);
    const storage = new Storage();
    const registry = new FleetRegistryDurableObject({ storage }, { FLEET_MODE: mode });
    const result = await invoke(registry, "/configure", { expected_revision: "0", idempotency_key: "configure-1", config: customConfig });
    assert.equal(result.status, 200);
    let revision = result.body.revision;
    for (let index = 0; index < 3; index++) {
        const metrics = report("remote", NOW - (2 - index) * 300_000);
        if (customConfig.shards.some(value => value.shard_id === "shard-c")) metrics.snapshot.shard_sizes["shard-c"] = 0;
        const sample = await invoke(registry, "/metrics", { expected_revision: revision, idempotency_key: `metric-${index}`, report: metrics });
        assert.equal(sample.status, 200);
        revision = sample.body.revision;
    }
    return { storage, registry, revision };
}

const allocation = (revision, key = "allocate-1", mailbox = "mailbox-1") => ({ expected_revision: revision, idempotency_key: key, mail_account_id: mailbox, user_key: "user-1", known_empty: true });

test("contracts reject noncanonical and overflowing epochs, invalid dates and secret snapshot fields", () => {
    for (const value of ["01", "-1", "1.0", 1, "18446744073709551616"]) assert.throws(() => epoch(value));
    assert.equal(nextEpoch("9007199254740992"), "9007199254740993");
    assert.throws(() => nextEpoch("18446744073709551615"), /COUNTER_OVERFLOW/);
    assert.throws(() => utcDate("2026-02-29"));
    assert.equal(utcDate("2024-02-29"), "2024-02-29");
    assert.throws(() => utcInstant("2026-10-08T12:00:00+00:00"));
    assert.throws(() => utcInstant("2026-02-30T12:00:00Z"));
    assert.equal(utcInstant("2026-10-08T12:00:00Z"), "2026-10-08T12:00:00Z");
    assert.throws(() => fleetSnapshot({ v: 2, revision: "1", published_at: instant(NOW), mailbox_routes: {}, shards: { "shard-b": shard("shard-b", "remote") } }));
});

test("configuration is bounded, requires positive demand and prevents duplicate provider account quota pools", () => {
    const value = config();
    value.accounts[1].provider_account_id = value.accounts[0].provider_account_id;
    assert.throws(() => fleetConfig(value));
    const oversized = config();
    oversized.max_mailboxes = 1001;
    assert.throws(() => fleetConfig(oversized));
    const unsafe = config();
    unsafe.shards[1].base_url = "https://name:secret@host.test";
    assert.throws(() => fleetConfig(unsafe));
    const missing = config();
    missing.allocation_budget.reserved_write = 0;
    assert.throws(() => fleetConfig(missing));
});

test("placement uses account-wide maximum resource utilization, never averages a hot resource", () => {
    const value = input();
    value.metrics.remote.report.projected_rows_written = 69_000;
    assert.deepEqual(choosePlacement(value), { ok: false, error_code: "NO_CAPACITY" });
    value.metrics.remote.report.projected_rows_written = 60_000;
    value.account_reservations.remote = { reserved_read: 0, reserved_write: 9000, reserved_worker_requests: 0, reserved_bytes: 0 };
    assert.deepEqual(choosePlacement(value), { ok: false, error_code: "NO_CAPACITY" });
});

test("affinity is limited to five percentage points and final ties are stable", () => {
    const value = input();
    value.config.shards.push(shard("shard-c", "remote"));
    value.metrics.remote.report.snapshot.shard_sizes = { "shard-b": 100_000_000, "shard-c": 125_000_000 };
    value.affinity_shards.add("shard-c");
    assert.equal(choosePlacement(value).shard_id, "shard-c");
    value.metrics.remote.report.snapshot.shard_sizes["shard-c"]++;
    assert.equal(choosePlacement(value).shard_id, "shard-b");
    value.affinity_shards.clear();
    value.metrics.remote.report.snapshot.shard_sizes["shard-c"] = 100_000_000;
    value.config.shards.reverse();
    assert.equal(choosePlacement(value).shard_id, "shard-b");
});

test("placement rejects stale, unbootstrapped, unhealthy, unversioned and primary candidates", () => {
    for (const change of [
        value => { value.metrics.remote.consecutive_valid_samples = 2; },
        value => { value.metrics.remote.report.snapshot.observed_at = instant(NOW - 900_001); },
        value => { value.metrics.remote.report.snapshot.utc_date = "2026-10-07"; },
        value => { value.metrics.remote.report.snapshot.shard_sizes = {}; },
    ]) {
        const value = input(); change(value);
        assert.deepEqual(choosePlacement(value), { ok: false, error_code: "STALE_METRICS" });
    }
    const value = input();
    value.config.shards[1].state = "draining";
    assert.deepEqual(choosePlacement(value), { ok: false, error_code: "NO_CAPACITY" });
    value.config.shards[1].state = "healthy";
    value.config.shards[1].protocol_version = 1;
    assert.equal(choosePlacement(value).ok, false);
});

test("metric regression, day rollover and interrupted samples reset allocation eligibility", () => {
    let series;
    for (let index = 2; index >= 0; index--) series = updateMetricSeries(series, report("remote", NOW - index * 300_000), NOW);
    assert.equal(series.consecutive_valid_samples, 3);
    assert.equal(updateMetricSeries(series, report(), NOW).consecutive_valid_samples, 3);
    const backwards = report("remote", NOW + 1);
    backwards.snapshot.rows_written = 0;
    assert.equal(updateMetricSeries(series, backwards, NOW + 1).consecutive_valid_samples, 0);
    assert.equal(updateMetricSeries(series, report("remote", NOW + 900_001), NOW + 900_001).consecutive_valid_samples, 1);
    const tomorrow = report("remote", NOW + 86_400_000);
    tomorrow.snapshot.utc_date = "2026-10-09";
    assert.equal(updateMetricSeries(series, tomorrow, NOW + 86_400_000).consecutive_valid_samples, 1);
});

test("three timestamps in one UTC bucket cannot bootstrap eligibility", () => {
    let series;
    for (let milliseconds = 0; milliseconds < 3; milliseconds++) {
        series = updateMetricSeries(series, report("remote", NOW + milliseconds), NOW + milliseconds);
        assert.equal(series.consecutive_valid_samples, 1);
    }
    assert.equal(choosePlacement(input({ now: NOW + 2, metrics: { remote: series } })).error_code, "STALE_METRICS");
    series = updateMetricSeries(series, report("remote", NOW + 300_000), NOW + 300_000);
    assert.equal(series.consecutive_valid_samples, 2);
    series = updateMetricSeries(series, report("remote", NOW + 600_000), NOW + 600_000);
    assert.equal(series.consecutive_valid_samples, 3);
});

test("skipped UTC buckets break a streak even when the gap is below 15 minutes", () => {
    let series = updateMetricSeries(undefined, report("remote", NOW), NOW);
    series = updateMetricSeries(series, report("remote", NOW + 600_000), NOW + 600_000);
    assert.equal(series.consecutive_valid_samples, 1);
    series = updateMetricSeries(series, report("remote", NOW + 900_000), NOW + 900_000);
    assert.equal(series.consecutive_valid_samples, 2);
});

test("failure in an occupied bucket resets the streak while preserving its cumulative baseline", () => {
    let series;
    for (let index = 2; index >= 0; index--) series = updateMetricSeries(series, report("remote", NOW - index * 300_000), NOW);
    const partial = report("remote", NOW + 1);
    partial.snapshot.confidence = "partial";
    partial.snapshot.rows_written = 0;
    series = updateMetricSeries(series, partial, NOW + 1);
    assert.equal(series.consecutive_valid_samples, 0);
    assert.equal(series.baseline.snapshot.rows_written, 100);
    series = updateMetricSeries(series, report("remote", NOW + 2), NOW + 2);
    assert.equal(series.consecutive_valid_samples, 1);
});

test("placement refuses unsafe aggregate counter overflow", () => {
    const value = input();
    value.metrics.remote.report.projected_rows_read = Number.MAX_SAFE_INTEGER;
    assert.throws(() => choosePlacement(value), /COUNTER_OVERFLOW/);
});

test("three samples below an earlier accepted cumulative count remain ineligible", () => {
    let series = updateMetricSeries(undefined, report("remote", NOW - 600_000), NOW);
    for (let index = 3; index >= 0; index--) {
        const lower = report("remote", NOW - index * 60_000);
        lower.snapshot.rows_written = 10 + index;
        series = updateMetricSeries(series, lower, NOW);
        assert.equal(series.consecutive_valid_samples, 0);
    }
    assert.equal(series.baseline.snapshot.rows_written, 100);
    assert.equal(updateMetricSeries(series, report("remote", NOW + 1), NOW + 1).consecutive_valid_samples, 1);
});

test("snapshot validator rejects mailbox key mismatches and an unregistered owner", () => {
    const { database_id, credential_ref, ...publicFields } = shard("shard-b", "remote");
    const snapshot = { v: 2, revision: "1", published_at: instant(NOW), shards: { "shard-b": publicFields }, mailbox_routes: { wrong: { mail_account_id: "mailbox", owner_shard_id: "shard-b", epoch: "1", state: "active", migration_id: null, updated_at: instant(NOW) } } };
    assert.throws(() => fleetSnapshot(snapshot), /MISSING_OWNER/);
    snapshot.mailbox_routes = { mailbox: { ...snapshot.mailbox_routes.wrong, owner_shard_id: "unregistered" } };
    assert.throws(() => fleetSnapshot(snapshot), /MISSING_OWNER/);
});

test("snapshot contains no credentials, provider account IDs or database IDs", async t => {
    const { registry } = await fixture(t);
    const result = await invoke(registry, "/snapshot");
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("ETag"), '"4"');
    assert.equal(fleetSnapshot(result.body).v, 2);
    const json = JSON.stringify(result.body);
    for (const privateValue of ["credential_ref", "database_id", "provider_account_id", "token-shard-b", "metrics-remote"]) assert.equal(json.includes(privateValue), false);
});

test("observe plan returns placement advice without changing owners, budget, revision or audit", async t => {
    const { registry, storage, revision } = await fixture(t, { mode: "observe" });
    const before = clone(storage.values);
    const result = await invoke(registry, "/plan", { expected_revision: revision, affinity_shard_ids: ["shard-b"] });
    assert.equal(result.status, 200);
    assert.equal(result.body.revision, revision);
    assert.equal(result.body.decision.shard_id, "shard-b");
    assert.deepEqual(storage.values, before);
    assert.equal((await invoke(registry, "/plan", { expected_revision: "0" })).body.error_code, "REVISION_CONFLICT");
    assert.equal((await invoke(registry, "/plan", { expected_revision: revision, affinity_shard_ids: ["unknown"] })).status, 400);
});

test("allocation is staged and only a matching durable operation gate can publish its owner", async t => {
    const { registry, revision } = await fixture(t);
    const allocated = await invoke(registry, "/allocate", allocation(revision));
    assert.equal(allocated.status, 200);
    assert.equal(allocated.body.pending.owner_shard_id, "shard-b");
    assert.deepEqual((await invoke(registry, "/snapshot")).body.mailbox_routes, {});
    const confirmation = { expected_revision: allocated.body.revision, idempotency_key: "confirm-1", mail_account_id: "mailbox-1", operation_id: "wrong-operation", gate: { owner_shard_id: "shard-b", epoch: "1", mode: "active" } };
    assert.equal((await invoke(registry, "/confirm", confirmation)).body.error_code, "GATE_MISMATCH");
    confirmation.operation_id = "allocate-1";
    const confirmed = await invoke(registry, "/confirm", confirmation);
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.route.epoch, "1");
    assert.equal((await invoke(registry, "/snapshot")).body.mailbox_routes["mailbox-1"].owner_shard_id, "shard-b");
});

test("same idempotency key and body replays before revision CAS, including across object restart", async t => {
    const { registry, storage, revision } = await fixture(t);
    const body = allocation(revision);
    const first = await invoke(registry, "/allocate", body);
    const restarted = new FleetRegistryDurableObject({ storage }, { FLEET_MODE: "allocate" });
    const second = await invoke(restarted, "/allocate", body);
    assert.deepEqual(second, first);
    assert.equal(storage.values.get("registry:meta").mailbox_count, 1);
    assert.equal(storage.values.get("registry:allocation-budgets").remote.reserved_write, 1000);
    const conflict = await invoke(restarted, "/allocate", { ...body, mail_account_id: "other-mailbox" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error_code, "IDEMPOTENCY_CONFLICT");
});

test("concurrent allocators commit one owner and one budget reservation", async t => {
    const { registry, storage, revision } = await fixture(t);
    const results = await Promise.all([
        invoke(registry, "/allocate", allocation(revision, "race-a")),
        invoke(registry, "/allocate", allocation(revision, "race-b")),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const winner = results.find(result => result.status === 200);
    const recovery = await invoke(registry, "/allocate", allocation(winner.body.revision, "race-c"));
    assert.deepEqual(recovery.body.pending, winner.body.pending);
    assert.equal(storage.values.get("registry:allocation-budgets").remote.reserved_write, 1000);
    assert.equal(storage.values.get("registry:meta").mailbox_count, 1);
});

test("two databases in one Cloudflare account do not receive separate write allowances", async t => {
    const customConfig = config();
    customConfig.shards.push(shard("shard-c", "remote"));
    customConfig.allocation_budget.reserved_write = 40_000;
    const { registry, revision } = await fixture(t, { customConfig });
    const first = await invoke(registry, "/allocate", allocation(revision));
    assert.equal(first.status, 200);
    const second = await invoke(registry, "/allocate", allocation(first.body.revision, "allocate-2", "mailbox-2"));
    assert.equal(second.body.error_code, "NO_CAPACITY");
});

test("observe, legacy-static and omitted mode cannot allocate; unknown mode is rejected", async t => {
    for (const mode of ["observe", "legacy-static", ""]) {
        const { registry, revision } = await fixture(t, { mode });
        const result = await invoke(registry, "/allocate", allocation(revision));
        assert.equal(result.body.error_code, "MODE_DISABLED");
    }
    const registry = new FleetRegistryDurableObject({ storage: new Storage() }, { FLEET_MODE: "typo" });
    assert.equal((await invoke(registry, "/snapshot")).status, 400);
});

test("existing mailboxes import an explicit owner without going through allocation", async t => {
    const { registry, revision } = await fixture(t, { mode: "observe" });
    const route = { mail_account_id: "qq-main", owner_shard_id: "primary", epoch: "9007199254740993", state: "active", migration_id: null, updated_at: instant(NOW) };
    const imported = await invoke(registry, "/import", { expected_revision: revision, idempotency_key: "import-1", mailboxes: [{ route, user_key: "admin", gate_confirmed: true }] });
    assert.equal(imported.status, 200);
    assert.deepEqual((await invoke(registry, "/snapshot")).body.mailbox_routes["qq-main"], route);
    const unknown = await invoke(registry, "/route?mail_account_id=unknown");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error_code, "UNKNOWN_MAILBOX");
});

test("owner validation and bounded batches fail atomically without partial import", async t => {
    const { registry, storage, revision } = await fixture(t);
    const route = { mail_account_id: "first", owner_shard_id: "primary", epoch: "1", state: "active", migration_id: null, updated_at: instant(NOW) };
    const body = { expected_revision: revision, idempotency_key: "import-1", mailboxes: [{ route, user_key: "admin", gate_confirmed: true }, { route: { ...route, mail_account_id: "second", owner_shard_id: "missing" }, user_key: "admin", gate_confirmed: true }] };
    assert.equal((await invoke(registry, "/import", body)).body.error_code, "MISSING_OWNER");
    assert.equal(storage.values.has("registry:mailbox:first"), false);
    body.mailboxes = Array.from({ length: 101 }, (_, index) => ({ route: { ...route, mail_account_id: `mail-${index}` }, user_key: "admin", gate_confirmed: true }));
    assert.equal((await invoke(registry, "/import", body)).status, 400);
});

test("deletion wins over delayed confirmation and late first-time allocation", async t => {
    const { registry, storage, revision } = await fixture(t);
    const allocated = await invoke(registry, "/allocate", allocation(revision));
    const deleted = await invoke(registry, "/tombstone", { expected_revision: allocated.body.revision, idempotency_key: "delete-1", mail_account_id: "mailbox-1" });
    assert.equal(deleted.body.tombstone.epoch, "2");
    const confirmation = await invoke(registry, "/confirm", { expected_revision: deleted.body.revision, idempotency_key: "confirm-1", mail_account_id: "mailbox-1", operation_id: "allocate-1", gate: { owner_shard_id: "shard-b", epoch: "1", mode: "active" } });
    assert.equal(confirmation.body.error_code, "MAILBOX_DELETED");
    assert.equal(storage.values.get("registry:allocation-budgets").remote.reserved_write, 1000);
    const unknownDelete = await invoke(registry, "/tombstone", { expected_revision: deleted.body.revision, idempotency_key: "delete-2", mail_account_id: "never-allocated" });
    const late = await invoke(registry, "/allocate", allocation(unknownDelete.body.revision, "late", "never-allocated"));
    assert.equal(late.body.error_code, "MAILBOX_DELETED");
});

test("historical idempotent receipts never resurrect the current owner after deletion", async t => {
    const { registry, storage, revision } = await fixture(t);
    const allocateBody = allocation(revision);
    const allocated = await invoke(registry, "/allocate", allocateBody);
    const confirmBody = { expected_revision: allocated.body.revision, idempotency_key: "confirm-before-delete", mail_account_id: "mailbox-1", operation_id: "allocate-1", gate: { owner_shard_id: "shard-b", epoch: "1", mode: "active" } };
    const confirmed = await invoke(registry, "/confirm", confirmBody);
    const deleted = await invoke(registry, "/tombstone", { expected_revision: confirmed.body.revision, idempotency_key: "delete-after-confirm", mail_account_id: "mailbox-1" });
    const beforeReplay = clone(storage.values);
    assert.deepEqual((await invoke(registry, "/allocate", allocateBody)).body, allocated.body);
    assert.deepEqual((await invoke(registry, "/confirm", confirmBody)).body, confirmed.body);
    assert.deepEqual(storage.values, beforeReplay);
    const current = await invoke(registry, "/snapshot");
    assert.equal(current.body.revision, deleted.body.revision);
    assert.deepEqual(current.body.mailbox_routes, {});
    assert.equal((await invoke(registry, "/route?mail_account_id=mailbox-1")).body.error_code, "MAILBOX_DELETED");
});

test("changing a referenced physical owner is rejected, even while provisioning is pending", async t => {
    const { registry, revision } = await fixture(t);
    const allocated = await invoke(registry, "/allocate", allocation(revision));
    const changed = config();
    changed.shards[1].database_id = "different-database";
    const result = await invoke(registry, "/configure", { expected_revision: allocated.body.revision, idempotency_key: "configure-2", config: changed });
    assert.equal(result.body.error_code, "CONFIG_CONFLICT");
});

for (const changedIdentity of ["provider", "database", "added-shard"]) {
    test(`configuration change requalifies metrics for ${changedIdentity}`, async t => {
        const { registry, storage, revision } = await fixture(t, { mode: "observe" });
        const changed = clone(storage.values.get("registry:meta").config);
        if (changedIdentity === "provider") changed.accounts[1].provider_account_id = "new-provider";
        if (changedIdentity === "database") changed.shards[1].database_id = "new-database";
        if (changedIdentity === "added-shard") changed.shards.push(shard("shard-c", "remote"));
        const configured = await invoke(registry, "/configure", { expected_revision: revision, idempotency_key: "replace-identity", config: changed });
        assert.equal(configured.status, 200);
        let nextRevision = configured.body.revision;
        const plan = () => invoke(registry, "/plan", { expected_revision: nextRevision });
        assert.deepEqual((await plan()).body.decision, { ok: false, error_code: "STALE_METRICS" });
        assert.equal(storage.values.get("registry:meta").config.accounts[1].metrics_observed_at, null);
        for (let index = 0; index < 3; index++) {
            const sample = report("remote", NOW - (2 - index) * 300_000);
            sample.snapshot.rows_read = 1;
            sample.snapshot.rows_written = 1;
            sample.snapshot.worker_requests = 1;
            if (changedIdentity === "added-shard") sample.snapshot.shard_sizes["shard-c"] = 0;
            const accepted = await invoke(registry, "/metrics", { expected_revision: nextRevision, idempotency_key: `replacement-sample-${index}`, report: sample });
            assert.equal(accepted.status, 200);
            assert.equal(accepted.body.consecutive_valid_samples, index + 1);
            nextRevision = accepted.body.revision;
            assert.equal((await plan()).body.decision.ok, index === 2);
        }
    });
}

test("credential rotation and reordered configuration retain unchanged resource metrics", async t => {
    const { registry, storage, revision } = await fixture(t, { mode: "observe" });
    const changed = config();
    changed.accounts[1].credential_ref = "rotated-metrics";
    changed.shards[1].credential_ref = "rotated-data";
    changed.accounts.reverse();
    changed.shards.reverse();
    const before = clone(storage.values.get("registry:metrics:remote"));
    const configured = await invoke(registry, "/configure", { expected_revision: revision, idempotency_key: "rotate-credentials", config: changed });
    assert.equal(configured.status, 200);
    assert.deepEqual(storage.values.get("registry:metrics:remote"), before);
    assert.equal((await invoke(registry, "/plan", { expected_revision: configured.body.revision })).body.decision.ok, true);
});

test("full fleet replacement retires old metrics and reads current accounts regardless of historical key order", async t => {
    const { registry, storage, revision } = await fixture(t, { mode: "observe" });
    const many = config();
    many.accounts = [account("main"), ...Array.from({ length: 11 }, (_, i) => account(`a${String(i).padStart(2, "0")}`))];
    many.shards = [shard("primary", "main"), ...Array.from({ length: 11 }, (_, i) => shard(`s${i}`, many.accounts[i + 1].account_key))];
    let current = await invoke(registry, "/configure", { expected_revision: revision, idempotency_key: "full-fleet", config: many });
    assert.equal(current.status, 200);
    assert.equal(storage.values.has("registry:metrics:remote"), false);
    for (const entry of many.accounts) {
        const sample = report(entry.account_key);
        sample.snapshot.shard_sizes = Object.fromEntries(many.shards.filter(item => item.account_key === entry.account_key).map(item => [item.shard_id, 0]));
        current = await invoke(registry, "/metrics", { expected_revision: current.body.revision, idempotency_key: `sample-${entry.account_key}`, report: sample });
        assert.equal(current.status, 200);
    }
    for (const replacement of ["z-new", "b-next"]) {
        const retired = many.accounts[11].account_key;
        many.accounts[11] = account(replacement);
        many.shards[11] = shard("replacement", replacement);
        for (let index = 1; index < 11; index++) many.shards[index].state = "disabled";
        current = await invoke(registry, "/configure", { expected_revision: current.body.revision, idempotency_key: `configure-${replacement}`, config: many });
        assert.equal(current.status, 200);
        assert.equal(storage.values.has(`registry:metrics:${retired}`), false);
        for (let index = 0; index < 3; index++) {
            const sample = report(replacement, NOW - (2 - index) * 300_000);
            sample.snapshot.shard_sizes = { replacement: 0 };
            current = await invoke(registry, "/metrics", { expected_revision: current.body.revision, idempotency_key: `${replacement}-${index}`, report: sample });
            assert.equal(current.status, 200);
        }
        // Simulate stale records left by an older release. They must never
        // occupy slots in the current configuration's bounded metrics read.
        for (let index = 0; index < 12; index++) storage.values.set(`registry:metrics:0-retired-${index}`, { report: report(`retired-${index}`), consecutive_valid_samples: 3 });
        const planned = await invoke(registry, "/plan", { expected_revision: current.body.revision });
        assert.equal(planned.body.decision.account_key, replacement);
    }
});

test("failed configuration commit restores both physical identity and metric eligibility", async t => {
    const { registry, storage, revision } = await fixture(t, { mode: "observe" });
    t.mock.method(console, "error", () => undefined);
    const changed = config();
    changed.shards[1].database_id = "new-database";
    const before = clone(storage.values);
    storage.failOnKey = "registry:meta";
    const result = await invoke(registry, "/configure", { expected_revision: revision, idempotency_key: "failed-replacement", config: changed });
    assert.equal(result.status, 503);
    assert.deepEqual(storage.values, before);
    assert.equal((await invoke(registry, "/plan", { expected_revision: revision })).body.decision.ok, true);
});

test("revision exhaustion cannot partially reserve capacity", async t => {
    const { registry, storage } = await fixture(t);
    const meta = storage.values.get("registry:meta");
    meta.revision = "18446744073709551615";
    const result = await invoke(registry, "/allocate", allocation(meta.revision));
    assert.equal(result.body.error_code, "COUNTER_OVERFLOW");
    assert.equal(storage.values.has("registry:mailbox:mailbox-1"), false);
});

test("failed durable commit rolls back owner, reservation and idempotency record", async t => {
    const { registry, storage, revision } = await fixture(t);
    t.mock.method(console, "error", () => undefined);
    storage.failOnKey = "registry:meta";
    const body = allocation(revision);
    assert.equal((await invoke(registry, "/allocate", body)).status, 503);
    assert.equal(storage.values.has("registry:mailbox:mailbox-1"), false);
    assert.equal(storage.values.has("registry:allocation-budgets"), false);
    const retry = await invoke(registry, "/allocate", body);
    assert.equal(retry.status, 200);
    assert.equal(storage.values.get("registry:allocation-budgets").remote.reserved_write, 1000);
});

test("unconfigured registry and missing owner never turn into a successful empty local map", async t => {
    const registry = new FleetRegistryDurableObject({ storage: new Storage() }, {});
    assert.equal((await invoke(registry, "/snapshot")).body.error_code, "NOT_CONFIGURED");
    const ready = await fixture(t);
    ready.storage.values.set("registry:route:broken", { mail_account_id: "broken", owner_shard_id: "missing", epoch: "1", state: "active", migration_id: null, updated_at: instant(NOW) });
    assert.equal((await invoke(ready.registry, "/snapshot")).body.error_code, "MISSING_OWNER");
});

test("oversized streaming request and unknown request fields are rejected", async t => {
    const { registry, revision } = await fixture(t);
    const extra = await invoke(registry, "/allocate", { ...allocation(revision), token: "unexpected-secret" });
    assert.equal(extra.status, 400);
    const huge = await registry.fetch(new Request("https://registry.test/import", { method: "POST", body: "x".repeat(256 * 1024 + 1) }));
    assert.equal(huge.status, 413);
});

test("operation retention is bounded and pruning never releases unknown-outcome reservations", async t => {
    const { registry, storage, revision } = await fixture(t);
    const staleTime = NOW - 31 * 86_400_000;
    storage.values.set("registry:op:expired", { fingerprint: "old", response: {}, created_at: staleTime });
    storage.values.set(`registry:audit:${String(staleTime).padStart(16, "0")}:expired`, "registry:op:expired");
    storage.values.get("registry:meta").operation_count++;
    const allocated = await invoke(registry, "/allocate", allocation(revision));
    assert.equal(allocated.status, 200);
    assert.equal(storage.values.has("registry:op:expired"), false);
    assert.equal(storage.values.get("registry:allocation-budgets").remote.reserved_write, 1000);
});

test("client uses one named registry, validates public snapshots and fails closed without binding", async t => {
    const { registry } = await fixture(t);
    const names = [];
    const env = { FLEET_REGISTRY: { idFromName(name) { names.push(name); return name; }, get() { return { fetch: (url, options) => {
        assert.equal(options.redirect, "manual", "Workers only supports follow/manual redirect modes");
        return registry.fetch(new Request(url, options));
    } }; } } };
    assert.equal((await getFleetRegistrySnapshot(env)).revision, "4");
    assert.deepEqual(names, [FLEET_REGISTRY_OBJECT_NAME]);
    await assert.rejects(getFleetRegistrySnapshot({}), /REGISTRY_UNAVAILABLE/);
    await assert.rejects(requestFleetRegistry(env, "https://attacker.test"), /INVALID_REQUEST/);
});

test("registry redirects are cancelled and never exposed as domain responses", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const env = { FLEET_REGISTRY: { idFromName: name => name, get: () => ({ fetch: async () => new Response(body, { status: 302, headers: { location: "https://wrong.example" } }) }) } };
    await assert.rejects(getFleetRegistrySnapshot(env), error => error.code === "REGISTRY_UNAVAILABLE" && error.status === 503);
    assert.equal(cancelled, true);
});

test("client enforces its deadline when the registry fetch ignores AbortSignal", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    const env = { FLEET_REGISTRY: { idFromName: name => name, get: () => ({ fetch(_url, options) { signal = options.signal; return new Promise(() => undefined); } }) } };
    const rejected = assert.rejects(getFleetRegistrySnapshot(env), /REGISTRY_UNAVAILABLE/);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(5000);
    await rejected;
    assert.equal(signal.aborted, true);
});

test("one deadline covers a stalled body and cleanup remains bounded if cancel also stalls", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let cancellations = 0;
    const body = new ReadableStream({ cancel() { cancellations++; return new Promise(() => undefined); } });
    const env = { FLEET_REGISTRY: { idFromName: name => name, get: () => ({ fetch: async () => new Response(body) }) } };
    let settled = false;
    const request = getFleetRegistrySnapshot(env);
    const rejected = assert.rejects(request, /REGISTRY_UNAVAILABLE/).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(body.locked, true);
    t.mock.timers.tick(4999);
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(cancellations, 1);
    t.mock.timers.tick(25);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(body.locked, false);
});

test("upstream cancellation rejects ignored-abort fetch promptly and an already aborted request never starts", async () => {
    let requests = 0;
    const env = { FLEET_REGISTRY: { idFromName: name => name, get: () => ({ fetch() { requests++; return new Promise(() => undefined); } }) } };
    const controller = new AbortController();
    const rejected = assert.rejects(getFleetRegistrySnapshot(env, controller.signal), /REGISTRY_UNAVAILABLE/);
    controller.abort(new Error("caller disconnected"));
    await rejected;
    assert.equal(requests, 1);
    await assert.rejects(getFleetRegistrySnapshot(env, controller.signal), /REGISTRY_UNAVAILABLE/);
    assert.equal(requests, 1);
});

test("oversized body cannot hold the request open by ignoring cancellation", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(11)); }, cancel() { return new Promise(() => undefined); } });
    const rejected = assert.rejects(readFleetJson({ body }, 10), error => error.status === 413);
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(25);
    await rejected;
    assert.equal(body.locked, false);
});

test("malformed upstream JSON, excessive body and invalid snapshot are service failures with preserved causes", async () => {
    const responses = [
        () => new Response("{incomplete"),
        () => new Response("x".repeat(1024 * 1024 + 1)),
        () => Response.json({ v: 2, revision: "01", published_at: instant(NOW), mailbox_routes: {}, shards: {} }),
        () => Response.json({ ok: false, error_code: "PRIVATE_SQL_ERROR", retryable: false, request_id: "private-content" }, { status: 400 }),
    ];
    for (const response of responses) {
        const env = { FLEET_REGISTRY: { idFromName: name => name, get: () => ({ fetch: async () => response() }) } };
        await assert.rejects(getFleetRegistrySnapshot(env), error => error.code === "REGISTRY_UNAVAILABLE" && error.status === 503 && error.retryable && error.cause instanceof Error);
    }
});

test("valid upstream domain errors retain status while malformed success bodies are rejected", async () => {
    const env = { FLEET_REGISTRY: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ ok: false, error_code: "REVISION_CONFLICT", retryable: true, request_id: "12345678-1234-1234-1234-123456789abc" }, { status: 409 }) }) } };
    await assert.rejects(requestFleetRegistry(env, "/metrics", { method: "POST", body: {} }), error => error.code === "REVISION_CONFLICT" && error.status === 409);
    env.FLEET_REGISTRY.get = () => ({ fetch: async () => Response.json({ ok: true, revision: "1", private: "secret" }) });
    for (const path of ["/configure", "/metrics", "/plan"]) await assert.rejects(requestFleetRegistry(env, path, { method: "POST", body: {} }), error => error.code === "REGISTRY_UNAVAILABLE" && error.status === 503);
});
