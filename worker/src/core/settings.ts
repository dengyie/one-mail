import { Context } from "hono";

/**
 * settings 表读写唯一实现（架构重构 P5，灭 T3）。
 * 仅引 hono、零相对 import。utils.ts 原实现改为 re-export 本模块；
 * quota.ts 以显式 .ts 扩展名相对 import 复用。
 * 行为与 utils.ts 原实现等价（含 DB 错→null 的 fail-soft）。
 */

export const getSetting = async (
  c: Context,
  key: string,
): Promise<string | null> => {
  try {
    const value = await c.env.DB.prepare(
      `SELECT value FROM settings where key = ?`,
    ).bind(key).first<string>("value");
    return value;
  } catch (error) {
    console.error(`GetSetting: Failed to get ${key}`, error);
    return null;
  }
};

export const saveSetting = async (
  c: Context,
  key: string,
  value: string,
): Promise<void> => {
  await c.env.DB.prepare(
    `INSERT or REPLACE INTO settings (key, value) VALUES (?, ?)`
      + ` ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
  ).bind(key, value, value).run();
};

export const deleteSetting = async (
  c: Context,
  key: string,
): Promise<void> => {
  await c.env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(key).run();
};

export const getJsonSetting = async <T = any>(
  c: Context,
  key: string,
): Promise<T | null> => {
  const value = await getSetting(c, key);
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch (e) {
    console.error(`GetJsonSetting: Failed to parse ${key}`, e);
    return null;
  }
};