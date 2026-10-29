// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getDownloadEmlUrl, revokeProcessedItemUrls } from '../email-parser';

describe('email parser object URL lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('revokes only generated blob attachment URLs and clears the item', () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { revokeObjectURL });
    const item = {
      attachments: [
        { url: 'blob:https://mail.example/attachment-1' },
        { url: 'https://cdn.example/attachment-2' },
        { url: null },
      ],
    };

    revokeProcessedItemUrls(item);

    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://mail.example/attachment-1');
    expect(item.attachments).toEqual([]);
  });

  it('fills Message-ID from PostalMime without replacing a wasm body', async () => {
    vi.resetModules();
    vi.stubGlobal('Blob', class Blob {});
    const RealURL = globalThis.URL;
    vi.stubGlobal('URL', class extends RealURL {
      static createObjectURL() { return 'blob:wasm'; }
      static revokeObjectURL() {}
    });
    vi.doMock('mail-parser-wasm', () => ({
      parse_message: () => ({
        sender: 'Ada <ada@example.com>',
        subject: 'wasm subject',
        body_html: '<p>wasm body</p>',
        text: 'wasm text',
        attachments: [],
      }),
    }));
    vi.doMock('postal-mime', () => ({
      default: {
        parse: async () => ({
          messageId: '<parent@example.com>',
          inReplyTo: '<root@example.com>',
          references: '<root@example.com>',
          from: { address: 'other@example.com', name: 'Other' },
          subject: 'postal subject',
          html: '<p>postal body</p>',
          text: 'postal text',
          attachments: [],
        }),
      },
    }));
    const { processItem: parseWithMocks } = await import('../email-parser');
    const item = await parseWithMocks({ raw: 'raw-bytes', source: 'inbox' });
    expect(item.subject).toBe('wasm subject');
    expect(item.message).toBe('<p>wasm body</p>');
    expect(item.messageId).toBe('<parent@example.com>');
    expect(item.inReplyTo).toBe('<root@example.com>');
    vi.doUnmock('mail-parser-wasm');
    vi.doUnmock('postal-mime');
  });

  it('returns an empty URL when object URL APIs are unavailable', () => {
    vi.stubGlobal('URL', {});
    expect(getDownloadEmlUrl('raw eml')).toBe('');
  });
});
