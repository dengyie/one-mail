/**
 * 邮件服务商接入上下文智能提示 (Contextual Intelligence Hint Rules)
 * 根据 docs/external-mailbox-pipeline-upgrade.md §7 规范实现。
 *
 * 提示文案不落在本模块：这里只返回 stable providerKey 与 i18n 键，
 * 由视图用 useScopedI18n('providerHints') 渲染成当前语言。
 */

export const PROVIDER_CONTEXT_HINTS = [
    {
        match: /@linux\.do$/i,
        providerKey: "linux_do",
        badgeKey: "linuxDo.badge",
        warningKey: "linuxDo.warning",
    },
    {
        match: /@(qq|foxmail)\.com$/i,
        providerKey: "qq",
        badgeKey: "qq.badge",
        warningKey: "qq.warning",
    },
    {
        match: /@(163|126|yeah)\.(com|net)$/i,
        providerKey: "netease",
        badgeKey: "netease.badge",
        warningKey: "netease.warning",
    },
    {
        match: /@gmail\.com$/i,
        providerKey: "gmail",
        badgeKey: "gmail.badge",
        warningKey: "gmail.warning",
    },
    {
        match: /@(outlook|hotmail)\.com$/i,
        providerKey: "outlook",
        badgeKey: "outlook.badge",
        warningKey: "outlook.warning",
    },
    {
        match: /@feishu\.cn$/i,
        providerKey: "feishu",
        badgeKey: "feishu.badge",
        warningKey: "feishu.warning",
    },
    {
        // Agent 邮箱无 IMAP/POP3 端点，smart 模式（自动发现）必然失败——提示
        // 用户走手动配置的 Agent 邮箱预设粘贴 refresh_token。
        match: /@agent\.qq\.com$/i,
        providerKey: "agent",
        badgeKey: "agent.badge",
        warningKey: "agent.warning",
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
