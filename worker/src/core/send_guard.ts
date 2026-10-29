/**
 * Recipient block-list matching shared by domain send and Gmail reroute.
 *
 * node --test loads this module directly, so it has zero imports. The match is
 * the existing substring rule: an entry of "spam.test" blocks "a@spam.test".
 * A Gmail reply must use it too, because that path never enters sendMail.
 */

export const recipientIsBlocked = (toMail: string, blockList: unknown): boolean => {
    if (!Array.isArray(blockList)) return false;
    return blockList.some((item) => typeof item === "string" && item.length > 0 && toMail.includes(item));
};

/**
 * One RFC 5322 header value. A CR or LF would start another header, so the
 * whole value is dropped rather than sent. Domain send, the outbound payload
 * check, and a stored Message-ID reused as In-Reply-To all share this rule.
 */
export const singleHeaderValue = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    if (!text || /[\r\n]/.test(text)) return undefined;
    return text;
};

/**
 * In-Reply-To and References for a domain send. A value that contains CR or LF
 * is omitted so mimetext, Resend, worker-mailer, and the SEND_MAIL binding
 * cannot turn it into a second header. A new mail with neither field is unchanged.
 */
export const threadingHeaders = (reqJson: {
    in_reply_to?: unknown;
    references?: unknown;
}): Record<string, string> => {
    const headers: Record<string, string> = {};
    const inReplyTo = singleHeaderValue(reqJson.in_reply_to);
    if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
    const references = Array.isArray(reqJson.references)
        ? reqJson.references.map((value) => singleHeaderValue(value)).filter((value): value is string => Boolean(value))
        : [];
    if (references.length > 0) headers["References"] = references.join(" ");
    return headers;
};
