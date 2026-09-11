type UserRole = {
    domains: string[] | undefined | null,
    role: string,
    prefix: string | undefined | null
}

type SmtpImapProxyConfig = {
    smtp?: {
        host?: string
        port?: number | string
        starttls?: boolean | string
    }
    imap?: {
        host?: string
        port?: number | string
        starttls?: boolean | string
    }
}

type Bindings = {
    // bindings
    DB: D1Database
    KV: KVNamespace
    RATE_LIMITER: RateLimit
    SEND_MAIL: SendEmail
    ASSETS: Fetcher
    AI: Ai

    // config
    DEFAULT_LANG: string | undefined
    TITLE: string | undefined
    ANNOUNCEMENT: string | undefined | null
    ALWAYS_SHOW_ANNOUNCEMENT: string | boolean | undefined
    PREFIX: string | undefined
    ADDRESS_CHECK_REGEX: string | undefined
    ADDRESS_REGEX: string | undefined
    MIN_ADDRESS_LEN: string | number | undefined
    MAX_ADDRESS_LEN: string | number | undefined
    DEFAULT_DOMAINS: string | string[] | undefined
    DOMAINS: string | string[] | undefined
    ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH: string | boolean | undefined
    RANDOM_SUBDOMAIN_DOMAINS: string | string[] | undefined
    RANDOM_SUBDOMAIN_LENGTH: string | number | undefined
    DISABLE_CUSTOM_ADDRESS_NAME: string | boolean | undefined
    CREATE_ADDRESS_DEFAULT_DOMAIN_FIRST: string | boolean | undefined
    ADMIN_USER_ROLE: string | undefined
    USER_DEFAULT_ROLE: string | UserRole | undefined
    USER_ROLES: string | UserRole[] | undefined
    DOMAIN_LABELS: string | string[] | undefined
    PASSWORDS: string | string[] | undefined
    ADMIN_PASSWORDS: string | string[] | undefined
    DISABLE_ADMIN_PASSWORD_CHECK: string | boolean | undefined
    JWT_SECRET: string
    // 地址 JWT 过期天数（默认 90，见 core/auth.ts）。自 H2 起无条件拒绝无 exp/
    // 过期地址 JWT；REJECT_EXPLESS_JWT 仅为向后兼容保留，无行为作用。
    ADDRESS_JWT_TTL_DAYS: string | number | undefined
    // 向后兼容保留（H2 移除门控后不再生效），勿再使用。
    REJECT_EXPLESS_JWT: string | boolean | undefined
    BLACK_LIST: string | undefined
    ENABLE_AUTO_REPLY: string | boolean | undefined
    ENABLE_WEBHOOK: string | boolean | undefined
    ENABLE_USER_CREATE_EMAIL: string | boolean | undefined
    DISABLE_ANONYMOUS_USER_CREATE_EMAIL: string | boolean | undefined
    ENABLE_USER_DELETE_EMAIL: string | boolean | undefined
    ENABLE_ADDRESS_PASSWORD: string | boolean | undefined
    ENABLE_AGENT_EMAIL_INFO: string | boolean | undefined
    SMTP_IMAP_PROXY_CONFIG: string | SmtpImapProxyConfig | undefined
    ENABLE_INDEX_ABOUT: string | boolean | undefined
    DEFAULT_SEND_BALANCE: number | string | undefined
    NO_LIMIT_SEND_ROLE: string | undefined | null
    ADMIN_CONTACT: string | undefined
    COPYRIGHT: string | undefined
    STATUS_URL: string | undefined
    DISABLE_SHOW_GITHUB: string | boolean | undefined
    DISABLE_SHOW_GITHUB_FOR_USER: string | boolean | undefined
    FORWARD_ADDRESS_LIST: string | string[] | undefined

    ENABLE_CHECK_JUNK_MAIL: string | boolean | undefined
    JUNK_MAIL_CHECK_LIST: string | string[] | undefined
    JUNK_MAIL_FORCE_PASS_LIST: string | string[] | undefined

    ENABLE_ANOTHER_WORKER: string | boolean | undefined
    ANOTHER_WORKER_LIST: string | AnotherWorker[] | undefined

    SUBDOMAIN_FORWARD_ADDRESS_LIST: string | SubdomainForwardAddressList[] | undefined

    REMOVE_ALL_ATTACHMENT: string | boolean | undefined
    REMOVE_EXCEED_SIZE_ATTACHMENT: string | boolean | undefined

    // s3 config
    S3_ENDPOINT: string | undefined
    S3_ACCESS_KEY_ID: string | undefined
    S3_SECRET_ACCESS_KEY: string | undefined
    S3_BUCKET: string | undefined
    S3_URL_EXPIRES: number | undefined

    // cf turnstile
    CF_TURNSTILE_SITE_KEY: string | undefined
    CF_TURNSTILE_SECRET_KEY: string | undefined

    // AES-GCM 凭据加密密钥（32 字节 base64），加密 user_mail_accounts.cred_enc
    MAIL_CRED_ENCRYPTION_KEY: string | undefined

    // resend
    RESEND_TOKEN: string | undefined
    [key: `RESEND_TOKEN_${string}`]: string | undefined

    // SMTP config
    SMTP_CONFIG: string | object | undefined
    SEND_MAIL_DOMAINS: string | string[] | undefined

    // telegram config
    TELEGRAM_BOT_TOKEN: string
    TELEGRAM_SECRET_TOKEN: string | undefined
    TG_MAX_ADDRESS: number | undefined
    TG_BOT_INFO: string | object | undefined
    TG_ALLOW_USER_LANG: string | boolean | undefined
    ENABLE_TG_PUSH_ATTACHMENT: string | boolean | undefined

    // webhook config
    FRONTEND_URL: string | undefined

    // AI extraction config
    ENABLE_AI_EMAIL_EXTRACT: string | boolean | undefined
    AI_EXTRACT_MODEL: string | undefined

    // gzip compression for raw_mails
    ENABLE_MAIL_GZIP: string | boolean | undefined
    CLEANUP_BATCH_SIZE: string | number | undefined

    // E2E testing
    E2E_TEST_MODE: string | boolean | undefined
}

