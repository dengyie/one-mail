// @vitest-environment jsdom
import { createApp, nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import StreamMarkdown from '../StreamMarkdown.vue';

const mountedApps = [];

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe('StreamMarkdown', () => {
  it('sanitizes executable links and raw HTML from untrusted mail fields', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(StreamMarkdown, {
      content: '[open](javascript:alert(document.cookie))\n\n<script>alert(1)</script>\n\n**safe**',
    });
    mountedApps.push({ app, host });

    app.mount(host);
    await nextTick();

    expect(host.innerHTML).not.toMatch(/javascript:/i);
    expect(host.innerHTML).not.toMatch(/<script/i);
    expect(host.innerHTML).not.toMatch(/alert\(/i);
    expect(host.textContent).toContain('safe');
  });
});
