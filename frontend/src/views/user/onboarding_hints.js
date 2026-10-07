/**
 * 邮件服务商接入上下文智能提示 (Contextual Intelligence Hint Rules)
 * 根据 docs/external-mailbox-pipeline-upgrade.md §7 规范实现。
 */

export const PROVIDER_CONTEXT_HINTS = [
    {
        match: /@linux\.do$/i,
        providerKey: "linux_do",
        badge: "LINUX DO Mail (Mailu)",
        warningText: "生成认证令牌时，“授权IP”请务必完全留空，切勿填写 0.0.0.0。",
    },
    {
        match: /@(qq|foxmail)\.com$/i,
        providerKey: "qq",
        badge: "QQ 邮箱",
        warningText: "需在 QQ 邮箱网页端“设置-账户”中开启 POP3/IMAP 服务，并使用 16 位专属授权码。",
    },
    {
        match: /@(163|126|yeah)\.(com|net)$/i,
        providerKey: "netease",
        badge: "网易 163/126 邮箱",
        warningText: "请在网页端设置中开启 POP3/IMAP 服务，并输入客户端专用授权密码。",
    },
    {
        match: /@gmail\.com$/i,
        providerKey: "gmail",
        badge: "Google Gmail",
        warningText: "须开启 Google 账户两步验证，并使用安全中心生成的 16 位“应用专用密码”。",
    },
    {
        match: /@(outlook|hotmail)\.com$/i,
        providerKey: "outlook",
        badge: "微软个人邮箱 (Outlook)",
        warningText: "微软已停用普通密码直连，请使用 OAuth2 认证 JSON 接入。",
    },
    {
        match: /@feishu\.cn$/i,
        providerKey: "feishu",
        badge: "飞书企业邮箱",
        warningText: "须在飞书客户端安全中心获取外部客户端专用授权码。",
    },
];

export function getProviderContextHint(email) {
    if (!email || typeof email !== "string") return null;
    const trimmed = email.trim();
    for (const hint of PROVIDER_CONTEXT_HINTS) {
        if (hint.match.test(trimmed)) {
            return hint;
        }
    }
    return null;
}
