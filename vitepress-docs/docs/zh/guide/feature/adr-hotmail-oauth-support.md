# ADR：Outlook / Hotmail 邮箱接入 —— OAuth2 (XOAUTH2) 支持

- **状态：Implemented（已实施 Stage 0+1，分支 `feat/hotmail-oauth-support`）**
- **日期：** 2026-09-08
- **范围：** `aggregator` OAuth 客户端、设备码换取 refresh_token 的引导工具、配置契约、Worker/前端接入

> 本文是 Hotmail/Outlook.com 个人账号接入 one-mail 统一收件箱的**设计文档（Development Doc）**。它描述「为什么只能走 OAuth、现状是什么、要改什么、怎么落地」。
> **Stage 0（`oauth.py` MSA 分支 + 单测）与 Stage 1（`msa_authorize.py` 引导脚本）已于 2026-09-08 实施并全量测试通过（aggregator 132 / worker 127 / vitepress build 绿）。**

---

## 1. 背景与动机（Why）

用户希望把 `@hotmail.com` / `@outlook.com` **个人（consumer）账号** 接入 one-mail 统一收件箱归集。

**硬性事实（2026-09-08 已在 pxed 实测 + 官方文档确认）：**

1. 微软已对所有租户**禁用 IMAP/POP/SMTP 基础认证**（Basic authentication）。
   - Microsoft Learn：[Deprecation of Basic authentication in Exchange Online](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online) → "Basic authentication is now disabled in **all** tenants."
   - 到 **2026-04-30**，SMTP AUTH 也将被完全禁用、无例外。
2. 实测证据（pxed SOCKS5 隧道，用 one-mail 聚合器连接逻辑）：
   ```
   [imap-mail.outlook.com]  LOGIN app-pass    -> LoginError: b'Basic authentication is disabled.'
   [imap-mail.outlook.com]  LOGIN wrong-pass  -> LoginError: b'Basic authentication is disabled.'
   ```
   **正确密码与错误密码返回完全相同的错误** → 证明是微软**协议级禁用基础认证**，与密码对错无关。App Password 对部分账号也已不再可用（MS Q&A/Stack Overflow，2024-10 起）。
3. 因此，**个人 Hotmail/Outlook.com 账号唯一被官方支持的接入方式是 OAuth2 + XOAUTH2**：
   - 官方：[Authenticate an IMAP, POP or SMTP connection using OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth) 明确：OAuth2 支持 **Microsoft 365 和 Outlook.com（个人账号）**两者。
   - 永久 scope：`https://outlook.office.com/IMAP.AccessAsUser.All` + `offline_access`。

### 关键约束小结

| 项 | 现状 / 约束 |
|---|---|
| 个人 MSA 账号（hotmail/outlook.com） | 只能用 **OAuth2 / XOAUTH2**；基础认证已被服务端禁用 |
| OAuth 访问范围 | `https://outlook.office.com/IMAP.AccessAsUser.All` + `offline_access` |
| 简单获取 token | **Device Code Flow**（官方建议，个人 MSA 支持，无需客户端 secret，见 MSAL 4.5+） |
| one-mail 现有能力 | `aggregator/src/one_mail_agg/oauth.py` 已实现 `outlook_access_token`（`grant_type=refresh_token` 换 access → XOAUTH2），但当前要求 **必传 `client_secret`，且 account 无 secret 时无法走通** |

---

## 2. 方案 A：为什么现有 outlook 路径对个人 MSA 不自动

现有 `oauth.py`：

```python
def outlook_access_token(oauth: dict) -> str:
    r = requests.post("https://login.microsoftonline.com/common/oauth2/v2.0/token", data={
        "client_id": oauth["client_id"], "client_secret": oauth["client_secret"],   # <- 强依赖 secret
        "refresh_token": oauth["refresh_token"], "grant_type": "refresh_token",
        "scope": "https://outlook.office.com/IMAP.AccessAsUser.All offline_access",
    }, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]
```

问题：
- 个人 MSA 走的是 `/consumers` 租户，用 **公开客户端（public client，无 client_secret）**。现有代码强制带 secret。
- 逼用户去 Azure 做 App Registration 并生成 client_secret + refresh_token —— 正是用户嫌「绑定太多信息」的流程。

---

## 3. 目标

1. **接入 `@hotmail.com` / `@outlook.com` 个人账号**（微软重订阅网关 consumer MSA）：
   - scope `IMAP.AccessAsUser.All` + `offline_access`
   - XOAUTH2 SASL 认证，走 one-mail 已有 `oauth2_login`。
