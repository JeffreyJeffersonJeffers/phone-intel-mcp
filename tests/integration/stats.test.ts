import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';
import { resetStatsForTests } from '../../src/stats/counters.js';

// /stats is served unprotected alongside /health and /openapi.json so discovery indices and
// Show HN visitors can poke the service without paying.
describe('GET /stats', () => {
  beforeEach(() => resetStatsForTests());

  it('returns the snapshot shape with nulls when nothing has been recorded yet', async () => {
    const server = buildServer();
    const res = await server.inject({ method: 'GET', url: '/stats' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      version: expect.any(String),
      started_at: expect.any(String),
      uptime_seconds: expect.any(Number),
      lookups: { total: 0, success_rate: null },
      cache_hit_rate: null,
      latency_ms: { p50_ms: null, p95_ms: null, sample_size: 0 },
      note: expect.any(String),
    });
    await server.close();
  });

  it('is not gated by the x402 payment middleware (no payment-required header)', async () => {
    const server = buildServer();
    const res = await server.inject({ method: 'GET', url: '/stats' });
    expect(res.statusCode).toBe(200);
    expect(res.headers).not.toHaveProperty('payment-required');
    await server.close();
  });
});
