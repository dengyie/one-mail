import { test, expect, type APIRequestContext } from '@playwright/test';

import { WORKER_URL } from '../../fixtures/test-helpers';

const ADMIN_HEADERS = { 'x-admin-auth': 'e2e-admin-pass' };

type TestUser = { jwt: string; userId: number };

async function enableUserRegistration(request: APIRequestContext): Promise<void> {
  const res = await request.get(WORKER_URL + '/admin/user_settings', { headers: ADMIN_HEADERS });
  expect(res.ok()).toBe(true);
  const current = await res.json() as Record<string, unknown>;
  const save = await request.post(WORKER_URL + '/admin/user_settings', {
    headers: ADMIN_HEADERS,
    data: { ...current, enable: true, enableMailVerify: false, maxAddressCount: 100 },
  });
  expect(save.ok()).toBe(true);
}

async function createUser(request: APIRequestContext, prefix: string): Promise<TestUser> {
  const email = `${prefix}-${Date.now()}@test.example.com`;
  const password = `${prefix}-password-123`;
  const register = await request.post(WORKER_URL + '/user_api/register', { data: { email, password } });
  expect(register.ok()).toBe(true);
  const login = await request.post(WORKER_URL + '/user_api/login', { data: { email, password } });
  expect(login.ok()).toBe(true);
  const { jwt } = await login.json() as { jwt: string };
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  return { jwt, userId: payload.user_id as number };
}

