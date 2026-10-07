# 外部邮箱接入全链路重构与升级开发文档
## External Mailbox Seamless Integration Pipeline: Zero-Config & High-Availability Architecture

> **文档状态**：评审通过 / 实施标准（Approved Architecture & Implementation Specification）  
> **核心原则**：**用户极致方便（极简两字段交互、零配置门槛）** ✕ **最高接入成功率（三级阶梯自动发现、双路自愈网络、全双工自适应降级）**  
> **关联设计**：[[send-mail-external-accounts.md]]（外部账号发信）、[[unified-inbox-sharding.md]]（分片与多租户隔离）、[[provider-message-identity-upgrade.md]]（Provider 身份）  
> **实战源起**：基于 `mangoqwq@linux.do`（Mailu 系统）生产接入全流程经验，彻底重塑从前端输入、网络穿透、自动发现、即时握手、到收发一体守护的完整工程闭环。

---

## 1. 核心目标与产品体验愿景

### 1.1 用户端体验愿景：“只填两项，一键秒连” (Two-Field Zero-Config Onboarding)
传统的邮件客户端接入极其繁琐：需要用户理解 IMAP/POP3 协议、手动查询服务器主机名（`imap.xxx.com` / `smtp.xxx.com`）、区分 993/465/587 等端口、选择 SSL/TLS 协议类型、以及手动判断是否走海外代理。这些底层技术术语是造成用户接入失败的主要根源。

本重构方案将把用户心智负担降至最低：
- **默认极简界面**：默认**仅展示两个输入框**——**【邮箱地址】** 与 **【密码 / 授权码 / 令牌】**。
- **一键原子接入**：仅保留一个主按钮 **【一键智能接入 (Smart Connect)】**。
- **全自动黑盒推导**：所有协议探测、端口选择、安全加密、网络穿透与发信配置，全部由系统后台全自动推导与并发探测完成。
- **高级设置兜底**：仅为有特殊私有端口或企业内网需求的高级用户保留折叠展开的“高级手动设置”。

### 1.2 系统端指标愿景：“最高成功率与自愈韧性” (Maximum Success Rate & Self-Healing)
针对国内外复杂网络环境（长城防火墙 GFW DNS 污染、海外节点丢包、企业反垃圾策略、服务商鉴权特殊约束），系统构建全套自愈能力：
1. **自动发现覆盖率 > 99%**：通过“权威知识库 + 行业标准 ISPDB + RFC 6186 SRV + 启发式探测”四重梯队，实现全球任意合规邮箱的参数自动补齐。
2. **网络自愈（零感知代理）**：严禁把“是否走代理”抛给用户选择；系统通过**双路竞速 / 智能回退（Silent Failover）**，直连遇阻时毫秒级自动切换至 SOCKS5 海外隧道，彻底杜绝 DNS 污染阻断。
3. **全双工收发保障与优雅降级**：一次接入自动打通 IMAP 收信与 SMTP 发信；若发信受到服务商权限限制，自动降级为“稳定收信模式”并提示，绝不粗暴报错阻断流程。
4. **服务商上下文避坑引导**：在用户键入邮箱时实时识别服务商，前置浮现防坑指引（如 Linux.do 授权 IP 必须留空、QQ 需用授权码等），将人为配置错误扼杀在提交之前。

---

## 2. 现状痛点与根本原因复盘 (Root Cause Analysis)

```
                       【旧接入链路 vs 新架构全景对比】
┌──────────────────────────────────────────────┐  ┌──────────────────────────────────────────────┐
│                  旧接入链路                   │  │             重构后新链路 (极简+自愈)           │
├──────────────────────────────────────────────┤  ├──────────────────────────────────────────────┤
│ 1. 前端表单：繁琐 8+ 输入项 (主机/端口/SSL)   │  │ 1. 前端表单：仅输入【邮箱】+【密码】，一键接入  │
│ 2. 服务商差异：无任何提示，用户误填 0.0.0.0    │  │ 2. 智能上下文：检测 @linux.do 自动提示留空 IP │
│ 3. 连通预检：接口空置 (返回 501)，保存凭运气   │  │ 3. 原子握手：点击后 1~2s 完成 IMAP+SMTP 预检  │
│ 4. 网络策略：写死域名名单，遇 DNS 污染必崩溃   │  │ 4. 网络自愈：双路竞速直连+代理，污染静默切换  │
│ 5. 发信链路：缺失 smtp 字段，能收不能发       │  │ 5. 收发一体：全自动推导 SMTP 端口并落库生效    │
│ 6. 同步延迟：靠 60s 轮询，无法即时生效         │  │ 6. 事件驱动：保存瞬间 Webhook 唤醒守护进程    │
└──────────────────────────────────────────────┘  └──────────────────────────────────────────────┘
```

