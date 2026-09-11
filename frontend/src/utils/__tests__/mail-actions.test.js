// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildReplyModel, buildForwardModel } from '../mail-actions';

const T = 'https://tracker.example/p.png';

function firstMail(message) {
    return {
        source: 'Sender Name <sender@example.com>',
        originalSource: 'recipient@example.com',
        subject: 'hello',
        message,
    };
}

function hasAttrValue(html, tag, attr, needle) {
    const host = document.createElement('div');
    host.innerHTML = html;
    for (const el of host.querySelectorAll(tag)) {
        const v = el.getAttribute(attr) || '';
        if (v.includes(needle)) return true;
    }
    return false;
}

describe('buildReplyModel / buildForwardModel quoting pipeline', () => {
    it('keeps external navigation links but blocks remote <img> source in the quote', () => {
        const mail = firstMail(`<a href="${T}">open</a><img src="${T}">`);
        const reply = buildReplyModel(mail, 'Re');
        expect(reply.toMail).toBe('sender@example.com');
        expect(reply.toName).toBe('Sender Name');
        expect(reply.subject).toContain('Re:');
        // navigation links stay; remote image source is removed entirely
        expect(hasAttrValue(reply.content, 'a', 'href', T)).toBe(true);
        expect(hasAttrValue(reply.content, 'img', 'src', T)).toBe(false);
    });

    it('strips remote CSS url() fetches from the quoted reply', () => {
        const mail = firstMail(`<style>.a{background:url(${T})}</style>`);
        const reply = buildReplyModel(mail, 'Re');
        expect(reply.content).not.toContain(T);
        expect(reply.content).toContain('blockquote');
    });

    it('strips scripts and event handlers even when quoted', () => {
        const mail = firstMail('<img src="cid:logo" onerror="alert(1)"><script>alert(1)</script>');
        const reply = buildReplyModel(mail, 'Re');
        expect(reply.content).not.toMatch(/onerror/i);
        expect(reply.content).not.toMatch(/alert\(1\)/);
        expect(reply.content).not.toMatch(/<script/i);
    });

    it('keeps provably-local resources (cid:/blob:/data:image) in the quote', () => {
        const mail = firstMail('<img src="cid:p@x"><img src="data:image/gif;base64,yR0lGOD">');
        const reply = buildReplyModel(mail, 'Re');
        expect(reply.content).toContain('cid:p@x');
        expect(reply.content).toContain('data:image/gif');
    });

    it('forward walks the same pipeline and keeps attachment to-level shape', () => {
        const mail = firstMail(`<img src="${T}">`);
        const forward = buildForwardModel(mail, 'Fwd');
        expect(forward.subject).toContain('Fwd:');
        expect(forward.contentType).toBe('html');
        expect(forward.content).not.toContain(T);
    });

    it('escapes plain-text bodies instead of treating them as HTML', () => {
        const reply = buildReplyModel({ ...firstMail(), message: undefined, text: '<b>hi & bye</b>' }, 'Re');
        expect(reply.content).toContain('&lt;b&gt;');
        expect(reply.content).not.toMatch(/<b>/);
    });
});