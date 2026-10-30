/**
 * The one rule for a single RFC 5322 header value.
 *
 * A CR or LF would start another header, so a value carrying either is dropped
 * whole rather than sent. Domain send, the outbound payload check, the Gmail
 * reroute and a stored Message-ID reused as In-Reply-To all go through here, so
 * the rule can only be tightened in one place.
 *
 * Zero imports: node --test loads this module directly.
 */

export const singleHeaderValue = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    if (!text || /[\r\n]/.test(text)) return undefined;
    return text;
};