2. **引导刷新：**
   - 提供一个 **一次性 "授权脚本"（device code flow 或授权码流程）**，用户在浏览器登录、确认，脚本输出可写进 config 的 **client_id + refresh_token**，一次性配置永久收信（refresh_token 不需人工复审）。
3. **配置契约**：`config.json`（admin 侧）与 `user_mail_accounts`（用户自助）都支持新 provider。
4. **不改坏既有 gmail/outlook/qq/163 行为**：新增 provider 枚举/分支，向后兼容。
5. **安全**：refresh_token 是长活凭证；只在 pxed config.json（chmod 600）和 D1 `oauth_enc` 中加密保存，绝不进日志、绝不提交。

### 非目标
- 不支持 `@workplace`/`@onmicrosoft.com` 组织账号的多租户/合规细节（保留 `/common` 路径给组织账号，`/consumers` 给个人号）。
- 不做前端完整 OAuth 授权 UI（本期只做 admin config 接入 + 引导脚本；前端 flow 可后续在 user_oauth2 补）。
- 不做 SMTP 发信（scope 仅 IMAP 读）。

---

## 4. 决策：引入 `provider = "msa_oauth"`（别名 `hotmail`/`outlook` consumer）

在**不破坏**现有 `imap_outlook`（组织号，需 secret）的前提下，新增一个**公开客户端、无 secret** 的个人号 provider。命名建议：

```text
provider 值：  "msa_oauth"
              兼容别名： "outlook_personal" / "hotmail"
```

### 4.1 `oauth.py` 新函数

```python
def msa_access_token(oauth: dict) -> str:
    """个人 MSA / Hotmail / Outlook.com 的 refresh_token -> access_token。
    使用 /consumers 租户 + 公开客户端（无需 client_secret）。
    """
    payload = {
        "client_id": oauth["client_id"],
        "refresh_token": oauth["refresh_token"],
        "grant_type": "refresh_token",
        "scope": "https://outlook.office.com/IMAP.AccessAsUser.All offline_access",
    }
    if oauth.get("client_secret"):          # 可选：若提供仍带上
        payload["client_secret"] = oauth["client_secret"]
    r = requests.post(
        "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        data=payload, timeout=30,
    )
    r.raise_for_status()
    return r.json()["access_token"]
```

注册进 `_TOKEN_FN`：

```python
_TOKEN_FN = {
    "gmail": gmail_access_token,
    "outlook": outlook_access_token,   # 组织/secret 场景
    "msa": msa_access_token,             # 新：Hotmail/Outlook.com 个人号（consumer）
}
```

> 说明：`/consumers` 端点是微软官方为**个人 Microsoft 账号**（live.com / hotmail / outlook.com）的 token 交换端点。public client 时可省略 `client_secret`。

### 4.2 **host / source 映射**

对个人 Hotmail/Outlook.com，标准 IMAP：
- host：`outlook.office365.com:993`（推荐）或 `imap-mail.outlook.com:993`，均 SSL
- `source`（admin / 用户接口）沿用 **`imap_outlook`**，不改枚举（避免大改前端/Worker）。由 `oauth.provider == "msa"` 区分认证方式。

### 4.3 重命名/别名与向后兼容

- 保留 `outlook` → 组织/secret 流程（现有测试不破坏）。
- 新增 `msa`，并提供 `hotmail` 作为非正式别名（可在 config 归一化时转 `msa`）。

---

## 5. 引导脚本（device code flow）

新增 `aggregator/scripts/msa_device_grant.py`（参考官方 Device Code Flow，个人账号可用）：

流程：
1. `GET https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode`
   body：`client_id=<PUBLIC_CLIENT_ID>&scope=offline_access+https%3A%2F%2Foutlook.office.com%2FIMAP.AccessAsUser.All`
2. 打印 `user_code` + 打开 `verification_uri`（如不能自动开就贴给用户）。
3. 用户用 `@hotmail.com` 登录并确认。
4. 脚本轮询 `POST .../token`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`），拿到 `refresh_token` 与短寿 `access_token`。
5. 输出两行可直接粘贴的配置：
   ```json
   {
     "provider": "msa",
     "client_id": "<PUBLIC_CLIENT_ID>",
     "refresh_token": "<refresh_token>"
   }
   ```

> 需要一个**公开客户端 ID**。个人项目可以自建一个 Azure App（多租户/个人 Microsoft 账号，`Supported account types` = **Personal Microsoft accounts only**，Redirect 随意），得到 `client_id`，脚本用它做 device code。**该 client_id 起着「公开客户端」用途，不需要 secret。**

### 若选授权码（Authorization Code）流程
同样给出 `auth_code_flow` 示例（redirect 到本机 `http://localhost`），但推荐 device code（不依赖本地回调）。

---

## 6. 配置契约

### 6.1 Admin（pxed `config.json`）

