import { test, expect } from '@playwright/test';
import { WORKER_URL, createTestAddress, deleteAddress } from '../../fixtures/test-helpers';

const ADMIN_HEADERS = { 'x-admin-auth': 'e2e-admin-pass' };

/**
 * raw_mails.address 大小写契约（PR #181）端到端回归。
 *
 * 契约：email() 入口把收件人归一成规范小写落库（raw_mails.address / emails.to_addr
 * / 设置键共用），读侧（/user_api/mails 的 JOIN rm.address = a.name 两侧均为
 * 规范形）才能命中。事故同类根因：入库保留 message.to 的 local part 大小写，
 * 而地址维度读路径字节精确比较 → 「邮件在库里，列表永远查不到」。
 *
 * 关键场景：**混合大小写 To: 投递** —— SMTP 信封里 To 的大小写由发件方决定
 * （如 x.ai 把聚合账号写成 KevinWalters5892@outlook.com），必须被写侧吸收。
 */
test.describe('Receive mail with mixed-case recipient', () => {
  test('mixed-case To: is canonicalized on write and visible in the mailbox', async ({ request }) => {
    const testUserEmail = `mixed-case-e2e-${Date.now()}@test.example.com`;
    const testUserPassword = 'test-password-123';
    const { createHash } = await import('node:crypto');
    const passwordHash = createHash('sha256').update(testUserPassword).digest('hex');

    const settingsRes = await request.get(`${WORKER_URL}/admin/user_settings`, { headers: ADMIN_HEADERS });
    expect(settingsRes.ok()).toBe(true);
    const current = await settingsRes.json() as Record<string, unknown>;
    const saveRes = await request.post(`${WORKER_URL}/admin/user_settings`, {
      headers: ADMIN_HEADERS,
      data: { ...current, enable: true, enableMailVerify: false },
    });
    expect(saveRes.ok()).toBe(true);

    const registerRes = await request.post(`${WORKER_URL}/user_api/register`, {
      data: { email: testUserEmail, password: passwordHash },
    });
    expect(registerRes.ok()).toBe(true);

    const loginRes = await request.post(`${WORKER_URL}/user_api/login`, {
      data: { email: testUserEmail, password: passwordHash },
    });
    expect(loginRes.ok()).toBe(true);
    const { jwt: userJwt } = await loginRes.json();
    expect(userJwt).toBeTruthy();

    const created = await createTestAddress(request, 'mixed-case-e2e');
    const { jwt: addressJwt, address } = created;

    // 故意用与建址不同的大小写形态投递（local part 逐字符交替变换大小写）
    const [local, domain] = address.split('@');
    const mixedTo = local.split('').map((ch, i) =>
      i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase()).join('') + '@' + domain.toUpperCase();

    try {
      const bindRes = await request.post(`${WORKER_URL}/user_api/bind_address`, {
        headers: { Authorization: `Bearer ${addressJwt}`, 'x-user-token': userJwt },
      });
      expect(bindRes.ok()).toBe(true);

      const receiveRes = await request.post(`${WORKER_URL}/admin/test/receive_mail`, {
        data: {
          from: `sender@${domain}`,
          to: mixedTo,
          raw: [
            `From: sender@${domain}`,
            `To: ${mixedTo}`,
            'Subject: Your verification code',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Your code is 313-702',
          ].join('\r\n'),
        },
      });
      expect(receiveRes.ok()).toBe(true);
      const receiveBody = await receiveRes.json();
      expect(receiveBody.success).toBe(true);

      // 用户邮箱必须可见（写侧规范形 + JOIN 两侧规范形 同时成立才通过）
      const listRes = await request.get(`${WORKER_URL}/user_api/mails?limit=10&offset=0`, {
        headers: { 'x-user-token': userJwt },
      });
      expect(listRes.ok()).toBe(true);
      const { results } = await listRes.json();
      expect(results.length).toBeGreaterThanOrEqual(1);
      const hit = results.find((m: { raw?: string }) => (m.raw ?? '').includes('313-702'));
      expect(hit).toBeTruthy();

      // 取码链：unified admin 按规范形地址查询必须能取到验证码
      const codeRes = await request.get(
        `${WORKER_URL}/api/unified/verifcodes?addr=${encodeURIComponent(address)}&fresh=600000`,
        { headers: ADMIN_HEADERS },
      );
      expect(codeRes.ok()).toBe(true);
      const { results: codes } = await codeRes.json();
      expect(codes.some((c: { code?: string }) => String(c.code).includes('313702'))).toBe(true);
    } finally {
      await deleteAddress(request, addressJwt);
    }
  });
});
