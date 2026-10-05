import { Context } from "hono";
import type { RawMailRow } from "../models";

/**
 * raw_mails 表列表/计数/单行读取唯一实现（架构重构 P6，灭 T4）。
 * 运行时仅引 hono；RawMailRow 为共享的 type-only import。
 *
 * 各调用方在本模块之外不应再内联 raw_mails 的列表/计数/单行读 SQL。
 * DELETE / INSERT 及其他表操作不在本模块职责范围内。
 */
export const listRawMails = async (
  c: Context<HonoCustomType>,
  address: string,
  opts?: { limit?: number; offset?: number },
): Promise<RawMailRow[]> => {
  if (opts?.limit) {
    const rows = await c.env.DB.prepare(
      `SELECT * FROM raw_mails WHERE address = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).bind(address, opts.limit, opts.offset ?? 0).all<RawMailRow>();
    return rows.results;
  }
  const rows = await c.env.DB.prepare(
    `SELECT * FROM raw_mails WHERE address = ? ORDER BY id DESC`,
  ).bind(address).all<RawMailRow>();
  return rows.results;
};

export const countRawMails = async (
  c: Context<HonoCustomType>,
  address: string,
): Promise<number> => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM raw_mails WHERE address = ?`,
  ).bind(address).first<{ c: number }>();
  return row?.c ?? 0;
};

/** 单封 raw_mails 读取（id + address 主键）。与 listRawMails / countRawMails 锁步，
 *  使 mails_crud.ts / parsed_mail_api.ts 不再内联 raw_mails SQL。 */
export const getRawMail = async (
  c: Context<HonoCustomType>,
  id: string,
  address: string,
): Promise<RawMailRow | null> => {
  return c.env.DB.prepare(
    `SELECT * FROM raw_mails WHERE id = ? AND address = ?`,
  ).bind(id, address).first<RawMailRow>();
};