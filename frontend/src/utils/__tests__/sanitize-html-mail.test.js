// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeHtmlMail } from '../sanitize-html-mail';
import { blockRemoteContent } from '../remote-content-policy';

describe('sanitizeHtmlMail', () => {
    it('strips <img onerror> event handler payloads', () => {
        const r = sanitizeHtmlMail('<img src="cid:logo" onerror="alert(1)">');
        expect(r.html).not.toMatch(/onerror/i);
        expect(r.html).not.toMatch(/alert\(1\)/);
        expect(r.blocked).toBe(0);
    });

    it('removes javascript: hrefs and keeps the anchor', () => {
        const { html } = sanitizeHtmlMail('<a href="javascript:alert(document.cookie)">click</a>');
        expect(html).not.toMatch(/javascript:/i);
        expect(html).toMatch(/<a[^>]*>/i);
        expect(html).toMatch(/click/);
    });

    it('strips <script> and inline event attrs everywhere', () => {
        const r = sanitizeHtmlMail('<script>alert(1)</script><p onclick="steal(1)">hi</p><svg onload="x()"></svg>');
        expect(r.html).not.toMatch(/<script/i);
        expect(r.html).not.toMatch(/onclick/i);
        expect(r.html).not.toMatch(/onload/i);
        expect(r.html).toMatch(/hi/);
    });

    it('forbids iframe/frame/object/embed base meta link', () => {
        const r = sanitizeHtmlMail(
            '<iframe srcdoc="&lt;img src=https://evil.example/x&gt;"></iframe>' +
            '<base href="https://evil.example/"><link rel="preload" href="https://evil.example/a">' +
            '<object data="https://evil.example/x"></object>'
        );
        expect(r.html).not.toMatch(/<iframe/i);
        expect(r.html).not.toMatch(/<base/i);
        expect(r.html).not.toMatch(/<link/i);
        expect(r.html).not.toMatch(/<object/i);
        expect(r.html).not.toMatch(/evil\.example/i);
    });

    it('matches blockRemoteContent semantics exactly', () => {
        // anchor hrefs are navigation (kept); blob: URLs are provably-local (kept)
        const input =
            '<a href="blob:https://evil.example/ab">x</a>' +
            '<img src="https://evil.example/remote.png">' +
            '<img src="data:image/gif;base64,AAAA">';
        const direct = blockRemoteContent(input);
        const viaHelper = sanitizeHtmlMail(input);
        expect(viaHelper).toEqual(direct);
        // remote <img> src dropped placeholder, blob:+data image kept
        expect(viaHelper.html).toMatch(/blob:https:\/\/evil\.example\/ab/);
        expect(viaHelper.html).toMatch(/data:image/g);
        expect(viaHelper.html).not.toMatch(/remote\.png/);
    });

    it('keeps local resources: cid:, data:image, relative paths', () => {
        const { html } = sanitizeHtmlMail(
            '<img src="cid:p@x"><img src="data:image/gif;base64,AAAA">' +
            '<img src="/assets/logo.png"><a href="mailto:hi@example.com">mail</a>'
        );
        expect(html).toMatch(/cid:p@x/);
        expect(html).toMatch(/data:image/g);
        expect(html).toMatch(/\/assets\/logo\.png/);
        expect(html).toMatch(/mailto:hi@example\.com/);
    });

    it('handles non-string/empty input without throwing', () => {
        expect(sanitizeHtmlMail(undefined).html).toBe('');
        expect(sanitizeHtmlMail(null).html).toBe('');
        expect(sanitizeHtmlMail('').html).toBe('');
    });

    // R1：autoLoadRemoteImages=true 只是「额外放行远程图片」，绝不绕过消毒。
    // 恶意 <script>/事件属性在 allowRemote 下仍被剥，只有远程 <img src> 被保留。
    describe('allowRemote 仅放行远程图片、不漏脚本', () => {
        const allow = (html) => blockRemoteContent(html, { allowRemote: true });

        it('script/事件处理在 allowRemote 下仍被剥离', () => {
            const full = allow('<img src="https://evil.example/x.png" onerror="alert(1)">' +
                '<script>alert(1)</script>');
            expect(full.html).not.toMatch(/<script/i);
            expect(full.html).not.toMatch(/onerror/i);
            expect(full.html).not.toMatch(/alert\(1\)/);
        });

        it('远程 <img src> 在 allowRemote 下保留、默认路径下剥除', () => {
            const raw = '<img src="https://evil.example/remote.png">';
            const allowed = allow(raw);
            const blocked = blockRemoteContent(raw);
            expect(allowed.html).toMatch(/src="https:\/\/evil\.example\/remote\.png"/);
            expect(blocked.html).not.toMatch(/remote\.png/);
            expect(blocked.blocked).toBeGreaterThan(0);
        });

        it('javascript:/data: 导航与远程 CSS 资源即使 allowRemote 也剥除', () => {
            const produced = allow(
                '<a href="javascript:alert(document.cookie)">a</a>' +
                '<div style="background:url(https://evil.example/bg.png)">x</div>' +
                '<a href="data:text/html,<script>alert(1)</script>">d</a>'
            );
            expect(produced.html).not.toMatch(/javascript:/i);
            expect(produced.html).not.toMatch(/data:text\/html/i);
            // CSS url() 仍被替换为透明占位，不随 allowRemote 放开
            expect(produced.html).not.toMatch(/bg\.png/);
            expect(produced.html).toMatch(/data:image\/gif/);
            expect(produced.blocked).toBeGreaterThan(0);
        });

        it('调用间状态不泄漏：allowRemote 只作用于单次调用', () => {
            const raw = '<img src="https://evil.example/remote.png">';
            allow(raw); // 先开一次 allow
            const after = sanitizeHtmlMail(raw); // 下一次严格调用必须回到阻断
            expect(after.html).not.toMatch(/remote\.png/);
            expect(after.blocked).toBeGreaterThan(0);
        });
    });
});