async function createAccount(
  request: APIRequestContext,
  user: TestUser,
  source: 'imap_gmail' | 'imap_qq',
  username: string,
): Promise<string> {
  const preset = source === 'imap_gmail'
    ? { host: 'imap.gmail.com', port: 993 }
    : { host: 'imap.qq.com', port: 993 };
  const res = await request.post(WORKER_URL + '/user_api/mail_accounts', {
    headers: { 'x-user-token': user.jwt },
    data: {
      source,
      host: preset.host,
      port: preset.port,
      username,
      cred: 'e2e-app-password',
      protocol: 'imap',
      folders: ['INBOX'],
      use_ssl: true,
    },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json() as { id: string };
  expect(body.id).toBeTruthy();
  return body.id;
}

async function setCanSend(request: APIRequestContext, accountId: string, canSend: boolean): Promise<void> {
  const res = await request.post(
    WORKER_URL + `/admin/unified/mail_accounts/${encodeURIComponent(accountId)}/can_send`,
    { headers: ADMIN_HEADERS, data: { can_send: canSend } },
  );
  expect(res.ok()).toBe(true);
}

/** Ingest one mail row and return the id the unified table stores for it. */
async function ingestMail(
  request: APIRequestContext,
  row: {
    accountId: string;
    source: 'imap_gmail' | 'imap_qq';
    from: string;
    to: string;
    subject: string;
    providerThreadId?: string;
    messageIdHeader?: string;
  },
): Promise<string> {
  const emailId = `e2e-mail-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const res = await request.post(WORKER_URL + '/admin/unified/ingest', {
    headers: ADMIN_HEADERS,
    data: {
      emails: [{
        id: emailId,
        source: row.source,
        provider: 'imap',
        account_id: row.accountId,
        from_addr: row.from,
        to_addr: row.to,
        subject: row.subject,
        text_body: 'body',
        received_at: Date.now(),
        source_folder: 'INBOX',
        source_key: `${row.accountId}:imap:INBOX:${emailId}`,
        ...(row.providerThreadId ? { provider_thread_id: row.providerThreadId } : {}),
        ...(row.messageIdHeader ? { message_id_header: row.messageIdHeader } : {}),
      }],
    },
  });
  expect(res.ok()).toBe(true);
  const ingested = await res.json() as { inserted: number };
  expect(ingested.inserted).toBe(1);
  return emailId;
}

function replyBody(replyToEmailId: string, subject: string, overrides: Record<string, unknown> = {}) {
  return {
    reply_to_email_id: replyToEmailId,
    to_mail: 'reply-target@test.example.com',
    to_name: 'Reply Target',
    subject,
    content: 'Replied from a program caller.',
    is_html: false,
    from_name: 'Program Caller',
    references: ['<list-1@mail.example.test>'],
    ...overrides,
  };
}

type ClaimedJob = {
  id: string;
  account_id: string;
  from_addr: string;
  provider: string;
  payload_json: string;
};

async function claimJobs(request: APIRequestContext): Promise<ClaimedJob[]> {
  const res = await request.post(WORKER_URL + '/admin/unified/outbound/claim', {
    headers: ADMIN_HEADERS,
    data: { lease_token: 'admin-gmail-reply-e2e', limit: 50 },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json() as { jobs: ClaimedJob[] };
  return body.jobs;
}

test('admin gmail reply routes as the original mail account and validates inputs', async ({ request }) => {
  await enableUserRegistration(request);
  const user = await createUser(request, 'admin-gmail-reply');
  const stamp = Date.now();
  const gmailAddress = `admin-gmail-reply-${stamp}@gmail.com`;
  const gmailAccountId = await createAccount(request, user, 'imap_gmail', gmailAddress);
  await setCanSend(request, gmailAccountId, true);

  const originalSubject = `Original ${stamp}`;
  const threadId = 'a1b2c3';
  const messageIdHeader = `<${stamp}@mail.gmail.com>`;
  const gmailEmailId = await ingestMail(request, {
    accountId: gmailAccountId,
    source: 'imap_gmail',
    from: 'someone@example.test',
    to: gmailAddress,
    subject: originalSubject,
    providerThreadId: threadId,
    messageIdHeader,
  });

  // A program caller may send account_id/from, but the account comes from the
  // original row. Both spoofed values must be ignored.
  const body = replyBody(gmailEmailId, `Re: ${originalSubject}`, {
    account_id: 'spoofed-account',
    from: 'spoofed@example.test',
  });
  const idempotencyKey = `admin-gmail-reply-${stamp}`;
  const send = await request.post(WORKER_URL + '/admin/send_mail/gmail_reply', {
    headers: { ...ADMIN_HEADERS, 'x-idempotency-key': idempotencyKey },
    data: body,
  });
  expect(send.ok()).toBe(true);
  const queued = await send.json() as { status: string; job_id: string };
  expect(queued.status).toBe('queued');
  expect(queued.job_id).toBeTruthy();

  const jobs = await claimJobs(request);
  const job = jobs.find((entry) => entry.id === queued.job_id);
  expect(job).toBeTruthy();
  expect(job!.account_id).toBe(gmailAccountId);
  expect(job!.from_addr).toBe(gmailAddress);
  expect(job!.provider).toBe('imap_gmail');
  const payload = JSON.parse(job!.payload_json) as Record<string, unknown>;
  expect(payload.from_addr).toBe(gmailAddress);
  expect(payload.provider_thread_id).toBe(threadId);
  expect(payload.in_reply_to).toBe(messageIdHeader);
  expect(payload.references).toEqual(['<list-1@mail.example.test>']);
  expect(payload.reply_to_email_id).toBe(gmailEmailId);

  // Same key + same body replays the queued job; a changed body conflicts.
  const replay = await request.post(WORKER_URL + '/admin/send_mail/gmail_reply', {
    headers: { ...ADMIN_HEADERS, 'x-idempotency-key': idempotencyKey },
    data: body,
  });
  expect(replay.ok()).toBe(true);
  expect((await replay.json() as { job_id: string }).job_id).toBe(queued.job_id);

  const conflict = await request.post(WORKER_URL + '/admin/send_mail/gmail_reply', {
    headers: { ...ADMIN_HEADERS, 'x-idempotency-key': idempotencyKey },
    data: { ...body, subject: `Re: ${originalSubject} (different)` },
  });
  expect(conflict.status()).toBe(409);

  // A non-Gmail original is not rerouted.
  const qqAddress = `admin-qq-${stamp}@qq.com`;
  const qqAccountId = await createAccount(request, user, 'imap_qq', qqAddress);
  const qqEmailId = await ingestMail(request, {
    accountId: qqAccountId,
    source: 'imap_qq',
    from: 'someone@example.test',
    to: qqAddress,
    subject: `QQ original ${stamp}`,
  });
  const nonGmail = await request.post(WORKER_URL + '/admin/send_mail/gmail_reply', {
    headers: ADMIN_HEADERS,
    data: replyBody(qqEmailId, 'Re: QQ original'),
  });
  expect(nonGmail.status()).toBe(400);

  // A disabled send switch refuses the reply instead of falling back.
  await setCanSend(request, gmailAccountId, false);
  const disabled = await request.post(WORKER_URL + '/admin/send_mail/gmail_reply', {
    headers: ADMIN_HEADERS,
    data: replyBody(gmailEmailId, `Re: ${originalSubject} disabled`),
  });
  expect(disabled.status()).toBe(403);
  await setCanSend(request, gmailAccountId, true);

  // The shared send block list still applies before routing.
  const settingsRes = await request.get(WORKER_URL + '/admin/account_settings', { headers: ADMIN_HEADERS });
  expect(settingsRes.ok()).toBe(true);
  const settings = await settingsRes.json() as Record<string, unknown>;
  const blockList = Array.isArray(settings.sendBlockList) ? settings.sendBlockList as string[] : [];
  const blockedRecipient = 'blocked-recipient@example.test';
  const saveSettings = await request.post(WORKER_URL + '/admin/account_settings', {
    headers: ADMIN_HEADERS,
    data: { ...settings, sendBlockList: [...blockList, blockedRecipient] },
  });
  expect(saveSettings.ok()).toBe(true);
  try {
    const blocked = await request.post(WORKER_URL + '/admin/send_mail/gmail_reply', {
      headers: ADMIN_HEADERS,
      data: replyBody(gmailEmailId, `Re: ${originalSubject} blocked`, { to_mail: blockedRecipient }),
    });
    expect(blocked.status()).toBe(400);
  } finally {
    const restore = await request.post(WORKER_URL + '/admin/account_settings', {
      headers: ADMIN_HEADERS,
      data: { ...settings, sendBlockList: blockList },
    });
    expect(restore.ok()).toBe(true);
  }

  for (const accountId of [gmailAccountId, qqAccountId]) {
    const cleanup = await request.delete(
      WORKER_URL + `/user_api/mail_accounts/${encodeURIComponent(accountId)}`,
      { headers: { 'x-user-token': user.jwt } },
    );
    expect(cleanup.ok()).toBe(true);
  }
});
