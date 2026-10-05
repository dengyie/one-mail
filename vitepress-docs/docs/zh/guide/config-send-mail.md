
# 配置发送邮件

::: tip 推荐方案
推荐使用 Cloudflare `send_email` binding 作为默认发信通道。绑定 `SEND_MAIL` 并完成 Email Routing onboarding 后，即可直接向任意外部地址发信。

Workers Paid 每月含 3,000 封，超出部分 $0.35 / 1000 封。
:::

## 发信通道优先级

每次 `/api/send_mail` 请求按如下顺序匹配通道，**命中即发送**：

| 顺序 | 条件 | 通道 | 扣 balance |
|------|------|------|-----------|
| 1 | `SEND_MAIL` 已绑定 **且** 收件人在 `verifiedAddressList` | Cloudflare binding（兼容模式） | 否 |
| 2 | `RESEND_TOKEN_<DOMAIN>` 已配置 | Resend API（仅该域名） | 是 |
| 3 | `SMTP_CONFIG` 含当前域名配置 | worker-mailer SMTP | 是 |
| 4 | 全局 `RESEND_TOKEN` 已配置 | Resend API（兜底） | 是 |
| 5 | `SEND_MAIL` 已绑定（以上均未命中） | **Cloudflare binding（推荐主通道）** | 是 |
| — | 以上均未命中 | 抛错 | — |

> [!WARNING] 不要用全局 `RESEND_TOKEN` 做多渠道测试
> 全局 `RESEND_TOKEN` 仍会作为没有域名级配置时的兜底。若要把 Resend 与通用 SMTP 拆到不同域名，**只配** `RESEND_TOKEN_<DOMAIN>`，不要配全局 `RESEND_TOKEN`。域名级 SMTP 现在优先于全局 Resend，不会再被盖住。

> [!NOTE]
> binding 发信失败会直接报错。

## 使用 Cloudflare `send_email` binding（推荐）

仅 CLI 部署时使用，在 `wrangler.toml` 中添加：

```toml
# 通过 Cloudflare send_email binding 发送邮件
send_email = [
   { name = "SEND_MAIL" },
]
```

> [!warning] 重要
> 绑定名必须为 `SEND_MAIL`，与 Cloudflare 官方文档示例中的 `SEND_EMAIL` 不同。

完成下列步骤后即可直接向任意外部地址发信：

1. 在 Cloudflare Dashboard 给对应域名开启 Email Routing 并完成 onboarding
2. `wrangler.toml` 添加上述 `send_email` 绑定
3. 部署 Worker

无需配置任何额外的 env var。

## 使用 Resend 发送邮件

注册 `https://resend.com/domains` 根据提示添加 DNS 记录,

