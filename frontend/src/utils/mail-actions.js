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
 * Build the send-mail model for replying to an email.
 * @param {Object} mail - The mail object (curMail)
 * @param {string} replyLabel - Translated "Reply" label
 * @returns {Object} Fields to assign onto sendMailModel
 */
export function buildReplyModel(mail, replyLabel) {
  const emailRegex = /(.+?) <(.+?)>/;
  let toMail = mail.originalSource || '';
  let toName = "";
  const match = emailRegex.exec(mail.source);
  if (match) {
    toName = match[1];
    toMail = match[2];
  }
  const safeContent = sanitizeContent(mail);
  return {
    toName,
    toMail,
    subject: `${replyLabel}: ${mail.subject}`,
    contentType: mail.message ? 'html' : 'rich',
    content: safeContent
      ? `<p><br></p><blockquote>${safeContent}</blockquote><p><br></p>`
      : '',
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