```json
{
  "id": "hotmail-main",
  "source": "imap_outlook",
  "host": "outlook.office365.com",
  "port": 993,
  "username": "someone@hotmail.com",
  "password": "ignored-by-oauth",            // 保留占位，实际用 oauth
  "use_ssl": true,
  "oauth": {
    "provider": "msa",
    "client_id": "<PUBLIC_CLIENT_ID>",
    "refresh_token": "<refresh_token>"
  }
}
```

`main.py`/`remote_accounts.py` 的 `AccountConfig.oauth` 已支持 dict，无需改加载逻辑。

### 6.2 用户自助（Worker `user_mail_accounts`）

`worker/src/user_api/mail_accounts.ts` 的 `OAUTH_PROVIDERS` 当前白名单 `{"gmail","outlook"}`。需新增 `"msa"`：

```ts
const OAUTH_PROVIDERS = new Set(["gmail", "outlook", "msa"]);
```

`oauth_enc` 存 JSON：`{"provider":"msa","client_id":"...","refresh_token":"..."}`（仍走 AES-GCM 加密）。聚合器拉取时 `oauth` 已带 `provider={"msa"}`，从而路由到 `msa_access_token`。

---

## 7. 需要改动的文件清单（draft）

| 文件 | 改动 | 风险 |
|---|---|---|
| `aggregator/src/one_mail_agg/oauth.py` | 新增 `msa_access_token` + `_TOKEN_FN` | 低，纯新增；不改既有 outlook |
| `aggregator/tests/test_oauth.py` | 新增 MSA personas（public、no-secret、带/不带 secret、malformed、未知 provider 400/失败隔离） | 中 |
| `aggregator/config_*.py` | 无（oauth 已通过 `AccountConfig`） | — |
| `worker/src/user_api/mail_accounts.ts` | `OAUTH_PROVIDERS` 加 `"msa"` | 中，白名单收口 |
| `aggregator/scripts/msa_authorize.py`（新） | device code / auth code 引导脚本 | 低 |
| `sydney`/可复用 | 复用 one-mail 现有 SMTP/IMAP 网关 | — |

> 「provider unsupported」目前会在 `main.py` 中作为账户级别错误隔离（`32cdfce` 已实现隔离），所以未知 provider 不会再冻结整轮同步——增量安全。

---

## 8. 实施顺序（phased）

1. **阶段 0（本期）**：`oauth.py` 增加 `msa_access_token`（/consumers、no-secret、可选 secret）+ 单元测试。 → 提交 `feat: aggregator support personal Microsoft (Hotmail/Outlook) OAuth2 consumer`。
2. **阶段 1「Draft」**：`aggregator/scripts/msa_authorize.py`（device-code 引导脚本）产出 `refresh_token`。
3. **阶段 2（可选，后续）**：Worker `OAUTH_PROVIDERS` 加 `"msa"` + 前端 `user-external-mail` 页加「Hotmail（个人）」入口。
4. **阶段 3（不达成 if 用户不需要）**：组织账号的完整 Azure flow 文档。

> 本期交付为「阶段 0+1」：让 `msa/consumer` 能配上 config 收信，并提供**免 Azure 面板**的授权引导。

---

## 9. 验收标准（Definition of Done）

- [ ] `pytest` 覆盖新增 /`msa` 分支（mock token 端点），全绿且不回归现有 gmail/outlook 用例。
- [ ] 用「引导脚本」真实拿到一个 `@hotmail.com` 的 `refresh_token`，写入 pxed `config.json`，聚合器 `sync` 返回 `synced>0`、`last_error` 为空。
- [ ] 真邮箱 1 封新邮件能归集进 one-mail 统一收件箱（`to_addr = username` 命中）。
- [ ] `known secrets` 不进日志、不提交；已知 `basic auth disabled` 不再被消费。
- [ ] 文档（本 ADR + vitepress `user-external-mail` / `user-oauth2`) 双语补全，changelog 更新。

---

## 10. 附录：官方附录（快查）

- Device Code Flow + personal MSA：MSAL 4.5 起支持个人号，`/common` 与 `/` 均可。见 [MSAL.NET device code flow](https://learn.microsoft.com/en-US/entra/msal/dotnet/acquiring-tokens/desktop-mobile/device-code-flow)。
- OAuth2 for IMAP/POP/SMTP：scope 表与 XOAUTH2 编码：见 [Authenticate IMAP/POP/SMTP using OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)。
- 基础认证禁用：见 [Deprecation of Basic authentication](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online)。

> ⚠️ 本期不承诺组织（work/school account）完整支持；组织账号仍走现有 `outlook`（要求 client_secret + Azure App) 的流程。