### 2.1 源码根因明细
1. **网络层硬编码断层**（`aggregator/src/one_mail_agg/proxy_client.py:16`）：
   - `OVERSEAS_IMAP_HOSTS` 与 `OVERSEAS_SMTP_HOSTS` 为源码内的静态集合。新海外自建系统（如 `mail.linux.do`）不在列表中便尝试直连。受国内 GFW DNS 污染返回假保留 IP，导致 `network_guard.py` 的 SSRF 校验抛出 `UnsafeMailTargetError`。在 SOCKS5 模式下，本应通过 `ATYP 0x03` 远端解析域名，本地解析既无意义又成绊脚石。
2. **自定义 SMTP 链路全面缺失**（`worker/src/admin_api/db_api.ts:143`, `UserMailAccounts.vue:45`）：
   - D1 `user_mail_accounts` 表仅有收信字段，无 `smtp_host`, `smtp_port`, `smtp_ssl`；前端表单未提供发信配置；`smtp_sender.py` 中 `SMTP_DEFAULTS` 对 `imap_custom` 返回空主机，导致自定义邮箱开通发信后发送必定崩溃。
3. **预检机制空置，错误感知极差**（`worker/src/user_api/mail_accounts.ts:446`）：
   - `/user_api/mail_accounts/:id/test-connection` 返回 `501 NotImplemented`。用户添加后必须干等最长 60 秒守护进程轮询，且只能从表格中的 `last_error` 看到无引导意义的原生报错。
4. **服务商隐式约束与心智盲区**：
   - Mailu 系统要求 API Token 的“授权IP”留空，用户习惯填 `0.0.0.0`，底层 Python 将其当作单机 `/32` 解析，导致外部代理访问被拦截抛出 `[AUTHENTICATIONFAILED]`。系统未在前置界面提供任何提醒。

---

## 3. 终极极简交互与产品流程设计 (Zero-Config UX)

### 3.1 极简表单设计（默认状态）

```
┌────────────────────────────────────────────────────────┐
│ 添加外部邮箱                                            │
├────────────────────────────────────────────────────────┤
│ 邮箱地址   : [ mangoqwq@linux.do                     ] │
│ 密码/授权码: [ ••••••••••••••••••••••••••••••••••••• ] │
│                                                        │
│ 💡 已识别为 LINUX DO 社区邮箱 (Mailu 系统)             │
│    请填写 WebMail 中生成的认证令牌；                   │
│    生成令牌时“授权IP”请务必完全留空（切勿填 0.0.0.0）。 │
│                                                        │
│ [▸ 高级手动配置 (通常无需展开)]                         │
├────────────────────────────────────────────────────────┤
│                                 [ ⚡ 一键智能接入 ]    │
└────────────────────────────────────────────────────────┘
```

### 3.2 智能接入时的可视化进度脉冲（耗时约 1~2 秒）
点击【一键智能接入】后，按钮进入 Loading 态，并呈现清晰的微动效进度指示：
- `[✓] 1. 智能匹配服务器配置 (mail.linux.do)`
- `[✓] 2. 建立安全网络通道 (已自动启用海外安全加速)`
- `[✓] 3. 验证收信通道 (IMAP 993 TLS 握手通过)`
- `[✓] 4. 验证发信通道 (SMTP 465 TLS 握手通过)`
- `[✓] 5. 配置生效，已拉起即时推送！`

全部绿灯后弹窗自动关闭，新邮箱以“启用”状态直接呈现在收件箱列表中，毫秒级开启 IMAP IDLE 监听。

