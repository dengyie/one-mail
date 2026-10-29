import { blockRemoteContent } from './remote-content-policy';

/**
 * HTML-escape special characters for plain text content.
 */
function escapeHtml(str) {
  const text = String(str ?? '');
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Sanitize mail content: HTML-escape plain text, whitelist-sanitize HTML.
 *
 * Quoting a mail (reply/forward) must go through the same security boundary as
 * rendering it: blockRemoteContent strips remote resources (tracking pixels,
 * external CSS url()s) and XSS surfaces, keeping only provably-local refs. This
 * prevents remote tracking images from being carried into a reply and loaded by
 * the recipient's client once sent.
 */
function sanitizeContent(mail) {
  if (mail.message) {
    return blockRemoteContent(mail.message).html;
  }
  if (mail.text) {
    return escapeHtml(mail.text);
  }
  return '';
}

/**
 * RFC 5322 reply subject. An existing Re: (any number of them, any case) is
 * kept as a single prefix so a reply to a reply does not become "Re: Re:".
 */
export function replySubject(subject) {
  const text = String(subject ?? '').trim();
  const stripped = text.replace(/^(?:\s*re\s*:\s*)+/i, '').trim();
  return `Re: ${stripped}`;
}

/**
 * Build the send-mail model for replying to an email.
 * @param {Object} mail - The mail object (curMail)
 * @param {string} [_replyLabel] - Unused. Kept so existing callers stay valid;
 *   the subject prefix is always the literal "Re:", not a translated label.
 * @returns {Object} Fields to assign onto sendMailModel
 */
export function buildReplyModel(mail, _replyLabel) {
  const emailRegex = /(.+?) <(.+?)>/;
  let toMail = mail.originalSource || '';
  let toName = "";
  const match = emailRegex.exec(mail.source);
  if (match) {
    toName = match[1];
    toMail = match[2];
  }
  const safeContent = sanitizeContent(mail);
  const messageId = typeof mail.messageId === 'string'
    ? mail.messageId.trim()
    : (typeof mail.message_id_header === 'string' ? mail.message_id_header.trim() : '');
  const priorReferences = typeof mail.references === 'string'
    ? mail.references.split(/\s+/).filter(Boolean)
    : Array.isArray(mail.references)
      ? mail.references.filter((value) => typeof value === 'string' && value.trim())
      : (typeof mail.references_json === 'string'
        ? (() => {
            try {
              const parsed = JSON.parse(mail.references_json);
              return Array.isArray(parsed)
                ? parsed.filter((value) => typeof value === 'string' && value.trim())
                : [];
            } catch {
              return [];
            }
          })()
        : []);
  const references = messageId && !priorReferences.includes(messageId)
    ? [...priorReferences, messageId]
    : priorReferences;
  const threadId = typeof mail.provider_thread_id === 'string' && /^[0-9a-f]{1,16}$/i.test(mail.provider_thread_id.trim())
    ? mail.provider_thread_id.trim().toLowerCase()
    : '';
  const replyToEmailId = typeof mail.id === 'string' ? mail.id.trim() : '';
  const replyAccountId = mail.source === 'imap_gmail' && typeof mail.account_id === 'string'
    ? mail.account_id.trim()
    : '';
  return {
    toName,
    toMail,
    subject: replySubject(mail.subject),
    contentType: mail.message ? 'html' : 'rich',
    content: safeContent
      ? `<p><br></p><blockquote>${safeContent}</blockquote><p><br></p>`
      : '',
    ...(messageId ? { inReplyTo: messageId } : {}),
    ...(references.length > 0 ? { references } : {}),
    ...(threadId ? { providerThreadId: threadId } : {}),
    ...(replyToEmailId ? { replyToEmailId } : {}),
    ...(replyAccountId ? { replyAccountId } : {}),
  };
}

/**
 * Build the send-mail model for forwarding an email.
 * @param {Object} mail - The mail object (curMail)
 * @param {string} forwardLabel - Translated "Forward" label
 * @returns {Object} Fields to assign onto sendMailModel
 */
export function buildForwardModel(mail, forwardLabel) {
  return {
    subject: `${forwardLabel}: ${mail.subject}`,
    contentType: mail.message ? 'html' : 'text',
    content: sanitizeContent(mail),
  };
}