type JwtPayload = {
    address: string
    address_id: number
}

type UserPayload = {
    user_email: string
    user_id: number
    exp: number
    iat: number
}

type Variables = {
    userPayload: UserPayload,
    userRolePayload: string | undefined | null,
    jwtPayload: JwtPayload,
    lang: string | undefined | null
    // API-key auth on unified routes (Task 12). Structurally matches ApiKeyRow
    // from unified/api_keys.ts; kept inline so this global script stays a module-free file.
    apiKey?: {
        id: string, name: string, key_hash: string, role: string,
        allowed_sources: string | null, allowed_accounts: string | null, enabled: number,
    },
    // 用户登录通道（x-user-token）鉴权后的统一收件箱上下文。
    // 与 apiKey 并列：用户登录优先于 API-key（浏览器 UI 用），程序化访问仍走 apiKey。
    unifiedUserAuth?: {
        userPayload: UserPayload,
        isAdmin: boolean,
        // 已解析的用户角色，统一查询配额与管理员绕过均复用这一值，避免每个端点重复查角色。
        userRole?: string | null,
        // 普通用户的收件地址归属作用域（逗号多值，配合 buildEmailFilters 的 to_addr IN）。
        // 管理员不设此字段（看全部）。无绑定地址时为 "__none__" 哨兵（fail-closed 返回 0 行）。
        toAddrScope?: string,
    }
}

type HonoCustomType = {
    "Bindings": Bindings;
    "Variables": Variables;
}

type AnotherWorker = {
    binding: string | undefined | null,
    method: string | undefined | null,
    keywords: string[] | undefined | null
}

type RPCEmailMessage = {
    from: string | undefined | null,
    to: string | undefined | null,
    rawEmail: string | undefined | null,
    headers: object | undefined | null,
}

type ParsedEmailAttachment = {
    filename: string,
    mimeType: string,
    content: Uint8Array,
    disposition: string,
}

type ParsedEmailContext = {
    rawEmail: string,
    parsedEmail?: {
        sender: string,
        subject: string,
        text: string,
        html: string,
        headers?: Record<string, string>[],
        attachments?: ParsedEmailAttachment[],
    } | undefined
}

type SubdomainForwardAddressList = {
    domains: string[] | undefined | null,
    forward: string,
    // 来源地址正则匹配 (可选，兼容原配置)
    sourcePatterns?: string[] | undefined | null,  // 来源地址正则表达式列表
    sourceMatchMode?: 'any' | 'all' | undefined,   // 匹配模式: any-任一匹配, all-全部匹配
}
