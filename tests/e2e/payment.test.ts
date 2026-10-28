import { Writable } from 'node:stream';
import { VerifyError } from 'x402/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeDossier } from '../../src/dossier/compose.js';
import type { Dossier } from '../../src/dossier/types.js';
import { env } from '../../src/env.js';
import { buildServer } from '../../src/server.js';
import { buildTestPayment, mutateAuthorization, toAtomicUsdc, usdcAddress } from './buildTestPayment.js';

// The facilitator (Coinbase's reference verifier/settler) is the only network dependency of the
// payment path, so stubbing it keeps these tests deterministic and free. The real thing is
// exercised by payment-live.test.ts. Everything else, header decoding, requirement building,
// the local checks and the Fastify hooks, is the production code.
const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn() }));
vi.mock('x402/verify', () => ({ useFacilitator: () => facilitator }));

// compose is the whole vendor layer, so "composeDossier not called" proves no vendor spend.
vi.mock('../../src/dossier/compose.js', () => ({ composeDossier: vi.fn() }));
const compose = vi.mocked(composeDossier);

const PHONE = '+15165551234';
const LOOKUP_URL = '/lookup/%2B15165551234';
const PAYER = '0x2222222222222222222222222222222222222222';
const TX = `0x${'ab'.repeat(32)}`;
const OTHER_WALLET = '0x3333333333333333333333333333333333333333';

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

function captureLogs() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  const text = () => chunks.join('');
  const lines = () =>
    text()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { stream, text, lines };
}

const pay = (overrides: Partial<Parameters<typeof buildTestPayment>[0]> = {}) =>
  buildTestPayment({ amount: '0.03', network: 'base-sepolia', to: env.WALLET_ADDRESS!, ...overrides });

const paidGet = (server: ReturnType<typeof buildServer>, header: string, url = LOOKUP_URL) =>
  server.inject({ method: 'GET', url, headers: { 'x-payment': header } });

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
});

describe('unpaid requests', () => {
  it('unpaid GET /lookup returns 402 with x402 challenge headers', async () => {
    server = buildServer();

    const res = await server.inject({ method: 'GET', url: LOOKUP_URL });

    expect(res.statusCode).toBe(402);
    expect(res.headers).toHaveProperty('x-payment-requirements');
    // The header carries the same challenge as the body (x402 v1: { x402Version, error, accepts }).
    const challenge = JSON.parse(Buffer.from(String(res.headers['x-payment-requirements']), 'base64').toString());
    expect(challenge).toEqual(res.json());
    expect(challenge).toMatchObject({ x402Version: 1, error: 'X-PAYMENT header is required' });
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'base-sepolia', // NODE_ENV=test is not production
      maxAmountRequired: toAtomicUsdc('0.03'), // 0.03 USDC
      asset: usdcAddress('base-sepolia'),
      payTo: env.WALLET_ADDRESS,
    });
    expect(challenge.accepts[0].resource).toMatch(/^http:\/\/.+\/lookup\/%2B15165551234$/);
    expect(compose).not.toHaveBeenCalled();
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  // Behind Fly's proxy the app sees plain http; without trustProxy the challenge would advertise an
  // http:// resource and a client's signed authorization URL would not match the https one it called.
  it('advertises an https resource when the proxy says the client spoke https', async () => {
    server = buildServer();

    const res = await server.inject({
      method: 'GET',
      url: LOOKUP_URL,
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'phone-intel-mcp.fly.dev' },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().accepts[0].resource).toBe('https://phone-intel-mcp.fly.dev/lookup/%2B15165551234');
    const header = JSON.parse(Buffer.from(String(res.headers['x-payment-requirements']), 'base64').toString());
    expect(header.accepts[0].resource).toBe(res.json().accepts[0].resource);
  });

  // Fastify auto-registers HEAD for GET routes; an ungated HEAD would run composeDossier for free.
  it('unpaid HEAD /lookup returns 402 without touching composeDossier', async () => {
    server = buildServer();

    const res = await server.inject({ method: 'HEAD', url: LOOKUP_URL });

    expect(res.statusCode).toBe(402);
    expect(res.headers).toHaveProperty('x-payment-requirements');
    expect(compose).not.toHaveBeenCalled();
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it('keeps GET /health unprotected', async () => {
    server = buildServer();

    const res = await server.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
  });
});

describe('paid requests', () => {
  it('paid request on base-sepolia returns the dossier and settles the payment', async () => {
    server = buildServer();
    const header = await pay();

    const res = await paidGet(server, header);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DOSSIER);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(compose).toHaveBeenCalledWith(PHONE);
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    const settlement = JSON.parse(Buffer.from(String(res.headers['x-payment-response']), 'base64').toString());
    expect(settlement).toMatchObject({ success: true, transaction: TX, network: 'base-sepolia' });
  });

  it('asks the facilitator to verify and settle exactly 0.03 USDC to the configured wallet', async () => {
    server = buildServer();

    await paidGet(server, await pay());

    for (const call of [facilitator.verify.mock.calls[0], facilitator.settle.mock.calls[0]]) {
      const [payload, requirements] = call;
      expect(payload).toMatchObject({ x402Version: 1, scheme: 'exact', network: 'base-sepolia' });
      expect(requirements).toMatchObject({
        scheme: 'exact',
        network: 'base-sepolia',
        maxAmountRequired: '30000',
        payTo: env.WALLET_ADDRESS,
        asset: usdcAddress('base-sepolia'),
      });
    }
  });

  it('never sends the phone number to the facilitator', async () => {
    server = buildServer();

    await paidGet(server, await pay());

    const sent = JSON.stringify([facilitator.verify.mock.calls, facilitator.settle.mock.calls]);
    expect(sent).not.toContain('5165551234');
    expect(sent).not.toContain('%2B1');
  });

  it('does not charge when the lookup itself is rejected (400)', async () => {
    server = buildServer();

    const res = await paidGet(server, await pay(), '/lookup/not-a-phone');

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_phone');
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(res.headers).not.toHaveProperty('x-payment-response');
  });

  it('does not charge when the lookup fails with a 5xx', async () => {
    server = buildServer();
    compose.mockRejectedValue(new Error('boom'));

    const res = await paidGet(server, await pay());

    expect(res.statusCode).toBe(500);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('withholds the dossier and returns 402 when settlement fails', async () => {
    server = buildServer();
    facilitator.settle.mockResolvedValue({
      success: false,
      errorReason: 'insufficient_funds',
      transaction: '',
      network: 'base-sepolia',
    });

    const res = await paidGet(server, await pay());

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ x402Version: 1, error: 'insufficient_funds' });
    expect(res.body).not.toContain('Verizon');
    expect(res.headers).not.toHaveProperty('x-payment-response');
  });

  it('withholds the dossier and returns 402 when the facilitator is unreachable at settlement', async () => {
    server = buildServer();
    facilitator.settle.mockRejectedValue(new Error('network down'));

    const res = await paidGet(server, await pay());

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'settlement_failed' });
    expect(res.body).not.toContain('Verizon');
  });

  it('serves a paid HEAD (and charges for it)', async () => {
    server = buildServer();

    const res = await server.inject({ method: 'HEAD', url: LOOKUP_URL, headers: { 'x-payment': await pay() } });

    expect(res.statusCode).toBe(200);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });
});