### 3.3 优雅降级与错误自愈展开（仅在探测受阻时呈现）
若用户输入的密码错误或服务器不可达，弹窗**自动展开高级设置面板**，并精准定位出错项：
```
┌────────────────────────────────────────────────────────┐
│ ❌ 接入未通过：认证失败 (服务商拒绝了此凭据)           │
│ 建议：密码不正确，或 LINUX DO 令牌中误填了授权 IP。     │
├────────────────────────────────────────────────────────┤
│ 邮箱地址   : [ mangoqwq@linux.do                     ] │
│ 密码/授权码: [ 错误凭据 •••••••••• ] ⚠️ 请重新输入     │
│                                                        │
│ ▾ 高级配置 (已自动为您探测补全)                        │
│   收信主机: [ mail.linux.do ]  端口: [ 993 ] ☑ SSL     │
│   发信主机: [ mail.linux.do ]  端口: [ 465 ] ☑ SSL     │
│   网络模式: ( ) 直连  (•) 海外加速  ( ) 自动探测        │
├────────────────────────────────────────────────────────┤
│ [ 取消 ]                              [ 重新检测并接入 ]│
└────────────────────────────────────────────────────────┘
```

---

## 4. 三级阶梯全自动配置发现引擎 (Three-Tier Auto-Discovery Engine)

为达成“只填邮箱地址即可自动推导服务器配置”的目标，系统在接入后端构建三级发现瀑布流：

```
                    【全自动配置探测瀑布流 (Discovery Waterfall)】
                                 输入: user@domain.com
                                          │
                                          ▼
                          [ Tier 1: 内置权威知识库 ] ──── 命中 ───► 返回标准配置
                                          │ 未命中
                                          ▼
                          [ Tier 2: 行业标准自动配置 ]
                           ├── Mozilla ISPDB
                           ├── RFC 6186 DNS SRV   ──── 命中 ───► 校验后返回
                           └── MS Autodiscover
                                          │ 未命中
                                          ▼
                          [ Tier 3: 启发式端口智能竞速 ]
                           ├── 收信: imap./mail. (993/143)
                           └── 发信: smtp./mail. (465/587)
                                          │ 探测成功
                                          ▼
                                   组装推导配置并落库
```

### 4.1 Tier 1: 内置权威服务商与社区知识库 (Curated Directory)
前端与 Worker 共享一套预编译的权威服务商映射表（涵盖全球主流及中文开发者高频系统）：

| 域名模式 | 服务商分类 | 收信配置 (IMAP) | 发信配置 (SMTP) | 默认网络策略 | 专属前置提示 |
|---|---|---|---|---|---|
| `*@linux.do` | LINUX DO (Mailu) | `mail.linux.do:993` (SSL) | `mail.linux.do:465` (SSL) | `always` (走代理) | 令牌生成时“授权IP”务必留空，切勿填写 0.0.0.0。 |
| `*@qq.com`, `*@foxmail.com` | 腾讯 QQ 邮箱 | `imap.qq.com:993` (SSL) | `smtp.qq.com:465` (SSL) | `never` (直连) | 须在网页端设置中开启 IMAP 服务，并使用 16 位授权码。 |
| `*@163.com`, `*@126.com`, `*@yeah.net` | 网易邮箱 | `imap.{domain}:993` (SSL) | `smtp.{domain}:465` (SSL) | `never` (直连) | 须在设置中开启 POP3/IMAP 服务，并使用专用客户端授权码。 |
| `*@gmail.com` | Google Gmail | `imap.gmail.com:993` (SSL) | `smtp.gmail.com:587` (STARTTLS) | `always` (走代理) | 须在 Google 账户中开启两步验证，并生成 16 位“应用专用密码”。 |
| `*@outlook.com`, `*@hotmail.com` | 微软个人邮箱 | `outlook.office365.com:993` (SSL) | `smtp-mail.outlook.com:587` (STARTTLS) | `always` (走代理) | 微软已停用密码直连，请使用 OAuth2 认证。 |
| `*@icloud.com` | Apple iCloud | `imap.mail.me.com:993` (SSL) | `smtp.mail.me.com:587` (STARTTLS) | `auto` | 须在 Apple ID 安全中心生成“App 专用密码”。 |
| `*@fastmail.com` | Fastmail | `imap.fastmail.com:993` (SSL) | `smtp.fastmail.com:465` (SSL) | `always` (走代理) | 须在设置中使用 App Password。 |
| `*@qiye.aliyun.com` | 阿里企业邮箱 | `imap.qiye.aliyun.com:993` (SSL) | `smtp.qiye.aliyun.com:465` (SSL) | `never` (直连) | 使用企业邮箱密码或专用授权码。 |
| `*@feishu.cn` | 飞书邮箱 | `imap.feishu.cn:993` (SSL) | `smtp.feishu.cn:465` (SSL) | `never` (直连) | 须在客户端安全设置中获取外部客户端授权码。 |

