import { randomBytes } from 'node:crypto';
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

  // validAfter is read as a BigInt for the local signature check, so it gets the same digits-only gate.
  it.each(['1e5', '1.0', '', '0x10'])('rejects a non-decimal validAfter %j with 402', async (validAfter) => {
    server = buildServer();
    const header = mutateAuthorization(await pay(), (auth) => {
      auth.validAfter = validAfter;
    });

    const res = await paidGet(server, header);

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'invalid_payment_header' });
    expect(facilitator.verify).not.toHaveBeenCalled();
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

// The in-flight cap below is keyed by the `from` address in the header, which anyone can write: payer
// addresses are public on-chain. Without a check, junk-signature requests naming a victim's address
// keep the victim's slot taken and every real request from them gets 429 (a cheap, sustained denial
// of service). So the signature is checked locally, before the nonce is claimed and before the slot is
// taken. v1 is EOA-only: the one accepted shape is a 65-byte ECDSA signature by the named payer, and
// anything else (smart-contract wallets included, ERC-1271 / ERC-6492) is rejected there and then.
describe('payer authentication before the slot', () => {
  const newKey = () => `0x${randomBytes(32).toString('hex')}`;
  const decode = (header: string) => JSON.parse(Buffer.from(header, 'base64').toString());
  const encode = (payment: unknown) => Buffer.from(JSON.stringify(payment)).toString('base64');
  const fromOf = (header: string): string => decode(header).payload.authorization.from;
  const signatureOf = (header: string): string => decode(header).payload.signature;
  const withSignature = (header: string, signature: string) => {
    const payment = decode(header);
    payment.payload.signature = signature;
    return encode(payment);
  };
  // A header that names `victim` as the payer but was signed by someone else.
  const forgedAs = async (victim: string) =>
    mutateAuthorization(await pay({ payerPrivateKey: newKey() }), (auth) => {
      auth.from = victim;
    });

  // The attack as it was measured: forgeries naming one victim sent back to back while the victim keeps
  // trying. The facilitator is slow (as a real one is), which is what let the forgeries pile up. The
  // attacker's choice of signature is free, so every shape of it has to be turned away locally: a
  // well-formed one by the wrong key, and ones of the wrong length (the cheapest forgery of all).
  it.each([
    ['a well-formed signature by someone else', undefined],
    ['a 1-byte signature', 1],
    ['a 64-byte signature', 64],
    ['a 66-byte signature', 66],
    ['a 100-byte signature', 100],
  ])('keeps a victim served through a burst of forgeries naming them, signed with %s', async (_label, junkBytes) => {
    server = buildServer();
    facilitator.verify.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { isValid: true, payer: PAYER };
    });
    const victimKey = newKey();
    const victimAddress = fromOf(await pay({ payerPrivateKey: victimKey }));
    const forgeries = await Promise.all(
      Array.from({ length: 40 }, async () => {
        const forged = await forgedAs(victimAddress);
        return junkBytes === undefined ? forged : withSignature(forged, `0x${'ab'.repeat(junkBytes)}`);
      }),
    );
    const legit = await Promise.all(Array.from({ length: 8 }, () => pay({ payerPrivateKey: victimKey })));

    const burst = Promise.all(forgeries.map((header) => paidGet(server, header)));
    const victimResults = [];
    for (const header of legit) victimResults.push(await paidGet(server, header)); // one after another
    const forged = await burst;

    expect(victimResults.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    expect(forged.map((r) => r.statusCode)).toEqual(Array(40).fill(402));
    expect(facilitator.verify).toHaveBeenCalledTimes(8); // only the victim's own payments reached it
  });

  it('rejects a payment whose signature is not from the payer it names, without taking the payer slot', async () => {
    server = buildServer();
    const victimHeader = await pay({ payerPrivateKey: newKey() });
    const forged = await forgedAs(fromOf(victimHeader));
    // If the forgery reached the facilitator it would sit there holding the victim's slot.
    let release!: (verdict: unknown) => void;
    const stuck = new Promise((resolve) => (release = resolve));
    facilitator.verify.mockImplementation(async (payload: { payload: { signature: string } }) =>
      payload.payload.signature === signatureOf(forged) ? stuck : { isValid: true, payer: PAYER },
    );

    const forgery = paidGet(server, forged);
    const victim = await paidGet(server, victimHeader);
    release({ isValid: true, payer: PAYER }); // only matters if the forgery got that far
    const rejected = await forgery;

    expect(rejected.statusCode).toBe(402);
    expect(rejected.json()).toMatchObject({ error: 'invalid_exact_evm_payload_signature' });
    expect(victim.statusCode).toBe(200); // not 429 concurrent_request
    expect(facilitator.verify).toHaveBeenCalledTimes(1); // only the victim's, the forgery never left
    expect(compose).toHaveBeenCalledTimes(1);
  });

  it('does not claim the nonce for a forgery, so a rejected header is rejected the same way again', async () => {
    server = buildServer();
    const forged = await forgedAs(fromOf(await pay({ payerPrivateKey: newKey() })));

    const first = await paidGet(server, forged);
    const second = await paidGet(server, forged);

    expect(first.json()).toMatchObject({ error: 'invalid_exact_evm_payload_signature' });
    expect(second.json()).toMatchObject({ error: 'invalid_exact_evm_payload_signature' }); // not payment_already_used
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it('rejects a payment whose signed fields were changed afterwards (amount raised)', async () => {
    server = buildServer();
    const tampered = mutateAuthorization(await pay(), (auth) => {
      auth.value = '40000'; // still >= 30000, so only the signature can catch it
    });

    const res = await paidGet(server, tampered);

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'invalid_exact_evm_payload_signature' });
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it('rejects a 65-byte signature that is not a signature at all, with 402 and not a crash', async () => {
    server = buildServer();
    const junk = withSignature(await pay(), `0x${'11'.repeat(65)}`);

    const res = await paidGet(server, junk);

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'invalid_exact_evm_payload_signature' });
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['exactly as signed', (header: string) => header],
    [
      'with the payer address in another hex case',
      (header: string) =>
        mutateAuthorization(header, (auth) => {
          auth.from = `0x${auth.from.slice(2).toLowerCase()}`;
        }),
    ],
  ])('lets a payment signed by the payer it names through to the facilitator (%s)', async (_label, variant) => {
    server = buildServer();
    const header = variant(await pay({ payerPrivateKey: newKey() }));

    const res = await paidGet(server, header);

    expect(res.statusCode).toBe(200);
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  // v1 takes ordinary-wallet (EOA) signatures only. A signature of any other length (1 byte of junk, a
  // 64-byte compact one, a contract wallet's ERC-1271 blob or ERC-6492 wrapper) can't be checked here
  // and is not accepted: letting it through would hand every forger a way around the check above.
  it.each([1, 64, 66, 100])('rejects a %i-byte signature locally and never calls the facilitator', async (bytes) => {
    server = buildServer();
    const header = withSignature(await pay({ payerPrivateKey: newKey() }), `0x${'ab'.repeat(bytes)}`);

    const res = await paidGet(server, header);

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'invalid_exact_evm_payload_signature' });
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });
});

