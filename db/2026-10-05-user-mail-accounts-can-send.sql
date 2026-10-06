-- 凭据从「可读」升级为「可发」的显式开关，默认关闭（管理员逐账号开启）。
-- 非幂等：由 render_outbound_mail_migration.py 按「can_send 列是否存在」条件渲染，
-- 仅在缺少该列时输出并执行，避免重复 ALTER 报 duplicate column name。

ALTER TABLE user_mail_accounts ADD COLUMN can_send INTEGER NOT NULL DEFAULT 0;