### 4.2 Tier 2: 行业标准自动发现协议 (Standard Auto-Config)
对于私有企业域或未命中 Tier 1 的自定义域名，系统按顺序请求业界公开发现标准：
1. **Mozilla ISPDB（Thunderbird 官方配置库）**：
   - 请求：`GET https://autoconfig.thunderbird.net/v1.1/{domain}`
   - 解析返回的 XML，提取 `<incomingServer type="imap">` 与 `<outgoingServer type="smtp">` 的 hostname、port、socketType（SSL/STARTTLS）。
2. **RFC 6186 DNS SRV 记录解析**：
   - 收信 SRV：`_imaps._tcp.{domain}`（标准端口 993）与 `_imap._tcp.{domain}`（标准端口 143）。
   - 发信 SRV：`_submissions._tcp.{domain}`（端口 465）与 `_submission._tcp.{domain}`（端口 587）。
3. **Microsoft Autodiscover XML**：
   - 请求：`https://autodiscover.{domain}/autodiscover/autodiscover.xml`。

### 4.3 Tier 3: 启发式端口扫描与智能猜测 (Heuristic Probing)
若上述协议均未声明配置，后台诊断探针按工业级通用约定进行并发探测：
- **收信主机候选**：`mail.{domain}` -> `imap.{domain}`，优先测 993 (SSL)，备选测 143 (STARTTLS)。
- **发信主机候选**：`mail.{domain}` -> `smtp.{domain}`，优先测 465 (SSL)，备选测 587 (STARTTLS)。

---

## 5. 双路竞速与静默自愈网络引擎 (Dual-Path Racing & Silent Proxy)

最高成功率的核心前提是**屏蔽复杂的网络环境差异**。用户无论身处中国大陆还是境外，无论目标邮件系统部署在境内还是境外，系统都必须保障 100% 连通。

```
                    【双路竞速与自愈网络引擎 (Racing Engine)】
                                 目标: mail.domain:993
                                          │
                    ┌─────────────────────┴─────────────────────┐
                    ▼                                           ▼
          [ 路径 A: 本地直连 ]                        [ 路径 B: SOCKS5 海外隧道 ]
          - 本地 DNS 解析                             - SOCKS5 ATYP 0x03 域名寻址
          - 直接 TCP 三次握手                         - 远端节点防污染真实解析
                    │                                           │
                    ├───────── 发生 GFW 污染/超时 ──────┐       │
                    │                                   │       │
                    ▼                                   ▼       ▼
              [ 连接失败 ]                       [ 竞速胜出 / 优雅回退成功 ]
                    │                                           │
                    └───────────────────┬───────────────────────┘
                                        ▼
                           自动将账号打标为: proxy_policy = 'always'
                           落库持久化，后续长连接监听完全免疫网络阻断
```

### 5.1 彻底废除硬编码代理列表
- 废弃 `OVERSEAS_IMAP_HOSTS` 与 `OVERSEAS_SMTP_HOSTS` 静态集合。
- 代理逻辑由**账号级配置 (`proxy_policy`)** + **运行时智能自愈回退表**全面接管。

### 5.2 静默自愈算法流程 (Silent Failover Algorithm)
当账号配置为 `proxy_policy = 'auto'` 时：
1. **优先直连尝试**：探针首先尝试直连握手，设置极短超时上限（`timeout = 2.5s`）。
2. **阻断信号捕获**：若捕获到以下任一信号，立即判定直连阻断：
   - 本地 DNS 解析出私有/保留/Bogon 假 IP（GFW 污染标志）；
   - `socket.timeout` 或 `ConnectionRefusedError`；
   - TCP 收到 RST（连接重置）或 TLS 握手异常。
