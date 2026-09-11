import { test, expect, type APIRequestContext } from '@playwright/test';

import { WORKER_URL } from '../../fixtures/test-helpers';

type TestUser = { jwt: string; userId: number };

async function createUser(request: APIRequestContext, prefix: string): Promise<TestUser> {
  const email = prefix + '-' + Date.now() + '@test.example.com';
  const password = prefix + '-password-123';

  const registerRes = await request.post(WORKER_URL + '/user_api/register', {
    data: { email, password },
  });
  expect(registerRes.ok()).toBe(true);

  const loginRes = await request.post(WORKER_URL + '/user_api/login', {
    data: { email, password },
  });
  expect(loginRes.ok()).toBe(true);
  const body = await loginRes.json() as { jwt: string };
  const payload = JSON.parse(Buffer.from(body.jwt.split('.')[1], 'base64url').toString('utf8'));
  return { jwt: body.jwt, userId: payload.user_id as number };
}

async function createExternalAccount(
  request: APIRequestContext,
  user: TestUser,
  username: string,
): Promise<string> {
  const res = await request.post(WORKER_URL + '/user_api/mail_accounts', {
    headers: { 'x-user-token': user.jwt },
    data: {
      source: 'imap_custom',
      host: 'mail.example.test',
      port: 993,
      username,
      cred: 'test-app-password',
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

test('deleting a user removes imported mail before the username is rebound', async ({ request }) => {
  const username = 'deleted-mail-' + Date.now() + '@external.test';
  let originalUserSettings: Record<string, unknown> | undefined;
  let userA: TestUser | undefined;
  let userB: TestUser | undefined;
  let localAddress: { jwt: string; address: string } | undefined;

  try {
    const settingsRes = await request.get(WORKER_URL + '/admin/user_settings');
    expect(settingsRes.ok()).toBe(true);
    originalUserSettings = await settingsRes.json() as Record<string, unknown>;

    const enableRes = await request.post(WORKER_URL + '/admin/user_settings', {
      data: {
        ...originalUserSettings,
        enable: true,
        enableMailVerify: false,
        // This test creates only a few resources; keep the non-admin quota finite.
        maxAddressCount: 100,
      },
    });
    expect(enableRes.ok()).toBe(true);

    userA = await createUser(request, 'lifecycle-a');

    // A local address row must never be reused as an external mailbox scope.
    const localAddressRes = await request.post(WORKER_URL + '/api/new_address', {
      data: { name: 'collision-' + Date.now(), domain: 'test.example.com' },
    });
    expect(localAddressRes.ok()).toBe(true);
    const localAddressBody = await localAddressRes.json() as { jwt: string; address: string };
    localAddress = localAddressBody;
    const collisionRes = await request.post(WORKER_URL + '/user_api/mail_accounts', {
      headers: { 'x-user-token': userA.jwt },
      data: {
        source: 'imap_custom',
        host: 'mail.example.test',
        port: 993,
        username: localAddress.address,
        cred: 'test-app-password',
        protocol: 'imap',
        folders: ['INBOX'],
        use_ssl: true,
      },
    });
    expect(collisionRes.status()).toBe(400);
    const collisionAccounts = await request.get(WORKER_URL + '/user_api/mail_accounts', {
      headers: { 'x-user-token': userA.jwt },
    });
    expect(collisionAccounts.ok()).toBe(true);
    expect((await collisionAccounts.json()).results).toHaveLength(0);

    const accountId = await createExternalAccount(request, userA, username);

    const ingestRes = await request.post(WORKER_URL + '/admin/unified/ingest', {
      data: {
        emails: [{
          source: 'imap_custom',
          account_id: accountId,
          from_addr: 'sender@external.test',
          to_addr: username,
          subject: 'deleted-user-secret',
          text_body: 'must not survive deletion',
          html_body: '<p>must not survive deletion</p>',
          received_at: Date.now(),
        }],
      },
    });
    expect(ingestRes.ok()).toBe(true);
    const ingestBody = await ingestRes.json() as { inserted: number };
    expect(ingestBody.inserted).toBe(1);

    const beforeRes = await request.get(WORKER_URL + '/api/unified/emails?limit=20&offset=0', {
      headers: { 'x-user-token': userA.jwt },
    });
    expect(beforeRes.ok()).toBe(true);
    const beforeBody = await beforeRes.json() as { count: number; results: unknown[] };
    expect(Number(beforeBody.count)).toBe(1);
    expect(beforeBody.results).toHaveLength(1);

    const revokedUserJwt = userA.jwt;
    const deleteARes = await request.delete(WORKER_URL + '/admin/users/' + userA.userId);
    expect(deleteARes.ok()).toBe(true);

    const revokedRes = await request.get(
      WORKER_URL + '/api/unified/emails?limit=20&offset=0',
      { headers: { 'x-user-token': revokedUserJwt } },
    );
    expect(revokedRes.status()).toBe(401);
    userA = undefined;

    userB = await createUser(request, 'lifecycle-b');
    await createExternalAccount(request, userB, username);

    const afterRes = await request.get(WORKER_URL + '/api/unified/emails?limit=20&offset=0', {
      headers: { 'x-user-token': userB.jwt },
    });
    expect(afterRes.ok()).toBe(true);
    const afterBody = await afterRes.json() as { count: number; results: unknown[] };
    expect(Number(afterBody.count)).toBe(0);
    expect(afterBody.results).toHaveLength(0);
  } finally {
    if (localAddress) {
      const cleanupAddressRes = await request.delete(WORKER_URL + '/api/delete_address', {
        headers: { Authorization: 'Bearer ' + localAddress.jwt },
      });
      expect([200, 404]).toContain(cleanupAddressRes.status());
    }
    for (const user of [userA, userB]) {
      if (!user) continue;
      const cleanupRes = await request.delete(WORKER_URL + '/admin/users/' + user.userId);
      expect([200, 404]).toContain(cleanupRes.status());
    }
    if (originalUserSettings) {
      const restoreRes = await request.post(WORKER_URL + '/admin/user_settings', {
        data: originalUserSettings,
      });
      expect(restoreRes.ok()).toBe(true);
    }
  }
});
