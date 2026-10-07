/**
 * 邮件服务商全自动配置发现引擎 (Multi-Tier Auto-Discovery Engine)
 * 严格按照 docs/external-mailbox-pipeline-upgrade.md §4 规范实现。
 *
 * Tier 1: 权威知识库 (Curated Directory) - O(1) 瞬时精确匹配
 * Tier 2: 行业标准协议 (Mozilla ISPDB XML) - 自动网络发现
 * Tier 3: 启发式端口规则 (Heuristic Fallback) - 通用兜底
 */

export interface DiscoveredMailConfig {
    provider_key: string;
    display_name: string;
    source: string;
    protocol: "auto" | "imap" | "pop3";
    host: string;
    port: number;
    use_ssl: boolean;
    smtp_host: string;
    smtp_port: number;
    smtp_ssl: boolean;
    proxy_policy: "auto" | "always" | "never";
    discovery_source: "curated_directory" | "ispdb" | "heuristic";
    hint?: string;
}

export interface CuratedProviderEntry {
    provider_key: string;
    display_name: string;
    source: string;
    protocol: "auto" | "imap" | "pop3";
    host: string;
    port: number;
    use_ssl: boolean;
    smtp_host: string;
    smtp_port: number;
    smtp_ssl: boolean;
    proxy_policy: "auto" | "always" | "never";
    hint?: string;
}