3. **静默隧道重试**：立即转入第二阶段，通过本地 SOCKS5 代理（`127.0.0.1:1080`）并发起远端域名寻址（`ATYP 0x03`）。
4. **状态持久化绑定**：代理通道握手成功后，自动将该账号在 D1 中的属性刷新为 `proxy_policy = 'always'`，并将该域名记录到内存缓存 `_AUTO_PROXY_FALLBACK_CACHE`。后续所有 IMAP IDLE 长连接与 SMTP 发信操作直接走隧道，消除首字延迟。
5. **用户零感知**：对用户而言，界面仅感知到“接入成功”，无需手动做任何网络设置。

### 5.3 安全护栏解耦规范
- 在 `aggregator/src/one_mail_agg/network_guard.py` 中：
  - 若连接判定走 SOCKS5 代理，**彻底跳过本地 `assert_public_mail_host()` 中的本地 DNS 解析**。
  - 理由：SOCKS5 代理协议中目标域名直接打包在认证包内交由远端代理服务器解析。本地 DNS 查询结果既非实际通信目标，还会受国内 DNS 污染假 IP 误导导致误拦截。
  - 远端代理服务器自身受出口防火墙管控，确保满足公共网络出站规范。

---

## 6. 全双工收发一体与自适应降级 (Full-Duplex & Adaptive Fallback)

### 6.1 自定义邮箱 SMTP 补齐与智能推导
针对本次实战暴露的 `imap_custom` 发信配置空白问题：
1. **D1 数据层**：`user_mail_accounts` 增加 `smtp_host`, `smtp_port`, `smtp_ssl` 字段。
2. **智能推导兜底**：
   ```python
   def resolve_smtp_endpoint(host: str, smtp_host: str | None, smtp_port: int | None, smtp_ssl: bool | None) -> tuple[str, int, bool]:
       h = (smtp_host or "").strip()
       if not h:
           # 智能推导: imap.xxx.com -> smtp.xxx.com; 其他 (如 mail.xxx.com) 保持原主机
           h = "smtp." + host[5:] if host.lower().startswith("imap.") else host
       ssl = True if smtp_ssl is None else bool(smtp_ssl)
       p = smtp_port if (smtp_port and smtp_port > 0) else (465 if ssl else 587)
       return h, p, ssl
   ```
3. **发件箱自动对齐 (Sent Items Reconciliation)**：
   - 外部 SMTP 发信成功后，聚合器自动将发送的外发原始邮件以 `\Seen` 标志通过 IMAP `APPEND` 写入用户的发件箱（`Sent` 或 `Sent Items`），确保收发信记录与原厂 WebMail 完全一致。

### 6.2 自适应优雅降级 (Graceful Degradation)
在预检握手时：
- **状态 1：IMAP 通 且 SMTP 通** ➔ 开启全部功能（`enabled = 1, can_send = 1`），发信身份立即就绪。
- **状态 2：IMAP 通 但 SMTP 失败（如服务商禁止第三方发信）** ➔ **绝不全盘阻断**，而是自动以“仅收信模式”完成接入（`enabled = 1, can_send = 0`），并在界面显示友好提示：“已为您开启收信服务；发信功能因服务商限制暂未开通，您可随时在高级设置中配置专用发信服务器”。
- **状态 3：IMAP 失败** ➔ 阻止保存，弹出高级设置面板并高亮具体错误。

---

## 7. 凭据智能感知与错误自愈诊断 (Contextual Intelligence & Error Healer)

### 7.1 前端输入智能感知引擎 (Contextual Hint Rules)
在用户输入邮箱地址时，前端即时计算响应：

```typescript
// frontend/src/views/user/onboarding_hints.ts
export interface ProviderContextHint {
    match: RegExp;
    providerKey: string;
    badge: string;
    warningText?: string;
    docUrl?: string;
}

export const PROVIDER_CONTEXT_HINTS: ProviderContextHint[] = [
    {
        match: /@linux\.do$/i,
        providerKey: "linux_do",
        badge: "LINUX DO Mail (Mailu)",
        warningText: "生成认证令牌时，“授权IP”请务必完全留空，切勿填写 0.0.0.0。",
    },
    {
        match: /@qq\.com$|@foxmail\.com$/i,
        providerKey: "qq",
        badge: "QQ 邮箱",
        warningText: "需在 QQ 邮箱网页端“账户设置”中生成 16 位 POP3/IMAP 专属授权码。",
    },
    {
        match: /@163\.com$|@126\.com$/i,
        providerKey: "netease",
        badge: "网易 163/126 邮箱",
        warningText: "请在设置中开启 POP3/IMAP 服务，并输入客户端专属授权密码。",
    },
    {
        match: /@gmail\.com$/i,
        providerKey: "gmail",
        badge: "Google Gmail",
        warningText: "请使用 Google 账户安全中心生成的 16 位“应用专用密码”。",
    },
];
```

