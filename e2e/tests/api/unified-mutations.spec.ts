import { test, expect } from '@playwright/test';

import { WORKER_URL } from '../../fixtures/test-helpers';

const ADMIN_HEADERS = { 'x-admin-auth': 'e2e-admin-pass' };

test('external unified mutations stay queued until leased provider success', async ({ request }) => {
  const suffix = Date.now().toString();
  const accountId = `mutation-${suffix}`;

  const keyRes = await request.post(WORKER_URL + '/admin/unified/keys', {
    headers: ADMIN_HEADERS,
    data: { name: `mutation-e2e-${suffix}`, role: 'admin' },
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
        to_addr: `mutation-${suffix}@example.test`,
        subject: 'provider mutation target',
        text_body: 'body',
        received_at: Date.now(),
        source_folder: 'INBOX',
        source_key: `${accountId}:imap.example.test:INBOX:7:42`,
      }],
    },
  });
  expect(ingestRes.ok()).toBe(true);

  const listRes = await request.get(
    WORKER_URL + `/api/unified/emails?account_id=${encodeURIComponent(accountId)}&limit=10`,
    { headers: authHeaders },
  );
  expect(listRes.ok()).toBe(true);
  const list = await listRes.json() as { results: Array<{ id: string; is_read: number; is_starred: number }> };
  expect(list.results).toHaveLength(1);
  const emailId = list.results[0].id;
  expect(list.results[0].is_read).toBe(0);
  expect(list.results[0].is_starred).toBe(0);

  const readRes = await request.post(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}/read`,
    { headers: authHeaders },
  );
  expect(readRes.status()).toBe(202);
  const readJob = await readRes.json() as { job_id: string; status: string; desired_value: number };
  expect(readJob).toMatchObject({ status: 'queued', desired_value: 1 });
  expect(readJob.job_id).toBeTruthy();

  // Local projection must not move before the provider worker acknowledges it.
  const beforeRes = await request.get(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}`,
    { headers: authHeaders },
  );
  expect(beforeRes.ok()).toBe(true);
  expect((await beforeRes.json() as { is_read: number }).is_read).toBe(0);

  const leaseToken = `lease-${suffix}`;
  const claimRes = await request.post(WORKER_URL + '/admin/unified/mutations/claim', {
    headers: ADMIN_HEADERS,
    data: { lease_token: leaseToken, limit: 10 },
  });
  expect(claimRes.ok()).toBe(true);
  const claim = await claimRes.json() as {
    jobs: Array<{ id: string; email_id: string; account_id: string; operation: string; desired_value: number; source_key: string }>;
  };
  const claimedRead = claim.jobs.find((job) => job.id === readJob.job_id);
  expect(claimedRead).toMatchObject({
    email_id: emailId,
    account_id: accountId,
    operation: 'set_read',
    desired_value: 1,
    source_key: `${accountId}:imap.example.test:INBOX:7:42`,
  });

  const staleResult = await request.post(
    WORKER_URL + `/admin/unified/mutations/${encodeURIComponent(readJob.job_id)}/result`,
    { headers: ADMIN_HEADERS, data: { lease_token: 'wrong-lease', status: 'succeeded' } },
  );
  expect(staleResult.status()).toBe(409);

  const resultRes = await request.post(
    WORKER_URL + `/admin/unified/mutations/${encodeURIComponent(readJob.job_id)}/result`,
    { headers: ADMIN_HEADERS, data: { lease_token: leaseToken, status: 'succeeded' } },
  );
  expect(resultRes.ok()).toBe(true);
  expect(await resultRes.json()).toMatchObject({ ok: true, status: 'succeeded' });

  const statusRes = await request.get(
    WORKER_URL + `/api/unified/mutations/${encodeURIComponent(readJob.job_id)}`,
    { headers: authHeaders },
  );
  expect(statusRes.ok()).toBe(true);
  expect(await statusRes.json()).toMatchObject({
    email_id: emailId,
    operation: 'set_read',
    desired_value: 1,
    status: 'succeeded',
  });

  const afterReadRes = await request.get(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}`,
    { headers: authHeaders },
  );
  expect(afterReadRes.ok()).toBe(true);
  expect((await afterReadRes.json() as { is_read: number }).is_read).toBe(1);

  const starRes = await request.post(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}/star`,
    { headers: authHeaders, data: { is_starred: 1 } },
  );
  expect(starRes.status()).toBe(202);
  const starJob = await starRes.json() as { job_id: string; desired_value: number };
  expect(starJob.desired_value).toBe(1);

  const starLease = `star-lease-${suffix}`;
  const starClaimRes = await request.post(WORKER_URL + '/admin/unified/mutations/claim', {
    headers: ADMIN_HEADERS,
    data: { lease_token: starLease, limit: 10 },
  });
  expect(starClaimRes.ok()).toBe(true);
  const starClaim = await starClaimRes.json() as { jobs: Array<{ id: string }> };
  expect(starClaim.jobs.some((job) => job.id === starJob.job_id)).toBe(true);

  const starResultRes = await request.post(
    WORKER_URL + `/admin/unified/mutations/${encodeURIComponent(starJob.job_id)}/result`,
    { headers: ADMIN_HEADERS, data: { lease_token: starLease, status: 'succeeded' } },
  );
  expect(starResultRes.ok()).toBe(true);

  const afterStarRes = await request.get(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}`,
    { headers: authHeaders },
  );
  expect(afterStarRes.ok()).toBe(true);
  expect((await afterStarRes.json() as { is_starred: number }).is_starred).toBe(1);
});

test('POP3 mutation fails explicitly instead of reporting local success', async ({ request }) => {
  const suffix = Date.now().toString();
  const accountId = `pop3-mutation-${suffix}`;
  const keyRes = await request.post(WORKER_URL + '/admin/unified/keys', {
    headers: ADMIN_HEADERS,
    data: { name: `pop3-mutation-${suffix}`, role: 'admin' },
  });
  expect(keyRes.ok()).toBe(true);
  const { key } = await keyRes.json() as { key: string };

  const ingestRes = await request.post(WORKER_URL + '/admin/unified/ingest', {
    headers: ADMIN_HEADERS,
    data: {
      emails: [{
        source: 'pop3_custom',
        provider: 'pop3',
        account_id: accountId,
        from_addr: 'sender@external.test',
        to_addr: `pop3-${suffix}@example.test`,
        subject: 'pop3 target',
        text_body: 'body',
        received_at: Date.now(),
        source_folder: 'INBOX',
        source_key: `pop3:${accountId}:INBOX:uidl-1`,
      }],
    },
  });
  expect(ingestRes.ok()).toBe(true);

  const listRes = await request.get(
    WORKER_URL + `/api/unified/emails?account_id=${encodeURIComponent(accountId)}&limit=10`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  expect(listRes.ok()).toBe(true);
  const emailId = (await listRes.json() as { results: Array<{ id: string }> }).results[0].id;

  const mutationRes = await request.post(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}/read`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  expect(mutationRes.status()).toBe(409);
  expect(await mutationRes.json()).toMatchObject({
    status: 'unsupported',
    code: 'provider_write_unsupported',
    provider: 'pop3',
  });
});