describe('rejected payments', () => {
  it('returns 402 with the facilitator reason when verification fails', async () => {
    server = buildServer();
    facilitator.verify.mockResolvedValue({ isValid: false, invalidReason: 'insufficient_funds', payer: PAYER });

    const res = await paidGet(server, await pay());

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ x402Version: 1, error: 'insufficient_funds' });
    expect(res.json().accepts).toHaveLength(1);
    expect(res.headers).toHaveProperty('x-payment-requirements');
    expect(compose).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('returns 402 (no free lookup) when the facilitator is unreachable at verification', async () => {
    server = buildServer();
    facilitator.verify.mockRejectedValue(new Error('network down'));

    const res = await paidGet(server, await pay());

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'verification_failed' });
    expect(compose).not.toHaveBeenCalled();
  });

  it('returns 402 for a malformed X-PAYMENT header without calling the facilitator', async () => {
    server = buildServer();

    const res = await paidGet(server, 'this-is-not-a-payment');

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'invalid_payment_header' });
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });

  it('rejects a payment signed for another network (base mainnet payment on a base-sepolia server)', async () => {
    server = buildServer();

    const res = await paidGet(server, await pay({ network: 'base' }));

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'invalid_network' });
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });

  it('rejects a payment addressed to some other wallet', async () => {
    server = buildServer();

    const res = await paidGet(server, await pay({ to: OTHER_WALLET }));

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'invalid_exact_evm_payload_recipient_mismatch' });
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });

  it('rejects a payment for less than 0.03 USDC', async () => {
    server = buildServer();

    const res = await paidGet(server, await pay({ amount: '0.01' }));

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'invalid_exact_evm_payload_authorization_value' });
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });

  // The reference verifier accepts any validBefore >= now + 6 s. Uncapped, a payer could pin a
  // replay-ledger entry (server memory) for years.
  it('rejects an authorization whose validBefore is far in the future', async () => {
    server = buildServer();
    const inOneHour = String(Math.floor(Date.now() / 1000) + 3600);
    const header = mutateAuthorization(await pay(), (auth) => {
      auth.validBefore = inOneHour;
    });

    const res = await paidGet(server, header);

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'invalid_payment_header' });
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });

  // The facilitator package's schema accepts all of these as "integers"; BigInt() throws on most of
  // them, which used to surface as a 500 echoing the payer's value.
  it.each(['1e5', '1.0', '', '0x7530'])('rejects a non-decimal authorization value %j with 402, not 500', async (value) => {
    server = buildServer();
    const header = mutateAuthorization(await pay(), (auth) => {
      auth.value = value;
    });

    const res = await paidGet(server, header);

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'invalid_payment_header' });
    expect(res.body).not.toMatch(/BigInt/i);
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });

  it('rejects a non-decimal validBefore with 402', async () => {
    server = buildServer();
    const header = mutateAuthorization(await pay(), (auth) => {
      auth.validBefore = '1e12';
    });

    const res = await paidGet(server, header);

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'invalid_payment_header' });
    expect(facilitator.verify).not.toHaveBeenCalled();
  });
});