### 7.2 智能错误诊断转译字典 (Error Diagnostic Matrix)
将原本晦涩的底层 TCP/IMAP 报错转译为极具操作性的用户指引：

| 探测错误表现 | 内部错误码 | 用户端标题 | 智能修复与操作建议 |
|---|---|---|---|
| `[AUTHENTICATIONFAILED]` (命中 `@linux.do`) | `AUTH_LINUX_DO_IP_TRAP` | 令牌被 IP 规则拦截 | 您在生成 LINUX DO 认证令牌时可能填写了 `0.0.0.0`。请前往 Linux.do 重新生成一个令牌，并将“授权IP”彻底留空。 |
| `[AUTHENTICATIONFAILED]` (通用) | `AUTH_FAILED` | 账号或密码不匹配 | 认证未通过。请检查密码是否正确；若服务商要求客户端授权码，请勿使用登录主密码。 |
| `[NO] Unknown user` | `ACCOUNT_NOT_EXIST` | 邮箱账户不存在 | 邮件系统提示该用户名未注册，请核对邮箱拼写。 |
| `Timeout` / `ConnectionRefused` | `NET_UNREACHABLE` | 无法连接到邮件服务器 | 网络连接超时。已为您自动尝试开启“海外网络加速”，请检查服务器地址是否正确。 |
| `STARTTLS required` | `TLS_DOWNGRADE_REJECTED` | 安全协议不匹配 | 服务商强制要求加密通信。已自动为您勾选 SSL/TLS 加密选项。 |

---

## 8. 数据库与 API 契约详细规范 (Data Schema & API Contracts)

### 8.1 D1 数据库迁移规范 (`user_mail_accounts`)
```sql
-- Migration: Add outbound SMTP, auto-discovery metadata and dynamic proxy policy
ALTER TABLE user_mail_accounts ADD COLUMN smtp_host TEXT;
ALTER TABLE user_mail_accounts ADD COLUMN smtp_port INTEGER;
ALTER TABLE user_mail_accounts ADD COLUMN smtp_ssl INTEGER DEFAULT 1;
ALTER TABLE user_mail_accounts ADD COLUMN proxy_policy TEXT DEFAULT 'auto'; -- 'auto' | 'always' | 'never'
ALTER TABLE user_mail_accounts ADD COLUMN auto_discovered INTEGER DEFAULT 1; -- 1: 智能推导生成, 0: 用户手动指定
```

### 8.2 原子一键接入 API (Smart Connect Preflight & Save)

#### 8.2.1 探测并直接保存端点：`POST /user_api/mail_accounts/smart-connect`
- **请求头**：`x-user-token: <jwt>`
- **请求体 (Payload)**：
  ```json
  {
    "email": "mangoqwq@linux.do",
    "cred": "9a60a7c154dc0ef6871a10cbeb1e66ee",
    "label": "我的 LINUX DO 邮箱",
    "manual_override": {
      "host": null,
      "port": null,
      "smtp_host": null,
      "smtp_port": null,
      "proxy_policy": null
    }
  }
  ```
- **成功响应 (200 OK)**：
  ```json
  {
    "ok": true,
    "account_id": "66a19d4e-92c9-4f5e-b3fb-3151e53f17e5",
    "can_send": true,
    "diagnostics": {
      "provider": "linux_do",
      "discovery_source": "curated_directory",
      "imap": { "host": "mail.linux.do", "port": 993, "ssl": true, "latency_ms": 180 },
      "smtp": { "host": "mail.linux.do", "port": 465, "ssl": true, "latency_ms": 210 },
      "proxy": { "effective_policy": "always", "routed_via": "socks5_tunnel" }
    }
  }
  ```
- **失败响应 (400 Bad Request / 422 Unprocessable)**：
  ```json
  {
    "ok": false,
    "error_code": "AUTH_LINUX_DO_IP_TRAP",
    "message": "认证未通过：LINUX DO 令牌被 IP 限制拦截",
    "hint": "生成令牌时“授权IP”必须完全留空，请勿填写 0.0.0.0。",
    "inferred_config": {
      "host": "mail.linux.do",
      "port": 993,
      "use_ssl": true,
      "smtp_host": "mail.linux.do",
      "smtp_port": 465,
      "smtp_ssl": true,
      "proxy_policy": "always"
    }
  }
  ```

