/** 解析 folders_json，畸形值兜底为 ["INBOX"]——绝不让单条坏数据 500 掉整列。 */
export const safeFolders = (raw: string | null): string[] => {
    if (typeof raw !== "string" || !raw.trim()) return ["INBOX"];
    try {
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value)) return ["INBOX"];
        const folders = value
            .filter((folder): folder is string => typeof folder === "string")
            .map((folder) => folder.trim())
            .filter(Boolean);
        return folders.length ? folders : ["INBOX"];
    } catch {
        return ["INBOX"];
    }
};

/**
 * 同步范围 = 用户配置的目录 + 该账号已发现的垃圾邮件目录（folder_type='spam'）。
 *
 * 归集的目标是「不漏邮件」，而垃圾邮件最容易被漏掉：它不在 INBOX，folders 默认为
 * ["INBOX"] 的账号永远看不到它。目录由聚合器 IMAP LIST 按 \Junk/\Spam 等标志发现
 * （本地化名称如 `[Gmail]/垃圾邮件` 也能命中），这里把它并入导出给聚合器的 folders。
 * 追加而非前置：聚合器只对 folders[0] 建立 IMAP IDLE 实时监听，INBOX 必须保持在首位。
 */
export const withSpamFolders = (configured: string[], spam: readonly string[]): string[] => {
    const folders = [...configured];
    const seen = new Set(folders.map((folder) => folder.trim().toLowerCase()));
    for (const name of spam) {
        const trimmed = String(name ?? "").trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        folders.push(trimmed);
    }
    return folders;
};
