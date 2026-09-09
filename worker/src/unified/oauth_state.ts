import type { Context } from "hono";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const STATE_KEY_PREFIX = "oauth_state:";

const stateKey = (state: string, clientID: string): string =>
  `${STATE_KEY_PREFIX}${encodeURIComponent(state)}:${encodeURIComponent(clientID)}`;

const resultChanges = (result: { meta?: { changes?: number } } | null | undefined): number =>
  Number(result?.meta?.changes ?? 0);

/**
 * Consume an OAuth state with one atomic D1 DELETE. The key includes the
 * client ID, so a callback for another OAuth client cannot consume it.
 * Concurrent callbacks race on the same row; exactly one DELETE changes a row.
 */
export const verifyOAuthState = async (
  c: Context,
  state: string,
  clientID: string
): Promise<boolean> => {
  if (!c.env.DB || !state || !clientID) return false;
  try {
    const result = await c.env.DB.prepare(
      "DELETE FROM settings WHERE key = ? AND CAST(value AS INTEGER) > ?"
    ).bind(stateKey(state, clientID), Date.now()).run();
    return resultChanges(result) === 1;
  } catch {
    return false;
  }
};

/**
 * R3：解析 callback 的 state——body.state 优先，query.state 兜底。
 * 空串 / 非 string 一律归一为空串（调用方据此 fail-closed 拒绝）。
 * hono-only，零相对 import，node --test 可直跑。
 */
export const resolveOAuthState = (bodyState: unknown, queryState: unknown): string => {
  if (typeof bodyState === "string" && bodyState.length > 0) return bodyState;
  if (typeof queryState === "string" && queryState.length > 0) return queryState;
  return "";
};

/**
 * Store a server-generated OAuth state in the existing D1 settings table.
 * Expired namespaced rows are pruned opportunistically before the insert.
 */
export const storeOAuthState = async (
  c: Context,
  state: string,
  clientID: string
): Promise<boolean> => {
  if (!c.env.DB || !state || !clientID) return false;
  try {
    const now = Date.now();
    await c.env.DB.prepare(
      "DELETE FROM settings WHERE key LIKE ? AND CAST(value AS INTEGER) <= ?"
    ).bind(`${STATE_KEY_PREFIX}%`, now).run();
    const result = await c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES(?,?,datetime('now'))"
    ).bind(stateKey(state, clientID), String(now + STATE_TTL_MS)).run();
    return resultChanges(result) === 1;
  } catch {
    return false;
  }
};
