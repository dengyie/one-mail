import { blockRemoteContent } from './remote-content-policy';

/**
 * Sanitise an email body for safe rendering, reusing the same security
 * pipeline as the main mail reader (MailContentRenderer.vue).
 *
 * `blockRemoteContent` performs the full provably-local proof + DOMPurify
 * whitelist pass: it strips scripts, event handlers, remote resource URLs and
 * dangerous navigation schemes, and rewrites cid:/blob:/data:image/ inline
 * resources so layout survives. This is the single security boundary for mail
 * bodies — the backend has no rich-text allowlist — so every render path
 * (including the Telegram miniapp's <iframe srcdoc>) must go through it.
 *
 * @param {string} content raw parsed mail body (HTML or text)
 * @returns {{ html: string, blocked: number }} sanitised HTML + count of blocked remote refs
 */
export function sanitizeHtmlMail(content) {
    return blockRemoteContent(content);
}