// Tier 1: 内置全球 TOP 及高频社区邮箱权威字典 (O(1) 匹配)
export const CURATED_EMAIL_PROVIDERS: Readonly<Record<string, CuratedProviderEntry>> = Object.freeze({
    "linux.do": {
        provider_key: "linux_do",
        display_name: "LINUX DO 社区邮箱 (Mailu)",
        source: "imap_custom",
        protocol: "imap",
        host: "mail.linux.do",
        port: 993,
        use_ssl: true,
        smtp_host: "mail.linux.do",
        smtp_port: 465,
        smtp_ssl: true,
        proxy_policy: "always",
        hint: "生成认证令牌时，“授权IP”务必完全留空，切勿填写 0.0.0.0。",
    },
    "qq.com": {
        provider_key: "qq",
        display_name: "腾讯 QQ 邮箱",
        source: "imap_qq",
        protocol: "imap",
        host: "imap.qq.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.qq.com",
        smtp_port: 465,
        smtp_ssl: true,
        proxy_policy: "never",
        hint: "需在 QQ 邮箱网页端开启 POP3/IMAP 服务，并使用 16 位客户端专属授权码。",
    },
    "foxmail.com": {
        provider_key: "foxmail",
        display_name: "Foxmail",
        source: "imap_qq",
        protocol: "imap",
        host: "imap.qq.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.qq.com",
        smtp_port: 465,
        smtp_ssl: true,
        proxy_policy: "never",
        hint: "需在网页端设置中生成 POP3/IMAP 专属授权码。",
    },
    "163.com": {
        provider_key: "163",
        display_name: "网易 163 邮箱",
        source: "imap_163",
        protocol: "auto",
        host: "imap.163.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.163.com",
        smtp_port: 465,
        smtp_ssl: true,
        proxy_policy: "never",
        hint: "需在网易邮箱设置中开启 POP3/IMAP 服务，并使用客户端授权密码。",
    },
    "126.com": {
        provider_key: "126",
        display_name: "网易 126 邮箱",
        source: "imap_custom",
        protocol: "auto",
        host: "imap.126.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.126.com",
        smtp_port: 465,
        smtp_ssl: true,
        proxy_policy: "never",
        hint: "需在网易邮箱设置中开启 POP3/IMAP 服务，并使用授权密码。",
    },
    "yeah.net": {
        provider_key: "yeah",
        display_name: "网易 Yeah 邮箱",
        source: "imap_custom",
        protocol: "auto",
        host: "imap.yeah.net",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.yeah.net",
        smtp_port: 465,
        smtp_ssl: true,
        proxy_policy: "never",
    },
    "gmail.com": {
        provider_key: "gmail",
        display_name: "Google Gmail",
        source: "imap_gmail",
        protocol: "imap",
        host: "imap.gmail.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        smtp_ssl: false,
        proxy_policy: "always",
        hint: "请在 Google 账户安全设置中开启两步验证，并使用 16 位“应用专用密码”。",
    },
    "googlemail.com": {
        provider_key: "gmail",
        display_name: "Google Gmail",
        source: "imap_gmail",
        protocol: "imap",
        host: "imap.gmail.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.gmail.com",
        smtp_port: 587,
        smtp_ssl: false,
        proxy_policy: "always",
        hint: "请使用 Google 账户“应用专用密码”。",
    },
    "outlook.com": {
        provider_key: "outlook",
        display_name: "Microsoft Outlook",
        source: "imap_outlook",
        protocol: "imap",
        host: "outlook.office365.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp-mail.outlook.com",
        smtp_port: 587,
        smtp_ssl: false,
        proxy_policy: "always",
        hint: "微软已全面停用普通密码直连，个人账户请使用 OAuth 配置。",
    },
    "hotmail.com": {
        provider_key: "hotmail",
        display_name: "Microsoft Hotmail",
        source: "imap_outlook",
        protocol: "imap",
        host: "outlook.office365.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp-mail.outlook.com",
        smtp_port: 587,
        smtp_ssl: false,
        proxy_policy: "always",
        hint: "微软已停用密码直连，请使用 OAuth2 认证。",
    },
    "live.com": {
        provider_key: "outlook",
        display_name: "Microsoft Live",
        source: "imap_outlook",
        protocol: "imap",
        host: "outlook.office365.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp-mail.outlook.com",
        smtp_port: 587,
        smtp_ssl: false,
        proxy_policy: "always",
    },
    "icloud.com": {
        provider_key: "icloud",
        display_name: "Apple iCloud",
        source: "imap_custom",
        protocol: "imap",
        host: "imap.mail.me.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.mail.me.com",
        smtp_port: 587,
        smtp_ssl: false,
        proxy_policy: "auto",
        hint: "须在 Apple ID 账户管理中心生成“App 专用密码”。",
    },
    "me.com": {
        provider_key: "icloud",
        display_name: "Apple iCloud",
        source: "imap_custom",
        protocol: "imap",
        host: "imap.mail.me.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.mail.me.com",
        smtp_port: 587,
        smtp_ssl: false,
        proxy_policy: "auto",
    },
    "fastmail.com": {
        provider_key: "fastmail",
        display_name: "Fastmail",
        source: "imap_custom",
        protocol: "imap",
        host: "imap.fastmail.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.fastmail.com",
        smtp_port: 465,
        smtp_ssl: true,
        proxy_policy: "always",
        hint: "请在 Fastmail 设置中创建 App Password。",
    },
    "zoho.com": {
        provider_key: "zoho",
        display_name: "Zoho Mail",
        source: "imap_custom",
        protocol: "imap",
        host: "imap.zoho.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.zoho.com",
        smtp_port: 465,
        smtp_ssl: true,
        proxy_policy: "always",
    },
    "zoho.eu": {
        provider_key: "zoho",
        display_name: "Zoho Mail (EU)",
        source: "imap_custom",
        protocol: "imap",
        host: "imap.zoho.eu",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.zoho.eu",
        smtp_port: 465,
        smtp_ssl: true,
        proxy_policy: "always",
    },
    "aliyun.com": {
        provider_key: "aliyun",
        display_name: "阿里企业邮箱",
        source: "imap_custom",
        protocol: "imap",
        host: "imap.qiye.aliyun.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.qiye.aliyun.com",
        smtp_port: 465,
        smtp_ssl: true,
        proxy_policy: "never",
    },
    "feishu.cn": {
        provider_key: "feishu",
        display_name: "飞书邮箱",
        source: "imap_custom",
        protocol: "imap",
        host: "imap.feishu.cn",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.feishu.cn",
        smtp_port: 465,
        smtp_ssl: true,
        proxy_policy: "never",
        hint: "请在飞书客户端安全中心中生成第三方邮件客户端授权码。",
    },
    "sina.com": {
        provider_key: "sina",
        display_name: "新浪邮箱",
        source: "imap_custom",
        protocol: "imap",
        host: "imap.sina.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.sina.com",
        smtp_port: 465,
        smtp_ssl: true,
        proxy_policy: "never",
    },
    "sohu.com": {
        provider_key: "sohu",
        display_name: "搜狐邮箱",
        source: "imap_custom",
        protocol: "imap",
        host: "imap.sohu.com",
        port: 993,
        use_ssl: true,
        smtp_host: "smtp.sohu.com",
        smtp_port: 465,
        smtp_ssl: true,
        proxy_policy: "never",
    },
});

const DOMAIN_REGEX = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;
const IPV4_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const MAX_ISPDB_BODY_LENGTH = 64 * 1024; // 64 KB 响应体安全截断上限

/**
 * 校验提取的邮箱域名是否符合 RFC 1035/5321 规范，并拒绝 IP 地址或无顶级域的主机。
 */
export const isValidEmailDomain = (domain: string): boolean => {
    if (!domain || domain.length > 253) return false;
    if (IPV4_REGEX.test(domain)) return false;
    return DOMAIN_REGEX.test(domain);
};

/**
 * 从完整的邮箱地址提取纯小写合规域名。
 */
export const extractEmailDomain = (email: string): string | null => {
    const trimmed = String(email || "").trim().toLowerCase();
    const atIndex = trimmed.lastIndexOf("@");
    if (atIndex <= 0 || atIndex === trimmed.length - 1) return null;
    const domain = trimmed.slice(atIndex + 1).trim();
    return isValidEmailDomain(domain) ? domain : null;
};

