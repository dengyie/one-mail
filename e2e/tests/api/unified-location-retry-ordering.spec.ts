import { test, expect } from '@playwright/test';

import { WORKER_URL } from '../../fixtures/test-helpers';

const ADMIN_HEADERS = { 'x-admin-auth': 'e2e-admin-pass' };

const createAdminKey = async (request: any, suffix: string) => {
  const keyRes = await request.post(WORKER_URL + '/admin/unified/keys', {
    headers: ADMIN_HEADERS,
    data: { name: `location-retry-${suffix}`, role: 'admin' },
  });
  expect(keyRes.ok()).toBe(true);
  const { key } = await keyRes.json() as { key: string };
  return { Authorization: `Bearer ${key}` };
};

test('attempted move remains an ordering barrier when a newer delete exists', async ({ request }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const accountId = `location-retry-${suffix}`;
  const authHeaders = await createAdminKey(request, suffix);
  const originalSourceKey = `${accountId}:imap.example.test:INBOX:31:7`;
  const movedSourceKey = `${accountId}:imap.example.test:Archive:32:19`;

  const ingestRes = await request.post(WORKER_URL + '/admin/unified/ingest', {
    headers: ADMIN_HEADERS,
    data: {
      emails: [
        {
          source: 'imap_custom',
          provider: 'imap',
          account_id: accountId,
          from_addr: 'sender@external.test',
          to_addr: `${accountId}@example.test`,
          subject: `location retry source ${suffix}`,
          text_body: 'body',
          received_at: Date.now(),
          source_folder: 'INBOX',
          source_uidvalidity: 31,
          source_key: originalSourceKey,
          message_id_header: `<location-retry-${suffix}@example.test>`,
        },
        {
          source: 'imap_custom',
          provider: 'imap',
          account_id: accountId,
          from_addr: 'archive-seed@external.test',
          to_addr: `${accountId}@example.test`,
          subject: `archive seed ${suffix}`,
          text_body: 'seed',
          received_at: Date.now() - 1,
          source_folder: 'Archive',
          source_uidvalidity: 32,
          source_key: `${accountId}:imap.example.test:Archive:32:1`,
          message_id_header: `<archive-seed-${suffix}@example.test>`,
        },
      ],
    },
  });
  expect(ingestRes.ok()).toBe(true);

  const listRes = await request.get(
    WORKER_URL + `/api/unified/emails?account_id=${encodeURIComponent(accountId)}&limit=10`,
    { headers: authHeaders },
  );
  expect(listRes.ok()).toBe(true);
  const list = await listRes.json() as { results: Array<{ id: string; subject: string }> };
  const sourceEmail = list.results.find((row) => row.subject === `location retry source ${suffix}`);
  expect(sourceEmail).toBeTruthy();

  const foldersRes = await request.get(
    WORKER_URL + `/api/unified/folders?account_id=${encodeURIComponent(accountId)}`,
    { headers: authHeaders },
  );
  expect(foldersRes.ok()).toBe(true);
  const folders = await foldersRes.json() as { results: Array<{ id: number; canonical_name: string }> };
  const archive = folders.results.find((folder) => folder.canonical_name === 'Archive');
  expect(archive).toBeTruthy();

  const moveRes = await request.post(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(sourceEmail!.id)}/move`,
    { headers: authHeaders, data: { folder_id: archive!.id } },
  );
  expect(moveRes.status()).toBe(202);
  const moveJob = await moveRes.json() as { job_id: string };

  const firstLease = `location-first-${suffix}`;
  const firstClaimRes = await request.post(WORKER_URL + '/admin/unified/mutations/v2/claim', {
    headers: ADMIN_HEADERS,
    data: { lease_token: firstLease, limit: 50 },
  });
  expect(firstClaimRes.ok()).toBe(true);
  const firstClaim = await firstClaimRes.json() as {
    jobs: Array<{ id: string; attempts: number; source_folder: string; source_key: string }>;
  };
  expect(firstClaim.jobs.find((job) => job.id === moveJob.job_id)).toMatchObject({
    attempts: 1,
    source_folder: 'INBOX',
    source_key: originalSourceKey,
  });

  // The move has now crossed the provider side-effect boundary. Queueing a
  // delete must not supersede it: a timeout can mean the MOVE succeeded but only
  // its result report was lost, so recovery must finish before delete can lease.
  const deleteRes = await request.delete(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(sourceEmail!.id)}`,
    { headers: authHeaders },
  );
  expect(deleteRes.status()).toBe(202);
  const deleteJob = await deleteRes.json() as { job_id: string };

  const retryRes = await request.post(
    WORKER_URL + `/admin/unified/mutations/${encodeURIComponent(moveJob.job_id)}/result`,
    {
      headers: ADMIN_HEADERS,
      data: {
        lease_token: firstLease,
        status: 'retry',
        error: 'simulated provider timeout after unknown move outcome',
        retry_after_ms: 1000,
      },
    },
  );
  expect(retryRes.ok()).toBe(true);
  expect(await retryRes.json()).toMatchObject({ status: 'pending' });

  const moveStatusRes = await request.get(
    WORKER_URL + `/api/unified/mutations/${encodeURIComponent(moveJob.job_id)}`,
    { headers: authHeaders },
  );
  expect(moveStatusRes.ok()).toBe(true);
  expect(await moveStatusRes.json()).toMatchObject({ status: 'pending', attempts: 1 });

  const deleteStatusRes = await request.get(
    WORKER_URL + `/api/unified/mutations/${encodeURIComponent(deleteJob.job_id)}`,
    { headers: authHeaders },
  );
  expect(deleteStatusRes.ok()).toBe(true);
  expect(await deleteStatusRes.json()).toMatchObject({ status: 'pending', attempts: 0 });

  await new Promise((resolve) => setTimeout(resolve, 1100));

  const recoveryLease = `location-recovery-${suffix}`;
  const recoveryClaimRes = await request.post(WORKER_URL + '/admin/unified/mutations/v2/claim', {
    headers: ADMIN_HEADERS,
    data: { lease_token: recoveryLease, limit: 50 },
  });
  expect(recoveryClaimRes.ok()).toBe(true);
  const recoveryClaim = await recoveryClaimRes.json() as {
    jobs: Array<{ id: string; attempts: number; source_folder: string; source_key: string }>;
  };
  expect(recoveryClaim.jobs.find((job) => job.id === moveJob.job_id)).toMatchObject({
    attempts: 2,
    source_folder: 'INBOX',
    source_key: originalSourceKey,
  });
  expect(recoveryClaim.jobs.some((job) => job.id === deleteJob.job_id)).toBe(false);

  const moveSuccessRes = await request.post(
    WORKER_URL + `/admin/unified/mutations/${encodeURIComponent(moveJob.job_id)}/result`,
    {
      headers: ADMIN_HEADERS,
      data: {
        lease_token: recoveryLease,
        status: 'succeeded',
        projection: {
          source_folder: 'Archive',
          source_folder_id: null,
          source_key: movedSourceKey,
        },
      },
    },
  );
  expect(moveSuccessRes.ok()).toBe(true);

  const deleteLease = `location-delete-${suffix}`;
  const deleteClaimRes = await request.post(WORKER_URL + '/admin/unified/mutations/v2/claim', {
    headers: ADMIN_HEADERS,
    data: { lease_token: deleteLease, limit: 50 },
  });
  expect(deleteClaimRes.ok()).toBe(true);
  const deleteClaim = await deleteClaimRes.json() as {
    jobs: Array<{ id: string; attempts: number; source_folder: string; source_key: string }>;
  };
  expect(deleteClaim.jobs.find((job) => job.id === deleteJob.job_id)).toMatchObject({
    attempts: 1,
    source_folder: 'Archive',
    source_key: movedSourceKey,
  });

  const deleteSuccessRes = await request.post(
    WORKER_URL + `/admin/unified/mutations/${encodeURIComponent(deleteJob.job_id)}/result`,
    { headers: ADMIN_HEADERS, data: { lease_token: deleteLease, status: 'succeeded' } },
  );
  expect(deleteSuccessRes.ok()).toBe(true);
});
