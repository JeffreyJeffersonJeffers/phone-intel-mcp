import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeDossier } from '../../src/dossier/compose.js';
import type { Dossier } from '../../src/dossier/types.js';
import { env } from '../../src/env.js';
import { buildServer } from '../../src/server.js';
import { buildTestPayment } from './buildTestPayment.js';

// Same split as payment.test.ts: the facilitator and the vendor layer (compose) are stubbed, the
// x402 gate, the rate limiter and the routes are the real thing.
const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn(), getSupported: vi.fn() }));
vi.mock('@x402/core/http', async () => {
  const actual = await vi.importActual<typeof import('@x402/core/http')>('@x402/core/http');
  return { ...actual, HTTPFacilitatorClient: vi.fn().mockImplementation(() => facilitator) };
});

vi.mock('../../src/dossier/compose.js', () => ({ composeDossier: vi.fn() }));
const compose = vi.mocked(composeDossier);

const PHONE = '+15165551234';
const LOOKUP_URL = '/lookup/%2B15165551234';
const PAYER = '0x2222222222222222222222222222222222222222';
const TX = `0x${'ab'.repeat(32)}`;

const DOSSIER: Dossier = {
  phone: PHONE,
  number_classification: 'business',
  carrier: { name: 'Verizon', type: 'landline' },
  caller_name: null,
  business_match: null,
  reputation: { spam_risk_score: 0, is_known_robocall: false, is_dnc_listed: null, is_voip_risk: false },
  meta: {
    lookup_id: '3f0c7a52-6a52-4b8e-9d3b-0f6f1f6d2a11',
    schema_version: 'v1',
    cached_fields: [],
    timestamp: '2026-10-27T12:00:00.000Z',
  },
};

const newKey = () => `0x${randomBytes(32).toString('hex')}`;
const payFrom = (payerPrivateKey: string) =>
  buildTestPayment({ amount: '0.03', network: 'base-sepolia', to: env.WALLET_ADDRESS!, payerPrivateKey });

let server: ReturnType<typeof buildServer>;
afterEach(() => server.close());
// Braces matter: mockReset() returns the mock, and vitest would call a function returned from a hook as teardown.
beforeEach(() => {
  compose.mockReset();
  compose.mockResolvedValue(DOSSIER);
  facilitator.verify.mockReset();
  facilitator.verify.mockResolvedValue({ isValid: true, payer: PAYER });
  facilitator.settle.mockReset();
  facilitator.settle.mockResolvedValue({ success: true, transaction: TX, network: 'base-sepolia', payer: PAYER });
  server = buildServer();
});

// Each call signs a fresh authorization (single-use), one after another, like a busy agent would.
const paidLookup = async (key: string) =>
  server.inject({ method: 'GET', url: LOOKUP_URL, headers: { 'x-payment': await payFrom(key) } });

const lookupCall = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'phone_intel.lookup', arguments: { phone: PHONE } },
};
const mcpPost = (body: unknown, headers: Record<string, string> = {}) =>
  server.inject({
    method: 'POST',
    url: '/mcp',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });

async function useUp(key: string, count: number) {
  for (let i = 0; i < count; i++) expect((await paidLookup(key)).statusCode).toBe(200);
}

describe('per-wallet rate limit', () => {
  it('answers the 101st paid request within a minute with 429 rate_limited', async () => {
    const wallet = newKey();
    await useUp(wallet, 100);

    const res = await paidLookup(wallet);

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    const wait = res.json().error.retry_after_seconds;
    expect(Number.isInteger(wait)).toBe(true);
    expect(wait).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBe(String(wait));
  });

  it('does not charge the limited request or run the vendors for it', async () => {
    const wallet = newKey();
    await useUp(wallet, 100);

    await paidLookup(wallet);

    expect(compose).toHaveBeenCalledTimes(100);
    expect(facilitator.settle).toHaveBeenCalledTimes(100);
  });

  it('keeps a separate allowance per wallet', async () => {
    const busy = newKey();
    await useUp(busy, 100);
    expect((await paidLookup(busy)).statusCode).toBe(429);

    const other = await paidLookup(newKey());

    expect(other.statusCode).toBe(200);
  });

  it('does not let a limited wallet lock itself out of the in-flight cap afterwards', async () => {
    const wallet = newKey();
    await useUp(wallet, 100);
    expect((await paidLookup(wallet)).statusCode).toBe(429);

    // The 429 must have given back the wallet's slot: this is 429 rate_limited again, not concurrent_request.
    const again = await paidLookup(wallet);

    expect(again.statusCode).toBe(429);
    expect(again.json().error.code).toBe('rate_limited');
  });

  it('counts paid MCP lookups and GET /lookup in the same allowance', async () => {
    const wallet = newKey();
    await useUp(wallet, 100);

    const res = await mcpPost(lookupCall, { 'x-payment': await payFrom(wallet) });

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    expect(compose).toHaveBeenCalledTimes(100);
  });

  it('counts a request the lookup itself rejected (400): it still came from the wallet', async () => {
    const wallet = newKey();
    for (let i = 0; i < 100; i++) {
      const res = await server.inject({
        method: 'GET',
        url: '/lookup/not-a-phone',
        headers: { 'x-payment': await payFrom(wallet) },
      });
      expect(res.statusCode).toBe(400);
    }

    expect((await paidLookup(wallet)).statusCode).toBe(429);
  });

  it('does not count unpaid or rejected payments against anyone', async () => {
    const wallet = newKey();
    await useUp(wallet, 99);
    for (let i = 0; i < 200; i++) await server.inject({ method: 'GET', url: LOOKUP_URL }); // no payment: 402s
    facilitator.verify.mockResolvedValueOnce({ isValid: false, invalidReason: 'insufficient_funds' });
    expect((await paidLookup(wallet)).statusCode).toBe(402); // verification refused

    const res = await paidLookup(wallet); // the 100th that counts

    expect(res.statusCode).toBe(200);
  });
});

describe('unlimited paths', () => {
  it('never limits GET /health', async () => {
    for (let i = 0; i < 150; i++) {
      const res = await server.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('never limits MCP initialize and tools/list, even for a wallet that is over its limit', async () => {
    const wallet = newKey();
    await useUp(wallet, 100);
    expect((await paidLookup(wallet)).statusCode).toBe(429);

    for (let i = 0; i < 120; i++) {
      const init = await mcpPost({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      });
      expect(init.statusCode).toBe(200);
      const list = await mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(list.statusCode).toBe(200);
    }
    // Only the 101 paid lookups (the last one verified, then limited) reached the gate: none of the
    // 240 free messages did.
    expect(facilitator.verify).toHaveBeenCalledTimes(101);
  });
});