/**
 * 解析 Mozilla ISPDB autoconfig XML 格式文本（轻量流式正则提取，零重型 XML 依赖）。
 */
export const parseMozillaIspdbXml = (xml: string, domain: string): DiscoveredMailConfig | null => {
    if (!xml || typeof xml !== "string" || !xml.includes("<clientConfig")) {
        return null;
    }

    // 匹配 <incomingServer type="imap"> ... </incomingServer>
    const imapMatch = xml.match(/<incomingServer\b[^>]*type=["']imap["'][^>]*>([\s\S]*?)<\/incomingServer>/i);
    // 匹配 <outgoingServer type="smtp"> ... </outgoingServer>
    const smtpMatch = xml.match(/<outgoingServer\b[^>]*type=["']smtp["'][^>]*>([\s\S]*?)<\/outgoingServer>/i);

    if (!imapMatch || !imapMatch[1]) return null;

    const extractTag = (block: string, tag: string): string => {
        const m = block.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, "i"));
        return m && m[1] ? m[1].trim() : "";
    };

    const imapBlock = imapMatch[1];
    const imapHost = extractTag(imapBlock, "hostname");
    const imapPortRaw = Number(extractTag(imapBlock, "port"));
    const imapSocketType = extractTag(imapBlock, "socketType").toUpperCase();

    if (!imapHost || !Number.isInteger(imapPortRaw) || imapPortRaw <= 0) {
        return null;
    }

    const imapUseSsl = imapSocketType === "SSL" || imapPortRaw === 993;

    let smtpHost = "";
    let smtpPort = 465;
    let smtpUseSsl = true;

    if (smtpMatch && smtpMatch[1]) {
        const smtpBlock = smtpMatch[1];
        smtpHost = extractTag(smtpBlock, "hostname");
        const smtpPortRaw = Number(extractTag(smtpBlock, "port"));
        const smtpSocketType = extractTag(smtpBlock, "socketType").toUpperCase();
        if (smtpHost && Number.isInteger(smtpPortRaw) && smtpPortRaw > 0) {
            smtpPort = smtpPortRaw;
            smtpUseSsl = smtpSocketType === "SSL" || smtpPort === 465;
        }
    }

    if (!smtpHost) {
        smtpHost = imapHost.toLowerCase().startsWith("imap.") ? `smtp.${imapHost.slice(5)}` : imapHost;
    }

    return {
        provider_key: domain.replace(/[^a-zA-Z0-9_-]/g, "_"),
        display_name: `${domain} 企业邮箱`,
        source: "imap_custom",
        protocol: "imap",
        host: imapHost,
        port: imapPortRaw,
        use_ssl: imapUseSsl,
        smtp_host: smtpHost,
        smtp_port: smtpPort,
        smtp_ssl: smtpUseSsl,
        proxy_policy: "auto",
        discovery_source: "ispdb",
    };
};

/**
 * 启发式推导（Tier 3）
 */
export const buildHeuristicConfig = (domain: string): DiscoveredMailConfig => {
    const isAlreadyMailSubdomain = domain.startsWith("mail.") || domain.startsWith("imap.");
    const imapHost = isAlreadyMailSubdomain ? domain : `imap.${domain}`;
    const smtpHost = isAlreadyMailSubdomain ? domain : `smtp.${domain}`;

    return {
        provider_key: "custom",
        display_name: `${domain} 邮箱`,
        source: "imap_custom",
        protocol: "auto",
        host: imapHost,
        port: 993,
        use_ssl: true,
        smtp_host: smtpHost,
        smtp_port: 465,
        smtp_ssl: true,
        proxy_policy: "auto",
        discovery_source: "heuristic",
    };
};

/**
 * 全自动配置发现入口：阶梯式执行 Tier 1 -> Tier 2 -> Tier 3
 */
export async function discoverMailConfig(
    email: string,
    fetchFn: typeof fetch = fetch
): Promise<DiscoveredMailConfig> {
    const domain = extractEmailDomain(email);
    if (!domain) {
        throw new Error("invalid email address");
    }

    // 1. Tier 1: 权威预置字典匹配 (O(1))
    const curated = CURATED_EMAIL_PROVIDERS[domain];
    if (curated) {
        return {
            ...curated,
            discovery_source: "curated_directory",
        };
    }

    // 2. Tier 2: 行业标准 Mozilla ISPDB 自动发现
    try {
        const ispdbUrl = `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`;
        const res = await fetchFn(ispdbUrl, {
            headers: { "Accept": "application/xml, text/xml" },
            signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
            const rawText = await res.text();
            const xmlText = rawText.slice(0, MAX_ISPDB_BODY_LENGTH);
            const discovered = parseMozillaIspdbXml(xmlText, domain);
            if (discovered) {
                return discovered;
            }
        }
    } catch {
        // 网络超时或 ISPDB 无记录，平滑降级至启发式兜底
    }

    // 3. Tier 3: 启发式端口约定兜底
    return buildHeuristicConfig(domain);
}
