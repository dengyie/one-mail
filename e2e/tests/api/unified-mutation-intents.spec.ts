import { test, expect } from '@playwright/test';

import { WORKER_URL } from '../../fixtures/test-helpers';

const ADMIN_HEADERS = { 'x-admin-auth': 'e2e-admin-pass' };

test('newest pending desired-state mutation supersedes older intent deterministically', async ({ request }) => {
  const suffix = Date.now().toString();
  const accountId = `mutation-intent-${suffix}`;

  const keyRes = await request.post(WORKER_URL + '/admin/unified/keys', {
    headers: ADMIN_HEADERS,
    data: { name: `mutation-intent-${suffix}`, role: 'admin' },
  });
  expect(keyRes.ok()).toBe(true);
  const { key } = await keyRes.json() as { key: string };
  const authHeaders = { Authorization: `Bearer ${key}` };

  const ingestRes = await request.post(WORKER_URL + '/admin/unified/ingest', {
    headers: ADMIN_HEADERS,
    data: {
      emails: [{
        source: 'imap_custom',
        provider: 'imap',
        account_id: accountId,
        from_addr: 'sender@external.test',
        to_addr: `intent-${suffix}@example.test`,
        subject: 'intent ordering target',
        text_body: 'body',
        received_at: Date.now(),
        source_folder: 'INBOX',
        source_key: `${accountId}:imap.example.test:INBOX:11:99`,
      }],
    },
  });
  expect(ingestRes.ok()).toBe(true);

  const listRes = await request.get(
    WORKER_URL + `/api/unified/emails?account_id=${encodeURIComponent(accountId)}&limit=10`,
    { headers: authHeaders },
  );
  expect(listRes.ok()).toBe(true);
  const emailId = (await listRes.json() as { results: Array<{ id: string }> }).results[0].id;

  // Queue opposite desired states before the aggregator claims either one.
  const firstRes = await request.post(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}/star`,
    { headers: authHeaders, data: { is_starred: 0 } },
  );
  const secondRes = await request.post(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}/star`,
    { headers: authHeaders, data: { is_starred: 1 } },
  );
  expect(firstRes.status()).toBe(202);
  expect(secondRes.status()).toBe(202);
  const first = await firstRes.json() as { job_id: string };
  const second = await secondRes.json() as { job_id: string };
  expect(first.job_id).not.toBe(second.job_id);

  const firstStatusRes = await request.get(
    WORKER_URL + `/api/unified/mutations/${encodeURIComponent(first.job_id)}`,
    { headers: authHeaders },
  );
  expect(firstStatusRes.ok()).toBe(true);
  expect(await firstStatusRes.json()).toMatchObject({ status: 'superseded', desired_value: 0 });

  const secondStatusRes = await request.get(
    WORKER_URL + `/api/unified/mutations/${encodeURIComponent(second.job_id)}`,
    { headers: authHeaders },
  );
  expect(secondStatusRes.ok()).toBe(true);
  expect(await secondStatusRes.json()).toMatchObject({ status: 'pending', desired_value: 1 });

  const lease = `intent-lease-${suffix}`;
  const claimRes = await request.post(WORKER_URL + '/admin/unified/mutations/claim', {
    headers: ADMIN_HEADERS,
    data: { lease_token: lease, limit: 20 },
  });
  expect(claimRes.ok()).toBe(true);
  const claim = await claimRes.json() as { jobs: Array<{ id: string; desired_value: number }> };
  const matching = claim.jobs.filter((job) => job.id === first.job_id || job.id === second.job_id);
  expect(matching).toEqual([{ id: second.job_id, desired_value: 1 }]);

  const resultRes = await request.post(
    WORKER_URL + `/admin/unified/mutations/${encodeURIComponent(second.job_id)}/result`,
    { headers: ADMIN_HEADERS, data: { lease_token: lease, status: 'succeeded' } },
  );
  expect(resultRes.ok()).toBe(true);

  const emailRes = await request.get(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}`,
    { headers: authHeaders },
  );
  expect(emailRes.ok()).toBe(true);
  expect((await emailRes.json() as { is_starred: number }).is_starred).toBe(1);
});
