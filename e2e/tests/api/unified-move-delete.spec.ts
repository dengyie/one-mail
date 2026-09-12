import { test, expect } from '@playwright/test';

import { WORKER_URL } from '../../fixtures/test-helpers';

const ADMIN_HEADERS = { 'x-admin-auth': 'e2e-admin-pass' };

const createAdminKey = async (request: any, suffix: string) => {
  const keyRes = await request.post(WORKER_URL + '/admin/unified/keys', {
    headers: ADMIN_HEADERS,
    data: { name: `move-delete-${suffix}`, role: 'admin' },
  });
  expect(keyRes.ok()).toBe(true);
  const { key } = await keyRes.json() as { key: string };
  return { Authorization: `Bearer ${key}` };
};

test('move rewrites provider identity before later jobs and delete keeps terminal status readable', async ({ request }) => {
  const suffix = Date.now().toString();
  const accountId = `move-${suffix}`;
  const otherAccountId = `other-${suffix}`;
  const authHeaders = await createAdminKey(request, suffix);
  const sourceMessageId = `<move-${suffix}@example.test>`;

  const ingestRes = await request.post(WORKER_URL + '/admin/unified/ingest', {
    headers: ADMIN_HEADERS,
    data: {
      emails: [
        {
          source: 'imap_custom',
          provider: 'imap',
          account_id: accountId,
          from_addr: 'sender@external.test',
          to_addr: `move-${suffix}@example.test`,
          subject: 'move source target',
          text_body: 'body',
          received_at: Date.now(),
          source_folder: 'INBOX',
          source_uidvalidity: 7,
          source_key: `${accountId}:imap.example.test:INBOX:7:42`,
          message_id_header: sourceMessageId,
        },
        {
          source: 'imap_custom',
          provider: 'imap',
          account_id: accountId,
          from_addr: 'archive-seed@external.test',
          to_addr: `move-${suffix}@example.test`,
          subject: 'archive folder seed',
          text_body: 'seed',
          received_at: Date.now() - 1,
          source_folder: 'Archive',
          source_uidvalidity: 9,
          source_key: `${accountId}:imap.example.test:Archive:9:1`,
          message_id_header: `<archive-seed-${suffix}@example.test>`,
        },
        {
          source: 'imap_custom',
          provider: 'imap',
          account_id: otherAccountId,
          from_addr: 'other@external.test',
          to_addr: `other-${suffix}@example.test`,
          subject: 'other archive seed',
          text_body: 'seed',
          received_at: Date.now() - 2,
          source_folder: 'Archive',
          source_uidvalidity: 3,
          source_key: `${otherAccountId}:imap.example.test:Archive:3:1`,
          message_id_header: `<other-seed-${suffix}@example.test>`,
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
  const sourceEmail = list.results.find((row) => row.subject === 'move source target');
  expect(sourceEmail).toBeTruthy();
  const emailId = sourceEmail!.id;

  const foldersRes = await request.get(
    WORKER_URL + `/api/unified/folders?account_id=${encodeURIComponent(accountId)}`,
    { headers: authHeaders },
  );
  expect(foldersRes.ok()).toBe(true);
  const folders = await foldersRes.json() as {
    results: Array<{ id: number; account_id: string; canonical_name: string; provider: string }>;
  };
  const archive = folders.results.find((folder) => folder.canonical_name === 'Archive');
  expect(archive).toMatchObject({ account_id: accountId, provider: 'imap' });

  const otherFoldersRes = await request.get(
    WORKER_URL + `/api/unified/folders?account_id=${encodeURIComponent(otherAccountId)}`,
    { headers: authHeaders },
  );
  expect(otherFoldersRes.ok()).toBe(true);
  const otherArchive = (await otherFoldersRes.json() as {
    results: Array<{ id: number; canonical_name: string }>;
  }).results.find((folder) => folder.canonical_name === 'Archive');
  expect(otherArchive).toBeTruthy();

  const crossAccountMove = await request.post(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}/move`,
    { headers: authHeaders, data: { folder_id: otherArchive!.id } },
  );
  expect(crossAccountMove.status()).toBe(400);
  expect(await crossAccountMove.json()).toMatchObject({ error: 'target folder not found for this mail account' });

  const moveRes = await request.post(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}/move`,
    { headers: authHeaders, data: { folder_id: archive!.id } },
  );
  expect(moveRes.status()).toBe(202);
  const moveJob = await moveRes.json() as { job_id: string; operation: string; status: string };
  expect(moveJob).toMatchObject({ operation: 'move', status: 'queued' });

  // Queue a later state mutation before move is acknowledged. The claim API
  // must lease only move for this email; otherwise star would use stale INBOX UID.
  const starRes = await request.post(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}/star`,
    { headers: authHeaders, data: { is_starred: 1 } },
  );
  expect(starRes.status()).toBe(202);
  const starJob = await starRes.json() as { job_id: string };

  const moveLease = `move-lease-${suffix}`;
  const moveClaimRes = await request.post(WORKER_URL + '/admin/unified/mutations/claim', {
    headers: ADMIN_HEADERS,
    data: { lease_token: moveLease, limit: 50 },
  });
  expect(moveClaimRes.ok()).toBe(true);
  const moveClaim = await moveClaimRes.json() as {
    jobs: Array<{
      id: string;
      email_id: string;
      operation: string;
      source_folder: string;
      target_folder: string;
      source_key: string;
      message_id_header: string;
    }>;
  };
  const ourFirstClaims = moveClaim.jobs.filter((job) => job.id === moveJob.job_id || job.id === starJob.job_id);
  expect(ourFirstClaims).toHaveLength(1);
  expect(ourFirstClaims[0]).toMatchObject({
    id: moveJob.job_id,
    email_id: emailId,
    operation: 'move',
    source_folder: 'INBOX',
    target_folder: 'Archive',
    source_key: `${accountId}:imap.example.test:INBOX:7:42`,
    message_id_header: sourceMessageId,
  });

  const movedSourceKey = `${accountId}:imap.example.test:Archive:9:84`;
  const moveResultRes = await request.post(
    WORKER_URL + `/admin/unified/mutations/${encodeURIComponent(moveJob.job_id)}/result`,
    {
      headers: ADMIN_HEADERS,
      data: {
        lease_token: moveLease,
        status: 'succeeded',
        projection: {
          source_folder: 'Archive',
          source_folder_id: null,
          source_key: movedSourceKey,
        },
      },
    },
  );
  expect(moveResultRes.ok()).toBe(true);
  expect(await moveResultRes.json()).toMatchObject({ status: 'succeeded', source_folder: 'Archive' });

  const movedEmailRes = await request.get(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}`,
    { headers: authHeaders },
  );
  expect(movedEmailRes.ok()).toBe(true);
  expect(await movedEmailRes.json()).toMatchObject({
    source_folder: 'Archive',
    source_key: movedSourceKey,
    imap_uid: movedSourceKey,
  });

  const starLease = `post-move-star-${suffix}`;
  const starClaimRes = await request.post(WORKER_URL + '/admin/unified/mutations/claim', {
    headers: ADMIN_HEADERS,
    data: { lease_token: starLease, limit: 50 },
  });
  expect(starClaimRes.ok()).toBe(true);
  const starClaim = await starClaimRes.json() as {
    jobs: Array<{ id: string; source_folder: string; source_key: string }>;
  };
  const claimedStar = starClaim.jobs.find((job) => job.id === starJob.job_id);
  expect(claimedStar).toMatchObject({ source_folder: 'Archive', source_key: movedSourceKey });

  const starResultRes = await request.post(
    WORKER_URL + `/admin/unified/mutations/${encodeURIComponent(starJob.job_id)}/result`,
    { headers: ADMIN_HEADERS, data: { lease_token: starLease, status: 'succeeded' } },
  );
  expect(starResultRes.ok()).toBe(true);

  const deleteRes = await request.delete(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}`,
    { headers: authHeaders },
  );
  expect(deleteRes.status()).toBe(202);
  const deleteJob = await deleteRes.json() as { job_id: string; operation: string };
  expect(deleteJob.operation).toBe('delete');

  const deleteLease = `delete-lease-${suffix}`;
  const deleteClaimRes = await request.post(WORKER_URL + '/admin/unified/mutations/claim', {
    headers: ADMIN_HEADERS,
    data: { lease_token: deleteLease, limit: 50 },
  });
  expect(deleteClaimRes.ok()).toBe(true);
  const deleteClaim = await deleteClaimRes.json() as {
    jobs: Array<{ id: string; source_folder: string; source_key: string }>;
  };
  expect(deleteClaim.jobs.find((job) => job.id === deleteJob.job_id)).toMatchObject({
    source_folder: 'Archive',
    source_key: movedSourceKey,
  });

  const deleteResultRes = await request.post(
    WORKER_URL + `/admin/unified/mutations/${encodeURIComponent(deleteJob.job_id)}/result`,
    { headers: ADMIN_HEADERS, data: { lease_token: deleteLease, status: 'succeeded' } },
  );
  expect(deleteResultRes.ok()).toBe(true);
  expect(await deleteResultRes.json()).toMatchObject({ ok: true, status: 'succeeded', deleted: true });

  const deletedEmailRes = await request.get(
    WORKER_URL + `/api/unified/emails/${encodeURIComponent(emailId)}`,
    { headers: authHeaders },
  );
  expect(deletedEmailRes.status()).toBe(404);

  // The email row is intentionally gone, but terminal mutation status remains
  // authorized via the immutable account/source snapshot stored on the job.
  const deleteStatusRes = await request.get(
    WORKER_URL + `/api/unified/mutations/${encodeURIComponent(deleteJob.job_id)}`,
    { headers: authHeaders },
  );
  expect(deleteStatusRes.ok()).toBe(true);
  expect(await deleteStatusRes.json()).toMatchObject({
    email_id: emailId,
    operation: 'delete',
    status: 'succeeded',
  });
});