-- one-mail: 外部账号发信出站任务队列。
-- 每条记录是一次「以已接入外部邮箱身份发信」的请求，由聚合器认领后经
-- SMTP/OAuth/Graph 适配器执行并回写结果。发送不可逆：超时不得当失败重试，
-- 聚合器必须先对账服务商「已发送」文件夹再回写 succeeded/retry/failed。
-- 幂等键 request_hash = SHA-256(account_id + from_addr + to_addr + subject + body)，
-- 唯一索引 (account_id, request_hash) 去重，二次提交直接返回已有结果。
--
-- 本文件只建新表，完全幂等，可反复执行。user_mail_accounts.can_send 的
-- ALTER 在 2026-10-05-user-mail-accounts-can-send.sql 中单独迁移（按列存在
-- 与否条件渲染）。

CREATE TABLE IF NOT EXISTS outbound_mail_jobs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,            -- 外部账号 id（user_mail_accounts 或 config 静态账号）
    from_addr TEXT NOT NULL,             -- 发件身份（账号邮箱）
    to_addr TEXT NOT NULL,               -- 收件地址
    subject TEXT NOT NULL,
    body_text TEXT,                      -- 纯文本正文（is_html=0）
    body_html TEXT,                      -- HTML 正文（is_html=1）
    payload_json TEXT NOT NULL,          -- 完整请求快照（含 to_name/from_name 等）
    request_hash TEXT NOT NULL,          -- 幂等键
    provider TEXT NOT NULL,              -- imap_qq|imap_163|imap_gmail|imap_outlook|graph_outlook|imap_custom
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'processing', 'succeeded', 'failed', 'unsupported', 'superseded')
    ),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER,
    provider_message_id TEXT,            -- 发送成功后的 provider 消息 id
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_outbound_mail_jobs_ready
    ON outbound_mail_jobs(status, next_attempt_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_mail_jobs_request_hash
    ON outbound_mail_jobs(account_id, request_hash);
CREATE INDEX IF NOT EXISTS idx_outbound_mail_jobs_account
    ON outbound_mail_jobs(account_id, status, created_at);
