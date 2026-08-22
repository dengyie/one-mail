# 自助接入外部邮箱归集

普通用户可把自己的外部邮箱（Gmail / QQ / 163 / Outlook 或任意 IMAP/POP3 邮箱）归集进统一收件箱，每人只看到自己的邮件。适合站点开放给多人使用时的邮箱账号隔离场景。

## 前置条件

- 已部署统一收件箱账户体系并开启用户登录（`ADMIN_USER_ROLE` 等）。
- Worker 配置 `MAIL_CRED_ENCRYPTION_KEY`（32 字节 base64，`openssl rand -base64 32` 生成）。未配置时该功能 fail-closed 不可用。
- 后端运行 one-mail IMAP 聚合器（Python，每 5 分钟一轮），负责实际抓取外部邮箱并回灌 `emails` 表。Worker 不能持长 TCP 连接做 IMAP/POP3，故抓取必须由聚合器完成。

## 工作原理

1. 用户在前端「我的邮箱」页填入外部邮箱的 IMAP/POP3 主机、端口、邮箱地址、应用密码 / 授权码（协议 `auto`/`imap`/`pop3`），提交保存。
2. Worker 用 AES-GCM（`MAIL_CRED_ENCRYPTION_KEY`）加密凭据后存入 D1 `user_mail_accounts.cred_enc`，明文绝不落盘。
3. 聚合器每轮从 `GET /admin/unified/mail_accounts`（`x-admin-auth` 保护）拉取所有 `enabled=1` 的用户邮箱，解密凭据后登录抓取，邮件以 `to_addr = 邮箱地址` 写入。`to_addr` 恒取接入时填的 `username`（不取邮件 `To:` 头），保证 alias / 邮件列表转发 / bcc / 多收件人等场景下邮件都能被邮箱主人看到；原 `To:` 头仍在 `headers_json` 完整保留。
4. 统一收件箱按 `to_addr` 隔离：普通用户的归属作用域 = 其绑定的本站地址 ∪ 其接入的外部邮箱 `username`，故只能看到自己的邮件；管理员看全部。
5. 每轮同步后聚合器回写 `last_sync_at` / `last_error`（`POST /admin/unified/mail_accounts/:id/status`，`x-admin-auth` 保护）：登录失败（如应用密码填错）会在「我的邮箱」页的 `last_error` 直接显示原因，不再默默不收信。

## 用户端点（`x-user-token` 鉴权）

```bash
GET  /user_api/mail_accounts            # 列出自己的接入邮箱（响应永不返回 cred_enc）
POST /user_api/mail_accounts            # 接入新邮箱
DELETE /user_api/mail_accounts/:id      # 删除（WHERE user_id 防越权）
POST /user_api/mail_accounts/:id/toggle # 启停
```

创建请求体：

```json
{
  "label": "我的 QQ",
  "source": "imap_qq",
  "host": "imap.qq.com",
  "port": 993,
  "username": "you@qq.com",
  "cred": "应用密码 / 授权码",
  "protocol": "auto",
  "folders": ["INBOX"]
}
```

`source` 枚举：`imap_gmail` / `imap_outlook` / `imap_qq` / `imap_163` / `imap_custom`。接入操作 5 次/分钟/IP 限流。

## 接入数量配额

每用户可接入的外部邮箱数量上限默认 **5**，按角色可配（admin 后台「角色地址配置」页的「外部邮箱上限」列）：

- 配置项存 D1 `settings` 表 `role_address_config` 键，结构为 `RoleConfig.maxMailAccountCount`（`{"<role>":{"maxMailAccountCount": <n>}}`）。
- 角色未配置 `maxMailAccountCount`、或值为负数 → 回退默认 5。
- `0` 表示**不限制**（与地址配额 `maxAddressCount` 同口径）。

外部邮箱接入**独立计数**，不消耗本站地址配额（`maxAddressCount`）：用户接入的外部邮箱绑定的 `source_meta='external'` 占位行不计入 `isAddressCountLimitReached` 的地址计数，因此接入外部邮箱不会挤占用户在本站域名下建址的名额。

## 聚合器凭据拉取端点（管理员）

```bash
GET /admin/unified/mail_accounts
Header: x-admin-auth: <admin_password>
```

返回所有 `enabled=1` 的用户邮箱，含解密后的明文凭据，仅供聚合器在内存中短时使用：

```json
{ "accounts": [ { "id": "...", "source": "imap_qq", "host": "...", "port": 993,
  "username": "you@qq.com", "password": "<明文>", "protocol": "auto",
  "folders": ["INBOX"], "oauth": null } ] }
```

## 安全要点

- `MAIL_CRED_ENCRYPTION_KEY` 只存 `wrangler.toml`（gitignored）与密码库，绝不提交。轮换密钥需重新加密全部凭据。
- `cred_enc` 永不通过任何 `user_api` 端点返回，仅 `/admin/unified/mail_accounts` 在 admin token 下解密返回。
- 删除/启停/查询全部 `WHERE user_id = ?` 限定，防越权。
- 一个外部邮箱地址只能被一个用户接入：第二个用户接入同名地址会被拒绝（400，DB 部分唯一索引兜底），从源头防止跨用户伪造邮件注入。
