// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '../sanitize-html';

describe('sanitizeHtml', () => {
    it('preserves safe announcement markup', () => {
        expect(sanitizeHtml('<strong>Notice</strong>')).toBe('<strong>Notice</strong>');
    });

    it('removes executable markup and unsafe attributes', () => {
        const sanitized = sanitizeHtml(
            '<script>alert(1)</script><img src="x" onerror="alert(1)">'
        );

        expect(sanitized).not.toContain('<script');
        expect(sanitized).not.toContain('onerror');
        expect(sanitized).toContain('<img src="x">');
    });

    it('returns an empty string for non-string values', () => {
        expect(sanitizeHtml(null)).toBe('');
        expect(sanitizeHtml({ value: '<strong>unsafe ref</strong>' })).toBe('');
    });

    // 发信预览层（index/admin SendMail + SendBox）的 URL 策略：只保留
    // http/https/mailto，禁 javascript:/data:text/html/form-action 启动。
    it('允许默认白名单在严格 ALLOWED_URI_REGEXP 下不回归', () => {
        const out = sanitizeHtml('<p><a href="https://example.com">go</a></p>');
        expect(out).toContain('https://example.com');
        expect(out).toContain('<p>');
    });

    it('剥除 javascript: 链接', () => {
        const out = sanitizeHtml('<a href="javascript:alert(1)" onclick="x()">danger</a>');
        expect(out).not.toMatch(/javascript:/i);
        expect(out).not.toMatch(/onclick/i);
        expect(out).toContain('danger');
    });

    it('剥除 form action 中的可执行协议', () => {
        const out = sanitizeHtml(
            '<form action="javascript:document.body.innerHTML=\'\'"><input></form>' +
            '<form action="data:text/html,<script>alert(1)</script>"></form>'
        );
        expect(out).not.toMatch(/javascript:/i);
        expect(out).not.toMatch(/action=/i);
    });

    it('剥除 data:text/html 与 data: 非图片承载', () => {
        const out = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
        expect(out).not.toContain('data:text/html');
        expect(out).toContain('x');
    });

    it('剥除事件属性与脚本标签（mail 正文管道同语义）', () => {
        const out = sanitizeHtml('<img src="cid:logo" onerror="alert(1)"><script>alert(1)</script>');
        expect(out).not.toContain('onerror');
        expect(out).not.toContain('<script');
    });
});
