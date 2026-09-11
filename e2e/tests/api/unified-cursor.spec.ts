import { test, expect } from '@playwright/test';

import { WORKER_URL } from '../../fixtures/test-helpers';

const ADMIN_HEADERS = { 'x-admin-auth': 'e2e-admin-pass' };

test('unified inbox cursor pagination is stable across concurrent inserts', async ({ request }) => {
  const suffix = Date.now().toString();
  const accountId = `cursor-${suffix}`;
  const base = Date.now() - 10_000;

  const keyRes = await request.post(WORKER_URL + '/admin/unified/keys', {
    headers: ADMIN_HEADERS,
    data: { name: `cursor-e2e-${suffix}`, role: 'admin' },
  });
  expect(keyRes.ok()).toBe(true);
  const keyBody = await keyRes.json() as { key: string };
  const authHeaders = { Authorization: `Bearer ${keyBody.key}` };

  const emails = [1, 2, 3, 4, 5].map((n) => ({
    source: 'imap_custom',
    provider: 'imap',
    account_id: accountId,
    from_addr: `sender-${n}@external.test`,
    to_addr: `cursor-${suffix}@example.test`,
    subject: `cursor-${n}`,
    text_body: `body-${n}`,
    received_at: base + n * 1000,
    source_folder: 'INBOX',
    source_key: `${accountId}:INBOX:${n}`,
  }));

  const ingestRes = await request.post(WORKER_URL + '/admin/unified/ingest', {
    headers: ADMIN_HEADERS,
    data: { emails },
  });
  expect(ingestRes.ok()).toBe(true);
  expect(await ingestRes.json()).toMatchObject({ inserted: 5, skipped: 0 });

  const firstRes = await request.get(
    WORKER_URL + `/api/unified/emails?account_id=${encodeURIComponent(accountId)}&limit=2`,
    { headers: authHeaders },
  );
  expect(firstRes.ok()).toBe(true);
  const first = await firstRes.json() as {
    count: number;
    results: Array<{ id: string; subject: string }>;
    next_cursor: string | null;
    has_more: boolean;
  };
  expect(first.count).toBe(5);
  expect(first.results.map((row) => row.subject)).toEqual(['cursor-5', 'cursor-4']);
  expect(first.has_more).toBe(true);
  expect(first.next_cursor).toBeTruthy();

  // A newer message arrives after page 1. Keyset page 2 must continue from the
  // old boundary rather than shifting like OFFSET pagination would.
  const concurrentRes = await request.post(WORKER_URL + '/admin/unified/ingest', {
    headers: ADMIN_HEADERS,
    data: {
      emails: [{
        source: 'imap_custom',
        provider: 'imap',
        account_id: accountId,
        from_addr: 'newer@external.test',
        to_addr: `cursor-${suffix}@example.test`,
        subject: 'cursor-newer',
        text_body: 'arrived after page one',
        received_at: base + 99_000,
        source_folder: 'INBOX',
        source_key: `${accountId}:INBOX:newer`,
      }],
    },
  });
  expect(concurrentRes.ok()).toBe(true);

  const secondRes = await request.get(
    WORKER_URL + `/api/unified/emails?account_id=${encodeURIComponent(accountId)}&limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`,
    { headers: authHeaders },
  );
  expect(secondRes.ok()).toBe(true);
  const second = await secondRes.json() as {
    count: number;
    results: Array<{ id: string; subject: string }>;
    next_cursor: string | null;
    has_more: boolean;
  };
  expect(second.count).toBe(0);
  expect(second.results.map((row) => row.subject)).toEqual(['cursor-3', 'cursor-2']);
  expect(second.has_more).toBe(true);
  expect(second.next_cursor).toBeTruthy();
  expect(new Set([...first.results, ...second.results].map((row) => row.id)).size).toBe(4);

  const thirdRes = await request.get(
    WORKER_URL + `/api/unified/emails?account_id=${encodeURIComponent(accountId)}&limit=2&cursor=${encodeURIComponent(second.next_cursor!)}`,
    { headers: authHeaders },
  );
  expect(thirdRes.ok()).toBe(true);
  const third = await thirdRes.json() as {
    count: number;
    results: Array<{ subject: string }>;
    next_cursor: string | null;
    has_more: boolean;
  };
  expect(third.count).toBe(0);
  expect(third.results.map((row) => row.subject)).toEqual(['cursor-1']);
  expect(third.has_more).toBe(false);
  expect(third.next_cursor).toBeNull();

  const legacyRes = await request.get(
    WORKER_URL + `/api/unified/emails?account_id=${encodeURIComponent(accountId)}&limit=2&offset=0`,
    { headers: authHeaders },
  );
  expect(legacyRes.ok()).toBe(true);
  const legacy = await legacyRes.json() as {
    count: number;
    results: Array<{ subject: string }>;
    next_cursor?: string;
  };
  expect(legacy.count).toBe(6);
  expect(legacy.results.map((row) => row.subject)).toEqual(['cursor-newer', 'cursor-5']);
  expect(legacy.next_cursor).toBeUndefined();

  const invalidRes = await request.get(
    WORKER_URL + `/api/unified/emails?account_id=${encodeURIComponent(accountId)}&limit=2&cursor=not-a-valid-cursor`,
    { headers: authHeaders },
  );
  expect(invalidRes.status()).toBe(400);

  const ambiguousRes = await request.get(
    WORKER_URL + `/api/unified/emails?account_id=${encodeURIComponent(accountId)}&limit=2&offset=0&cursor=${encodeURIComponent(first.next_cursor!)}`,
    { headers: authHeaders },
  );
  expect(ambiguousRes.status()).toBe(400);
});
