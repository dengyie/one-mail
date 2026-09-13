import type { Context } from "hono";

import { scopeQuery } from "./api_keys.ts";

export type UnifiedFolderRow = {
    id: number;
    mail_account_id: string;
    provider: string;
    provider_folder_id: string | null;
    canonical_name: string;
    display_name: string | null;
    folder_type: string;
    uidvalidity: number | null;
};

const csv = (value?: string): string[] =>
    String(value || "").split(",").map((item) => item.trim()).filter(Boolean);

const inClause = (values: string[]): string => values.map(() => "?").join(",");

const addSourceFilter = (
    where: string[],
    params: (string | number)[],
    sources: string[],
) => {
    if (!sources.length) return;
    // Folder rows intentionally do not duplicate account source. Derive source
    // visibility from indexed email ownership instead of assuming every account
    // lives in user_mail_accounts (admin/static aggregator accounts may not).
    where.push(`EXISTS (
        SELECT 1 FROM emails e
         WHERE e.account_id = f.mail_account_id
           AND e.provider = f.provider
           AND e.source IN (${inClause(sources)})
    )`);
    params.push(...sources);
};

export async function resolveMoveTarget(
    c: Context<HonoCustomType>,
    accountId: string,
    provider: string,
    folderId: number,
): Promise<UnifiedFolderRow | null> {
    if (!Number.isSafeInteger(folderId) || folderId <= 0) return null;
    return await c.env.DB.prepare(
        `SELECT id, mail_account_id, provider, provider_folder_id, canonical_name,
                display_name, folder_type, uidvalidity
           FROM mail_account_folders
          WHERE id = ? AND mail_account_id = ? AND provider = ?`,
    ).bind(folderId, accountId, provider).first<UnifiedFolderRow>();
}

export async function listFolders(c: Context<HonoCustomType>) {
    const requestedAccount = c.req.query("account_id")?.trim() || undefined;
    const requestedSource = c.req.query("source")?.trim() || undefined;
    const userAuth = c.get("unifiedUserAuth");
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (userAuth) {
        if (!userAuth.isAdmin) {
            where.push(`EXISTS (
                SELECT 1 FROM user_mail_accounts uma
                 WHERE uma.id = f.mail_account_id AND uma.user_id = ?
            )`);
            params.push(userAuth.userPayload.user_id);
        }
        if (requestedAccount) {
            const accounts = csv(requestedAccount);
            if (!accounts.length) return c.json({ results: [] });
            where.push(`f.mail_account_id IN (${inClause(accounts)})`);
            params.push(...accounts);
        }
        if (requestedSource) {
            const sources = csv(requestedSource);
            if (!sources.length) return c.json({ results: [] });
            addSourceFilter(where, params, sources);
        }
    } else {
        const key = c.get("apiKey");
        if (!key) return c.json({ error: "forbidden" }, 403);
        const scoped = scopeQuery(key, { account_id: requestedAccount, source: requestedSource });
        const accounts = csv(scoped.account_id);
        const sources = csv(scoped.source);
        if (accounts.length) {
            where.push(`f.mail_account_id IN (${inClause(accounts)})`);
            params.push(...accounts);
        }
        addSourceFilter(where, params, sources);
    }

    const sql = `SELECT f.id, f.mail_account_id AS account_id, f.provider,
                        f.provider_folder_id, f.canonical_name, f.display_name,
                        f.folder_type, f.uidvalidity
                   FROM mail_account_folders f
                  ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                  ORDER BY f.mail_account_id ASC,
                           CASE f.folder_type
                             WHEN 'inbox' THEN 0 WHEN 'archive' THEN 1
                             WHEN 'sent' THEN 2 WHEN 'drafts' THEN 3
                             WHEN 'trash' THEN 4 WHEN 'spam' THEN 5 ELSE 6
                           END,
                           COALESCE(f.display_name, f.canonical_name) ASC`;
    const { results } = await c.env.DB.prepare(sql).bind(...params).all();
    return c.json({ results: results || [] });
}