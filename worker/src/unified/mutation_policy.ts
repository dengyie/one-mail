export type MutationProvider = "native" | "imap" | "graph" | "pop3" | "unknown";

export type MutationIdentityRow = {
    source?: string | null;
    account_id?: string | null;
    provider?: string | null;
    source_folder?: string | null;
    provider_message_id?: string | null;
    source_key?: string | null;
    imap_uid?: string | null;
};

export const inferMutationProvider = (row: MutationIdentityRow): MutationProvider => {
    const explicit = String(row.provider || "").trim().toLowerCase();
    if (["native", "imap", "graph", "pop3"].includes(explicit)) {
        return explicit as MutationProvider;
    }
    const key = String(row.source_key || row.imap_uid || "").toLowerCase();
    if (key.startsWith("graph:")) return "graph";
    if (key.startsWith("pop3:")) return "pop3";
    if (key) return "imap";
    const source = String(row.source || "").toLowerCase();
    if (source === "cf_routing" || source === "cloudflare") return "native";
    if (source === "graph_outlook") return "graph";
    if (source.startsWith("imap_")) return "imap";
    return "unknown";
};

export const providerMutationSupport = (
    row: MutationIdentityRow,
): { ok: true; provider: "native" | "imap" | "graph" } | { ok: false; provider: MutationProvider; code: string } => {
    const provider = inferMutationProvider(row);
    if (provider === "native") return { ok: true, provider };
    if (!row.account_id) return { ok: false, provider, code: "missing_mail_account_identity" };
    if (provider === "pop3") return { ok: false, provider, code: "provider_write_unsupported" };
    if (provider === "graph") {
        return row.provider_message_id
            ? { ok: true, provider }
            : { ok: false, provider, code: "missing_provider_message_identity" };
    }
    if (provider === "imap") {
        return (row.source_folder && (row.source_key || row.imap_uid))
            ? { ok: true, provider }
            : { ok: false, provider, code: "missing_imap_message_identity" };
    }
    return { ok: false, provider, code: "provider_write_unsupported" };
};