> [!WARNING] Cloudflare 上 DNS 记录的代理状态
> Resend 域名验证的 CNAME 记录**必须设置为 仅 DNS**（灰云），在
> Cloudflare DNS 控制面板中代理（橙云）记录会阻止 Resend
> 完成验证，且一次失败的尝试可能需要数小时才能重试。
> 参见 [#515](https://github.com/dengyie/one-mail/issues/515)。

`API KEYS` 页面创建 `api key`

然后执行下面的命令，将 `RESEND_TOKEN` 添加到 secrets 中

> [!NOTE]
> 如果你觉得麻烦，也可以直接明文放在 `wrangler.toml` 中 `[vars]` 下面，但是不推荐这样做

如果你是通过 UI 部署的，可以在 Cloudflare 的 UI 界面中添加到 `Variables and Secrets` 下面

```bash
# 切换到 worker 目录
cd worker
wrangler secret put RESEND_TOKEN
```

如果你有多个域名，对应不同的 `api key`，可以在 `wrangler.toml` 中添加多个 secret, 名称为 `RESEND_TOKEN_` + `<. 换成 _ 的 大写域名>`,例如

```bash
wrangler secret put RESEND_TOKEN_YOUR_DOMAIN_COM
wrangler secret put RESEND_TOKEN_MAIL_YOUR_DOMAIN_COM
```

多渠道测试时只配域名级 secret。Resend 的 bounce MX / SPF 放在 `send.` 子域，**不要改根 MX**（根 MX 仍给 Cloudflare Email Routing 收信）。DKIM CNAME 必须灰云。

## 使用 SMTP 发送邮件

`SMTP_CONFIG` 的格式如下，**key 必须是你自己的发信域名**，value 为 SMTP 配置。子域**不会**继承父域条目。

SMTP 配置格式详情可以参考 [zou-yu/worker-mailer](https://github.com/zou-yu/worker-mailer/blob/main/README_zh-CN.md)

Worker 在碰外部套接字之前会 fail-closed 校验该条目。缺 `host`、非整数 `port`、TLS 标志不匹配、或设置了 `authType` 却没有用户名/密码时，`/api/send_mail` 返回 **400** 并释放预约/退额，**不会**变成 503 unknown。非法 JSON 同样是配置错误，不是「该域无 SMTP」。

| 端口 | 要求 |
|------|------|
| `465` | `secure: true`（implicit TLS） |
| `587` / `2525` | `startTls: true` 且 `secure: false` |
| 其它公网端口 | 必须显式 `secure: true` 或 `startTls: true`，禁止明文 |
| `1025` | **仅** loopback/`mailpit` 且无凭据的 E2E 豁免；生产禁止 |

> [!warning] 重要
> JSON 中的 key（如下面示例中的 `your-domain.com`）必须替换为**你自己的域名**，即 `DOMAINS` 变量中配置的域名。
> 这是最常见的配置错误之一，请勿直接复制示例中的域名。

```json
{
    "your-domain.com": {
        "host": "smtp.example.com",
        "port": 465,
        "secure": true,
        "authType": [
            "plain",
            "login"
        ],
        "credentials": {
            "username": "your-smtp-username",
            "password": "your-smtp-password"
        }
    }
}
```

**字段说明：**

| 字段 | 说明 |
|------|------|
| key（如 `your-domain.com`） | 你的发信域名，必须与 `DOMAINS` 中配置的域名一致 |
| `host` | SMTP 服务器地址，如 `smtp.mailgun.org`、`smtp.gmail.com` 或你自建的 SMTP 服务器地址 |
| `port` | SMTP 端口，通常 `465`（SSL）或 `587`（STARTTLS） |
| `secure` | 是否使用 SSL/TLS，端口 465 时设为 `true`，端口 587 时设为 `false` |
| `startTls` | 端口 587 / 2525 时设为 `true`（STARTTLS） |
| `authType` | 认证方式，一般使用 `["plain", "login"]` |
| `credentials.username` | SMTP 服务器的登录用户名 |
| `credentials.password` | SMTP 服务器的登录密码 |

如果你有**多个域名**使用不同的 SMTP 服务，在同一个 JSON 中添加多个 key 即可。

现网出站用 Resend 三域（`mangoqwq.com` / `otp.mangoqwq.com` / `verify.mangoqwq.com`）加 `SEND_MAIL` binding。其余 apex 只收信，不必再接第三方 SMTP 厂商。`SMTP_CONFIG` 只留给通用 SMTP（Mailpit E2E，或以后自建 relay）。若生产 secret 里还留着已停用的 Brevo 条目，应删掉该 key 或整段 secret，否则该域 From 会再次去连死掉的 relay。

Resend 只配域名级 secret（`RESEND_TOKEN_MANGOQWQ_COM` / `RESEND_TOKEN_OTP_MANGOQWQ_COM` / `RESEND_TOKEN_VERIFY_MANGOQWQ_COM`），不要写进 `SMTP_CONFIG`，也不要配全局 `RESEND_TOKEN`。根 MX 保持 Cloudflare Email Routing；端口 587 需要 `startTls: true`。

注册验证码 `verifyMailSender` 必须是 **`DOMAINS` 中的已活 Resend 域**（优先 `noreply@verify.mangoqwq.com`，若该子域未列入 `DOMAINS` 则用 `noreply@mangoqwq.com`）。

然后执行下面的命令，将 `SMTP_CONFIG` 添加到 secrets 中

> [!NOTE]
> 如果你觉得麻烦，也可以直接明文放在 `wrangler.toml` 中 `[vars]` 下面，但是不推荐这样做

如果你是通过 UI 部署的，可以在 Cloudflare 的 UI 界面中添加到 `Variables and Secrets` 下面

```bash
# 切换到 worker 目录
cd worker
wrangler secret put SMTP_CONFIG
```

## 发信余额机制

用户发送邮件需要有发信余额。余额机制如下：

1. **自动初始化默认额度**：当 `DEFAULT_SEND_BALANCE > 0` 时，用户打开前端发信页或第一次调用发信接口时，系统会自动为该地址初始化默认额度
2. **手动申请**：如果 `DEFAULT_SEND_BALANCE = 0`，用户仍可以在前端界面点击「申请发信权限」按钮，创建待管理员处理的发信权限记录
3. **无限制发送**：以下方式可以跳过余额检查：
   - 在 admin 后台将地址加入「无限制发送地址列表」
   - 配置 `NO_LIMIT_SEND_ROLE` 环境变量，指定可以无限发送的用户角色

> [!NOTE]
> `DEFAULT_SEND_BALANCE` 仅在地址尚无 `address_sender` 记录时自动插入初始额度（`ON CONFLICT DO NOTHING`），已有记录（包括管理员禁用或手动设置的行）一律保持原样，runtime 不会修改；历史异常或被禁用的地址需由管理员在后台手动启用并设置余额。
>
> 第 1 层 `verifiedAddressList` 命中时不扣余额，但同样计入发信额度；第 2/3/4 层统一扣 balance。
>
> 发信额度对**全部**发信渠道生效，admin 发信接口也会一起计入。
>
> 每日和每月额度按 **UTC** 时间窗口计算。
>
> 当前额度实现属于 **soft guard**，适合日常额度控制；在数据库异常或高并发场景下，它不适合作为绝对严格的成本硬闸。

## 给 Cloudflare 上已认证的转发邮箱发送邮件

适合未完成 Email Routing onboarding 的域名，或 Workers 免费版。

只有收件人在 admin 后台的 `已验证地址列表` 中时，才会通过 `SEND_MAIL` binding 发信。
