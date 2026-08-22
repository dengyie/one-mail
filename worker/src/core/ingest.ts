import { Context } from "hono";

/**
 * emails 表 17 列 INSERT 唯一实现（架构重构 P6，灭 T4）。
 * 仅引 hono、零相对 import（项目测试约束）。
 * 列清单/顺序与 unified/ingest.ts + unified/unified_store.ts 原实现逐字一致
 * （两处同源，均为 17 列同序）。必须保留 `INSERT OR IGNORE`：
 * ingest.insertEmails 依赖 meta.changes 统计 inserted/skipped，
 * 去掉 OR IGNORE 后重复 id 会抛唯一约束错误，破坏原语义。
 */
export const INSERT_EMAIL_SQL = `INSERT OR IGNORE INTO emails
  (id,source,account_id,from_addr,to_addr,subject,text_body,html_body,
   received_at,internal_date,headers_json,is_read,flags_json,attachments_json,
   raw_ref,imap_uid,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export const insertEmail = async (
  c: Context,
  params: unknown[],
): Promise<{ success: boolean; meta: unknown }> => {
  return c.env.DB.prepare(INSERT_EMAIL_SQL).bind(...(params as never[])).run();
};
