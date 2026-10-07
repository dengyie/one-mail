import { test, expect } from '@playwright/test';
import { WORKER_URL } from '../../fixtures/test-helpers';

test('observe service persists and reads through the real Worker Durable Object binding', async ({ request }) => {
  const base = `${WORKER_URL}/internal/fleet`;
  const reader = { Authorization: 'Bearer e2e-fleet-read-rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr' };
  const controller = { Authorization: 'Bearer e2e-fleet-control-cccccccccccccccccccccccccccccccc' };
  expect((await request.get(`${base}/snapshot`)).status()).toBe(401);
  expect((await request.post(`${base}/configure`, { headers: reader, data: {} })).status()).toBe(403);
  const config = {
    accounts: [{ account_key: 'primary', provider_account_id: 'provider-primary', enabled: true,
      credential_ref: 'metrics-primary', daily_read_limit: 5_000_000, daily_write_limit: 100_000,
      worker_request_limit: 100_000, metrics_observed_at: null }],
    shards: [{ shard_id: 'primary', account_key: 'primary', database_id: 'database-primary',
      credential_ref: 'token-primary', base_url: 'https://primary.example.com', state: 'healthy',
      schema_version: 1, protocol_version: 2, storage_limit_bytes: 500_000_000, observed_size_bytes: 0 }],
    primary_shard_id: 'primary', required_schema_version: 1, required_protocol_version: 2,
    allocation_budget: { reserved_read: 10_000, reserved_write: 1_000, reserved_worker_requests: 100, reserved_bytes: 1_000_000 },
    max_mailboxes: 1_000,
  };
  const command = { expected_revision: '0', idempotency_key: 'e2e-configure', config };
  const configured = await request.post(`${base}/configure`, { headers: controller, data: command });
  expect(configured.status()).toBe(200);
  expect(await configured.json()).toEqual({ ok: true, revision: '1' });
  const snapshot = await request.get(`${base}/snapshot`, { headers: reader });
  expect(snapshot.status()).toBe(200);
  const body = await snapshot.json();
  expect(body.revision).toBe('1');
  expect(body.mailbox_routes).toEqual({});
  expect(body.shards.primary).not.toHaveProperty('database_id');
  expect(body.shards.primary).not.toHaveProperty('credential_ref');
  const repeated = await request.post(`${base}/configure`, { headers: controller, data: command });
  expect(await repeated.json()).toEqual({ ok: true, revision: '1' });
  const plan = await request.post(`${base}/plan`, { headers: reader, data: { expected_revision: '1' } });
  expect(plan.status()).toBe(200);
  expect(await plan.json()).toEqual({ ok: true, revision: '1', decision: { ok: false, error_code: 'NO_CAPACITY' } });
  const conditional = await request.get(`${base}/snapshot`, { headers: { ...reader, 'If-None-Match': snapshot.headers().etag } });
  expect(conditional.status()).toBe(304);
  expect((await request.post(`${base}/allocate`, { headers: controller, data: {} })).status()).toBe(404);
});
