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

  it('returns an empty URL when object URL APIs are unavailable', () => {
    vi.stubGlobal('URL', {});
    expect(getDownloadEmlUrl('raw eml')).toBe('');
  });
});