// The reference verifier does not check whether the authorization nonce was already used, so a
// replayed header would pass /verify, run the vendors, and only fail at /settle: free lookups.
describe('payment replay', () => {
  it('rejects a payment header that was already used', async () => {
    server = buildServer();
    const header = await pay();

    const first = await paidGet(server, header);
    const second = await paidGet(server, header);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(402);
    expect(second.json()).toMatchObject({ error: 'payment_already_used' });
    expect(compose).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  // The nonce regex accepts mixed-case hex and the signature verifies over the bytes, so a payer can
  // re-case the nonce of an already-used payment and it is still a valid signature.
  it('rejects a replay even when the nonce hex case is changed', async () => {
    server = buildServer();
    const header = await pay();
    const flipped = mutateAuthorization(header, (auth) => {
      auth.nonce = `0x${auth.nonce.slice(2).toUpperCase()}`;
    });
    expect(flipped).not.toBe(header);

    const first = await paidGet(server, header);
    const second = await paidGet(server, flipped);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(402);
    expect(second.json().error).toMatch(/already_used|replay/i);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('lets only one of several concurrent requests with the same payment through', async () => {
    server = buildServer();
    const header = await pay();

    const responses = await Promise.all([paidGet(server, header), paidGet(server, header), paidGet(server, header)]);

    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 402)).toHaveLength(2);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });
});

describe('payment logging', () => {
  it('logs payment status and request id only: no phone, path or payment header', async () => {
    const logs = captureLogs();
    server = buildServer({ logStream: logs.stream });
    const header = await pay();
    facilitator.verify.mockResolvedValueOnce({ isValid: false, invalidReason: 'insufficient_funds', payer: PAYER });

    await server.inject({ method: 'GET', url: LOOKUP_URL }); // missing
    await paidGet(server, await pay()); // rejected (verify stub says no)
    await paidGet(server, header); // verified, settled

    const statuses = logs.lines().flatMap((line) => (typeof line.payment === 'string' ? [line.payment] : []));
    expect(statuses).toEqual(['missing', 'rejected', 'verified', 'settled']);
    for (const line of logs.lines().filter((l) => 'payment' in l)) {
      expect(line.reqId).toEqual(expect.any(String));
    }
    const text = logs.text();
    expect(text).not.toContain('5165551234');
    expect(text).not.toContain('%2B1');
    expect(text).not.toContain(header);
    expect(text.toLowerCase()).not.toContain('x-payment');
  });

  // A bad payment is routine; a broken facilitator is an incident (e.g. mainnet protocol mismatch).
  // Both answer the client with 402, so the log is the only place the difference shows.
  describe('separates a facilitator verdict from a facilitator failure', () => {
    const payments = (logs: ReturnType<typeof captureLogs>) =>
      logs.lines().flatMap((line) => (typeof line.payment === 'string' ? [{ payment: line.payment, level: line.level }] : []));

    it('logs a verification network failure as facilitator_error at error level, without the error', async () => {
      const logs = captureLogs();
      server = buildServer({ logStream: logs.stream });
      facilitator.verify.mockRejectedValue(new Error('socket hang up for 0x2222222222222222222222222222222222222222'));

      await paidGet(server, await pay());

      expect(payments(logs)).toEqual([{ payment: 'facilitator_error', level: 50 }]);
      expect(logs.text()).not.toContain('socket hang up');
      expect(logs.text()).not.toContain(PAYER);
    });

    it('logs a verdict delivered as a facilitator error response (VerifyError) as rejected', async () => {
      const logs = captureLogs();
      server = buildServer({ logStream: logs.stream });
      facilitator.verify.mockRejectedValue(new VerifyError(400, { isValid: false, invalidReason: 'insufficient_funds' }));

      const res = await paidGet(server, await pay());

      expect(res.json()).toMatchObject({ error: 'insufficient_funds' });
      expect(payments(logs)).toEqual([{ payment: 'rejected', level: 30 }]);
    });

    it('logs a settlement network failure as facilitator_error at error level', async () => {
      const logs = captureLogs();
      server = buildServer({ logStream: logs.stream });
      facilitator.settle.mockRejectedValue(new Error('ETIMEDOUT'));

      await paidGet(server, await pay());

      expect(payments(logs)).toEqual([
        { payment: 'verified', level: 30 },
        { payment: 'facilitator_error', level: 50 },
      ]);
      expect(logs.text()).not.toContain('ETIMEDOUT');
    });

    it('logs a settlement the facilitator refused as settlement_failed', async () => {
      const logs = captureLogs();
      server = buildServer({ logStream: logs.stream });
      facilitator.settle.mockResolvedValue({ success: false, errorReason: 'insufficient_funds', transaction: '', network: 'base-sepolia' });

      await paidGet(server, await pay());

      expect(payments(logs)).toEqual([
        { payment: 'verified', level: 30 },
        { payment: 'settlement_failed', level: 40 },
      ]);
    });
  });
});
