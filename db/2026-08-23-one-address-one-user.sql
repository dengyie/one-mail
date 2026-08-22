-- one-mail review C1: 外部邮箱一址一户
-- 对 enabled=1 的 username 加部分唯一索引：同一外部邮箱地址同时只能被一个用户接入。
-- disabled 历史行不参与唯一约束（可删后重连、可停用后再被他人接入），仅 enabled 行互斥。
-- 部分唯一索引在 INSERT 匹配 WHERE(enabled=1) 时触发 UNIQUE 约束，与 ensureExternalBinding
-- 的 INSERT OR IGNORE 语义配合，从源头关掉「攻击者接入 victim@x.com 向他人注入伪造邮件」的路径。
-- 前置条件：若现网已存在两条 enabled=1 同名 username 行，CREATE UNIQUE INDEX 会失败——
-- 须先 SELECT username,COUNT(*) FROM user_mail_accounts WHERE enabled=1 GROUP BY username HAVING COUNT(*)>1
-- 查出并 disable 重复项，再跑此迁移。幂等 IF NOT EXISTS，与 db/ 既有迁移一致。
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_mail_accounts_username_uq
  ON user_mail_accounts(username) WHERE enabled = 1;