/** Fleet JSON contracts. Epochs are uint64 decimal strings, never JS numbers. */
export type Epoch = string;
export type UtcInstant = string;
export type FleetMode = "legacy-static" | "observe" | "allocate" | "rebalance";
export type ShardState = "prepared" | "healthy" | "draining" | "degraded" | "exhausted" | "disabled";
export type RouteState = "active" | "frozen" | "deleting";
export type Confidence = "authoritative" | "partial" | "stale";

export interface PublicShard {
    readonly shard_id: string;
    readonly account_key: string;
    readonly base_url: string;
    readonly state: ShardState;
    readonly schema_version: number;
    readonly protocol_version: number;
    readonly storage_limit_bytes: number;
    readonly observed_size_bytes: number;
}

export interface Shard extends PublicShard {
    readonly database_id: string;
    readonly credential_ref: string;
}

export interface CloudAccount {
    readonly account_key: string;
    readonly provider_account_id: string;
    readonly enabled: boolean;
    readonly credential_ref: string;
    readonly daily_read_limit: number;
    readonly daily_write_limit: number;
    readonly worker_request_limit: number;
    readonly metrics_observed_at: UtcInstant | null;
}

export interface MailboxRoute {
    readonly mail_account_id: string;
    readonly owner_shard_id: string;
    readonly epoch: Epoch;
    readonly state: RouteState;
    readonly migration_id: string | null;
    readonly updated_at: UtcInstant;
}

export interface FleetSnapshot {
    readonly v: 2;
    readonly revision: Epoch;
    readonly published_at: UtcInstant;
    readonly mailbox_routes: Readonly<Record<string, MailboxRoute>>;
    readonly shards: Readonly<Record<string, PublicShard>>;
}

export interface MetricSnapshot {
    readonly account_key: string;
    readonly utc_date: string;
    readonly observed_at: UtcInstant;
    readonly source: "cloudflare_graphql" | "application_meta" | "reconciled";
    readonly rows_read: number;
    readonly rows_written: number;
    readonly worker_requests: number;
    readonly confidence: Confidence;
    readonly shard_sizes: Readonly<Record<string, number>>;
}

/** Forecast includes observed consumption and conservative unobserved/background work. */
export interface MetricReport {
    readonly snapshot: MetricSnapshot;
    readonly projected_rows_read: number;
    readonly projected_rows_written: number;
    readonly projected_worker_requests: number;
}

export interface MetricSeries {
    readonly report: MetricReport;
    readonly consecutive_valid_samples: number;
    /** Retain the last accepted cumulative sample across invalid/regressing input. */
    readonly baseline?: MetricReport;
}

export interface ResourceBudget {
    readonly reserved_read: number;
    readonly reserved_write: number;
    readonly reserved_worker_requests: number;
    readonly reserved_bytes: number;
}

export interface FleetConfig {
    readonly accounts: readonly CloudAccount[];
    readonly shards: readonly Shard[];
    readonly primary_shard_id: string;
    readonly required_schema_version: number;
    readonly required_protocol_version: number;
    readonly allocation_budget: ResourceBudget;
    readonly max_mailboxes: number;
}

export interface MutationRequest {
    readonly expected_revision: Epoch;
    readonly idempotency_key: string;
}

export interface ConfigureRequest extends MutationRequest { readonly config: FleetConfig }

export interface ImportEntry {
    readonly route: MailboxRoute;
    readonly user_key: string;
    /** Set only after the trusted importer has checked the durable target gate. */
    readonly gate_confirmed: true;
}

export interface ImportRequest extends MutationRequest { readonly mailboxes: readonly ImportEntry[] }

export interface AllocateRequest extends MutationRequest {
    readonly mail_account_id: string;
    readonly user_key: string;
    /** Trusted provisioning caller must establish absence of existing email data. */
    readonly known_empty: true;
}

export interface PendingAllocation {
    readonly operation_id: string;
    readonly mail_account_id: string;
    readonly owner_shard_id: string;
    readonly epoch: Epoch;
    readonly created_at: UtcInstant;
}

export interface ConfirmRequest extends MutationRequest {
    readonly mail_account_id: string;
    readonly operation_id: string;
    readonly gate: {
        readonly owner_shard_id: string;
        readonly epoch: Epoch;
        readonly mode: "active";
    };
}

export interface TombstoneRequest extends MutationRequest { readonly mail_account_id: string }
export interface MetricsRequest extends MutationRequest { readonly report: MetricReport }

export interface PlanRequest {
    readonly expected_revision: Epoch;
    readonly affinity_shard_ids: readonly string[];
}

export const FLEET_ERROR_CODES = [
    "INVALID_REQUEST", "NOT_CONFIGURED", "CONFIG_CONFLICT", "MODE_DISABLED",
    "UNKNOWN_MAILBOX", "MISSING_OWNER", "MAILBOX_DELETED", "MAILBOX_NOT_EMPTY",
    "NO_CAPACITY", "STALE_METRICS", "REVISION_CONFLICT", "IDEMPOTENCY_CONFLICT",
    "GATE_MISMATCH", "COUNTER_OVERFLOW", "REGISTRY_LIMIT", "REGISTRY_UNAVAILABLE",
] as const;
export type FleetErrorCode = typeof FLEET_ERROR_CODES[number];

export interface FleetFailure {
    readonly ok: false;
    readonly error_code: FleetErrorCode;
    readonly retryable: boolean;
    readonly request_id: string;
}

export type AllocationDecision =
    | { readonly ok: true; readonly pending: PendingAllocation; readonly revision: Epoch }
    | { readonly ok: true; readonly route: MailboxRoute; readonly revision: Epoch }
    | FleetFailure;

export class FleetError extends Error {
    readonly code: FleetErrorCode;
    readonly status: number;
    readonly retryable: boolean;

    constructor(code: FleetErrorCode, status = 400, retryable = false, cause?: unknown) {
        super(code, { cause });
        this.name = "FleetError";
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}