// The facilitator checks a payer's balance per call, not cumulatively, so a payer holding 0.03 USDC
// can sign N authorizations with different nonces and send them at once: every one verifies, every
// one runs the vendors, and only the first can settle. The replay ledger can't see this (the
// nonces differ). One request per payer at a time, from before /verify until after /settle, makes
// the second authorization's /verify happen after the first one's settlement has drained the balance.
describe('per-payer in-flight cap', () => {
  const RETRY_AFTER_SECONDS = 2;

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // Several distinct authorizations (fresh nonce each) from one payer key.
  const payFrom = async (key: string, count: number) =>
    Promise.all(Array.from({ length: count }, () => pay({ payerPrivateKey: key })));
  const newKey = () => `0x${randomBytes(32).toString('hex')}`;
  const composeEntered = (times: number) => vi.waitFor(() => expect(compose).toHaveBeenCalledTimes(times));

  it('rejects a second concurrent request from the same wallet with 429 concurrent_request', async () => {
    server = buildServer();
    const [first, second] = await payFrom(newKey(), 2);
    const lookup = deferred<Dossier>();
    compose.mockImplementationOnce(() => lookup.promise);

    const inFlight = paidGet(server, first!);
    await composeEntered(1);
    const rejected = await paidGet(server, second!);
    lookup.resolve(DOSSIER);
    const served = await inFlight;

    expect(served.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json()).toEqual({ error: { code: 'concurrent_request', retry_after_seconds: RETRY_AFTER_SECONDS } });
    expect(rejected.json().error.retry_after_seconds).toBeGreaterThan(0);
    expect(rejected.headers['retry-after']).toBe(String(RETRY_AFTER_SECONDS));
    // The rejected one cost nothing: no facilitator call, no vendor call, no settlement.
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('lets concurrent requests from different wallets both through', async () => {
    server = buildServer();
    const [first] = await payFrom(newKey(), 1);
    const [second] = await payFrom(newKey(), 1);
    const lookup = deferred<Dossier>();
    compose.mockImplementation(() => lookup.promise);

    const a = paidGet(server, first!);
    const b = paidGet(server, second!);
    await composeEntered(2); // both are inside the handler at the same time
    lookup.resolve(DOSSIER);

    expect((await a).statusCode).toBe(200);
    expect((await b).statusCode).toBe(200);
  });

  it('treats the same wallet in a different hex case as the same wallet', async () => {
    server = buildServer();
    const [first, second] = await payFrom(newKey(), 2);
    // The signature is not redone: the stubbed facilitator accepts it, the cap must still see one payer.
    const recased = mutateAuthorization(second!, (auth) => {
      auth.from = `0x${auth.from.slice(2).toUpperCase()}`;
    });
    expect(recased).not.toBe(second);
    const lookup = deferred<Dossier>();
    compose.mockImplementationOnce(() => lookup.promise);

    const inFlight = paidGet(server, first!);
    await composeEntered(1);
    const rejected = await paidGet(server, recased);
    lookup.resolve(DOSSIER);
    await inFlight;

    expect(rejected.statusCode).toBe(429);
    expect(rejected.json().error.code).toBe('concurrent_request');
  });

  it('frees the wallet once the first request has been served and settled', async () => {
    server = buildServer();
    const [first, second] = await payFrom(newKey(), 2);

    const a = await paidGet(server, first!);
    const b = await paidGet(server, second!);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(facilitator.settle).toHaveBeenCalledTimes(2);
  });

  it('does not use up the rejected authorization: the same header works on retry', async () => {
    server = buildServer();
    const [first, second] = await payFrom(newKey(), 2);
    const lookup = deferred<Dossier>();
    compose.mockImplementationOnce(() => lookup.promise);

    const inFlight = paidGet(server, first!);
    await composeEntered(1);
    expect((await paidGet(server, second!)).statusCode).toBe(429);
    lookup.resolve(DOSSIER);
    await inFlight;
    const retry = await paidGet(server, second!);

    expect(retry.statusCode).toBe(200);
  });

  // The slot is released in a finally after settlement: whichever way the first request ends, the
  // payer is not locked out afterwards.
  describe('releases the wallet when the first request ends', () => {
    const outcomes: [string, (key: string) => void, number][] = [
      ['the lookup fails with a 5xx', () => compose.mockRejectedValueOnce(new Error('boom')), 500],
      ['the lookup is rejected with a 400', () => {}, 400],
      [
        'settlement is refused',
        () =>
          facilitator.settle.mockResolvedValueOnce({
            success: false,
            errorReason: 'insufficient_funds',
            transaction: '',
            network: 'base-sepolia',
          }),
        402,
      ],
      ['settlement throws', () => facilitator.settle.mockRejectedValueOnce(new Error('network down')), 402],
      [
        'verification is refused',
        () => facilitator.verify.mockResolvedValueOnce({ isValid: false, invalidReason: 'insufficient_funds' }),
        402,
      ],
      ['verification throws', () => facilitator.verify.mockRejectedValueOnce(new Error('network down')), 402],
    ];

    it.each(outcomes)('when %s', async (label, arrange, expectedStatus) => {
      server = buildServer();
      const key = newKey();
      const [first, second] = await payFrom(key, 2);
      arrange(key);

      const a = await paidGet(server, first!, label.includes('400') ? '/lookup/not-a-phone' : LOOKUP_URL);
      const b = await paidGet(server, second!);

      expect(a.statusCode).toBe(expectedStatus);
      expect(b.statusCode).toBe(200);
    });
  });

  // A slot that is never released (a vendor call that hangs forever, say) must not lock a payer out
  // until the next restart. Authorizations expire within a minute anyway.
  it('stops honoring a slot that has been held for over a minute', async () => {
    server = buildServer();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const key = newKey();
      const [first] = await payFrom(key, 1);
      const lookup = deferred<Dossier>();
      compose.mockImplementationOnce(() => lookup.promise);
      const stuck = paidGet(server, first!);
      await composeEntered(1);

      vi.setSystemTime(Date.now() + 61_000);
      const [later] = await payFrom(key, 1);
      const res = await paidGet(server, later!);

      expect(res.statusCode).toBe(200);
      lookup.resolve(DOSSIER);
      await stuck;
    } finally {
      vi.useRealTimers();
    }
  });

  // The window the whole cap exists for: between the vendors answering and the money moving. A
  // payer whose first authorization is still settling has not been drained yet, so a second one
  // admitted now would verify against the full balance and run the vendors for free.
  it('holds the slot through settlement: a second request mid-settle gets 429', async () => {
    server = buildServer();
    const [first, second] = await payFrom(newKey(), 2);
    const settle = deferred<unknown>();
    facilitator.settle.mockImplementationOnce(() => settle.promise);

    const inFlight = paidGet(server, first!);
    await vi.waitFor(() => expect(facilitator.settle).toHaveBeenCalledTimes(1)); // vendors done, settling
    const mid = await paidGet(server, second!);
    settle.resolve({ success: true, transaction: TX, network: 'base-sepolia', payer: PAYER });
    await inFlight;

    expect(mid.statusCode).toBe(429);
    expect(mid.json().error.code).toBe('concurrent_request');
  });

  // A request that outlives its slot (expired and re-issued) must not, when it finally ends, free
  // the slot of the request that took over, or the cap would be open again for that payer.
  it('a late release from an expired holder does not free the new holder', async () => {
    server = buildServer();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const [a, b, c] = await payFrom(newKey(), 3);
      const lookupA = deferred<Dossier>();
      const lookupB = deferred<Dossier>();
      compose.mockImplementationOnce(() => lookupA.promise).mockImplementationOnce(() => lookupB.promise);
      const reqA = paidGet(server, a!);
      await composeEntered(1);
      vi.setSystemTime(Date.now() + 61_000);
      const reqB = paidGet(server, b!); // takes over the expired slot
      await composeEntered(2);
      lookupA.resolve(DOSSIER); // A finishes late: its release must be a no-op
      await reqA;
      const resC = await paidGet(server, c!); // B still in flight => must be 429
      lookupB.resolve(DOSSIER);
      await reqB;
      expect(resC.statusCode).toBe(429);
    } finally {
      vi.useRealTimers();
    }
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
      expect(line.request_id).toEqual(expect.any(String));
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
