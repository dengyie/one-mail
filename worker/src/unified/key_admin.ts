import { Context } from "hono";
import { hashKey } from "./api_keys";

const genKey = (): string =>
    `omk_${Array.from(crypto.getRandomValues(new Uint8Array(24))).map((b) => b.toString(16).padStart(2, "0")).join("")}`;

export const createKey = async (c: Context<HonoCustomType>) => {
    const body = await c.req.json<{
        name?: string; role?: string; allowed_sources?: string[]; allowed_accounts?: string[];
    }>().catch(() => ({}));
    if (!body.name) return c.json({ error: "name required" }, 400);
    const key = genKey();
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
        `INSERT INTO api_keys (id,name,key_hash,role,allowed_sources,allowed_accounts,enabled,created_at)
         VALUES (?,?,?,?,?,?,1,?)`
    ).bind(
        id, body.name, await hashKey(key),
        body.role === "admin" ? "admin" : "readonly",
        body.allowed_sources ? JSON.stringify(body.allowed_sources) : null,
        body.allowed_accounts ? JSON.stringify(body.allowed_accounts) : null,
        Date.now(),
    ).run();
    // 明文 key 仅此一次返回
    return c.json({ id, name: body.name, key, role: body.role ?? "readonly" });
};