### 8.3 聚合器即时凭据导出更新 (`/admin/unified/mail_accounts`)
扩展响应字段，完整返回 `smtp_host`, `smtp_port`, `smtp_ssl`, `proxy_policy`，聚合器收到后立即封装进 `AccountConfig`。

---

## 9. 守护进程重构与秒级事件通知 (Daemon & Realtime Sync)

### 9.1 秒级变更唤醒 (Event-Driven Account Lifecycle)
改变当前聚合器纯靠 60 秒轮询数据库的被动机制：
1. **轻量触发端点**：聚合器内部开辟 HTTP 管理端口（`:3302/internal/notify_account_change`，受 `x-admin-auth` 保护）。
2. **保存即触发**：当 Worker 成功创建或切换外部账号后，异步向聚合器派发轻量通知包：
   ```json
   { "event": "account_upserted", "account_id": "66a19d4e-92c9-4f5e-b3fb-3151e53f17e5" }
   ```
3. **即时拉起与监听**：聚合器主循环无需重启，动态向线程池投递新的 `idle_worker` 任务，实现新账号秒级连通与实时接收。

### 9.2 出站发信闭环落地
`outbound_jobs.py` 处理 `imap_custom` 发信任务时：
1. 调用 `account.resolve_smtp_endpoint()` 获取主机与端口；
2. 依据 `account.proxy_policy` 决定是否经由 SOCKS5 代理；
3. 执行邮件投递，并在发信成功后通过 IMAP `APPEND` 对齐发件箱；
4. 更新状态回写至 Worker `sendbox` 表，完成外部账号发信审计。

---

## 10. 分阶段实施路线与验收规范 (Implementation & Acceptance)

### 10.1 阶段实施排期

| 阶段 | 重点任务 | 目标成果 | 预计周期 |
|---|---|---|---|
| **Phase 1 (P0)** | **D1 Schema 迁移与发信/网络闭环** | 补齐 `smtp_host`, `proxy_policy` 等字段；聚合器移除静态硬编码名单，支持动态代理与 `imap_custom` 发信；前端补齐底层交互。 | 1 天 |
| **Phase 2 (P0)** | **“两字段”极简交互与内置知识库** | 重构前端 `UserMailAccounts.vue`，默认仅展示邮箱与密码；接入主流邮箱前置提示与 Tier 1 自动匹配。 | 1 天 |
| **Phase 3 (P1)** | **双路自愈探测与原子智能接入 API** | Worker 实现 `smart-connect` 端点；聚合器提供即时握手探测探针；支持静默代理降级与自适应仅收信降级。 | 2 天 |
| **Phase 4 (P2)** | **行业标准发现与事件秒级唤醒** | 接入 Mozilla ISPDB 与 RFC 6186 解析；实现 Worker 到聚合器的 Webhook 秒级唤醒机制。 | 2 天 |

### 10.2 严格验收标准 (Acceptance Criteria)

1. **极简操作验收**：
   - 任意用户输入 `someone@linux.do` 与认证令牌，无需手动填写任何主机名、端口号或代理开关，点击【一键智能接入】，系统在 2 秒内自动完成识别、穿透与绑定。
2. **网络自愈验收**：
   - 在大陆网络环境下接入任意全新境外邮箱（不依赖源码名单），系统自动识别网络阻断并静默切换走 SOCKS5 隧道完成 IMAP IDLE 建立，无任何 DNS 污染或 SSRF 阻断报错。
3. **收发一体验收**：
   - 接入自定义邮箱后，在发信工作台选择该身份能够成功发送邮件；收件方收到后，邮件自动同步存入发件人的发件箱。
4. **服务商防坑验收**：
   - 当用户键入 `@linux.do` 时，界面显著提示“授权IP须留空”；若用户在令牌中误填 IP，系统在预检时准确给出“LINUX DO 令牌被 IP 拦截”的明确定位与修改指引。
5. **存量兼容验收**：
   - 数据库迁移后，既有 QQ、163、Gmail、Outlook 账号同步与发信功能 100% 保持正常。
