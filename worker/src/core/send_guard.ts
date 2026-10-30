/**
 * Recipient block-list matching shared by domain send and Gmail reroute.
 *
 * node --test loads this module directly, so its imports stay dependency-free.
 * The match is the existing substring rule: an entry of "spam.test" blocks
 * "a@spam.test". A Gmail reply must use it too, because that path never enters
 * sendMail.
 */

import { singleHeaderValue } from "./header_value.ts";

// Re-exported so every existing caller keeps importing the guard from here.
export { singleHeaderValue };

export const recipientIsBlocked = (toMail: string, blockList: unknown): boolean => {
    if (!Array.isArray(blockList)) return false;
    return blockList.some((item) => typeof item === "string" && item.length > 0 && toMail.includes(item));
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
