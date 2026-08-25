import DOMPurify from 'dompurify';

// Project-wide safe-HTML policy for *user-authored* content (send-mail previews,
// OAuth provider icons, announcements). It is deliberately stricter than
// DOMPurify's defaults on the two channels that turn links into executable
// pages: only http/https/mailto survive as attribute URLs. `javascript:`,
// `data:text/html` and friends are stripped by DOMPurify's URL allowlist; the
// default element/attribute allowlist already rejects script-bearing tags and
// event handlers, so FORBID_TAGS/ALLOWED_ATTR are left to defaults.
//
// This is the last line of defence for the rich-text editor: the backend sends
// `is_html` verbatim, so whatever survives this function reaches the recipient.
// The mail-body pipeline (`sanitize-html-mail.js`) is a separate, stricter
// boundary with remote-resource blocking and is used by the real reader.
const SANITIZE_HTML_URI_REGEXP =
    /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

let purifier = null;
function getPurifier() {
    if (!purifier) {
        purifier = DOMPurify(globalThis.window);
    }
    return purifier;
}

export const sanitizeHtml = (html) => {
    return getPurifier().sanitize(typeof html === 'string' ? html : '', {
        ALLOWED_URI_REGEXP: SANITIZE_HTML_URI_REGEXP,
    });
};
