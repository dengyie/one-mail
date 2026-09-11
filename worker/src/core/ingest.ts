import { Context } from "hono";

/**
 * emails INSERT 的唯一实现。
 *
 * 旧字段顺序保持不变，新 provider identity 字段只追加在尾部，减少调用方迁移
 * 风险。必须保留 INSERT OR IGNORE：主键、legacy imap_uid、source_key 或稳定
 * provider message identity 任一唯一约束命中时，都应被视为幂等重复而不是 500。
 */
export const INSERT_EMAIL_SQL = `INSERT OR IGNORE INTO emails
  (id,source,account_id,from_addr,to_addr,subject,text_body,html_body,
   received_at,internal_date,headers_json,is_read,flags_json,attachments_json,
   raw_ref,imap_uid,updated_at,
   provider,source_folder,source_folder_id,provider_message_id,provider_thread_id,
   message_id_header,in_reply_to,references_json,has_attachments,source_key,sync_version)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export const insertEmail = async (
  c: Context,
  params: unknown[],
): Promise<{ success: boolean; meta: unknown }> => {
  return c.env.DB.prepare(INSERT_EMAIL_SQL).bind(...(params as never[])).run();
};
