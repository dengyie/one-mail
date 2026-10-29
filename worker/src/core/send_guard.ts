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
