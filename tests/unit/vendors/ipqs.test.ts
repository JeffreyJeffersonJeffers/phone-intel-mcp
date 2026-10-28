import { inspect } from 'node:util';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCached } from '../../../src/cache/cache.js';
import { lookupReputation } from '../../../src/vendors/ipqs.js';

// IPQS is mocked (global fetch: no network, no spend); the cache is the real Supabase Postgres,
// same as the Yelp and Twilio tests, so cache behaviour here is exercised end to end.
const { fetchMock, mockEnv } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  mockEnv: {} as Record<string, string | undefined>,
}));

// vitest.config.ts deliberately keeps vendor keys out of the test env, so inject a fake one.
vi.mock('../../../src/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/env.js')>();
  Object.assign(mockEnv, actual.env, { IPQS_API_KEY: 'test-ipqs-key' });
  return { ...actual, env: mockEnv };
});

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set: the cache round-trip needs the real Supabase database (.env.local)');
}
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 });

// Distinct from the Twilio (+15165559401) and Yelp (+12125553333) fixtures and the integration
// numbers (+15165551234..6): all files share one database and vitest runs them in parallel.
const PHONE = '+16175551234';
const DIGITS = '16175551234';
const DEGRADED = { spam_risk_score: 0, is_known_robocall: false, is_dnc_listed: null, is_voip_risk: false, cached: false };

// A fresh Response per call: a body can only be read once. IPQS sets success on every reply.
const ipqsReturns = (body: unknown, status = 200) =>
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
const mockIpqs = (fields: Record<string, unknown>) => ipqsReturns({ success: true, message: 'Phone is valid.', ...fields });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  mockEnv.IPQS_API_KEY = 'test-ipqs-key';
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await sql`DELETE FROM phone_lookups WHERE phone_e164 = ${PHONE}`;
});
afterAll(() => sql.end());

describe('lookupReputation mapping', () => {
  it('maps fraud_score to spam_risk_score and the flags to their fields', async () => {
    mockIpqs({ fraud_score: 85, risky: true, do_not_call: true, VOIP: false });
    expect(await lookupReputation(PHONE)).toEqual({
      spam_risk_score: 85,
      is_known_robocall: true,
      is_dnc_listed: true,
      is_voip_risk: false,
      cached: false,
    });
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', '85'],
  ])('defaults spam_risk_score to 0 when fraud_score is %s', async (_label, fraud_score) => {
    mockIpqs({ fraud_score });
    expect((await lookupReputation(PHONE)).spam_risk_score).toBe(0);
  });

  it.each([
    ['absent', undefined],
    ['null (IPQS reports null for a number it cannot assess)', null],
    ['the string "true"', 'true'],
    ['false', false],
  ])('is_known_robocall is false unless risky is exactly true (%s)', async (_label, risky) => {
    mockIpqs({ risky });
    expect((await lookupReputation(PHONE)).is_known_robocall).toBe(false);
  });

  it.each([
    ['absent', undefined, null],
    ['null (DNC data not enabled on the account)', null, null],
    ['a string', 'yes', null],
    ['false', false, false],
    ['true', true, true],
  ])('is_dnc_listed when do_not_call is %s', async (_label, do_not_call, expected) => {
    mockIpqs({ do_not_call });
    expect((await lookupReputation(PHONE)).is_dnc_listed).toBe(expected);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['the string "true"', 'true'],
  ])('is_voip_risk is false unless VOIP is exactly true (%s)', async (_label, VOIP) => {
    mockIpqs({ VOIP });
    expect((await lookupReputation(PHONE)).is_voip_risk).toBe(false);
  });

  it('sends a GET with the key in the path and the E.164 digits without "+", then strictness=1', async () => {
    mockIpqs({ fraud_score: 0 });
    await lookupReputation(PHONE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`https://ipqualityscore.com/api/json/phone/test-ipqs-key/${DIGITS}?strictness=1`);
    expect(init.method ?? 'GET').toBe('GET');
  });
});

describe('lookupReputation cache', () => {
  it('reads from cache on second call without calling IPQS again', async () => {
    mockIpqs({ fraud_score: 85, risky: true, do_not_call: true, VOIP: false });
    const first = await lookupReputation(PHONE);
    const second = await lookupReputation(PHONE);

    expect(first.cached).toBe(false);
    expect(second).toEqual({
      spam_risk_score: 85,
      is_known_robocall: true,
      is_dnc_listed: true,
      is_voip_risk: false,
      cached: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stores the mapped reputation in the reputation field, without the cached flag', async () => {
    mockIpqs({ fraud_score: 85, risky: true, do_not_call: true, VOIP: false });
    await lookupReputation(PHONE);

    const stored = await getCached<Record<string, unknown>>(PHONE, 'reputation');
    expect(stored).toEqual({ spam_risk_score: 85, is_known_robocall: true, is_dnc_listed: true, is_voip_risk: false });
    expect(stored).not.toHaveProperty('cached');
  });
});

describe('lookupReputation failure handling', () => {
  // A real fetch rejects with an AbortError when its signal fires; the mock does the same.
  const hangUntilAborted = () =>
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
        }),
    );

  it('returns a degraded result within the 900ms budget when IPQS hangs, and does not cache it', async () => {
    hangUntilAborted();
    const started = Date.now();
    const result = await lookupReputation(PHONE);
    const elapsed = Date.now() - started;

    expect(result).toEqual(DEGRADED);
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThan(1500);
    expect(await getCached(PHONE, 'reputation')).toBeNull();
  });

  it('retries IPQS on the next call after a timeout instead of serving a poisoned cache', async () => {
    hangUntilAborted();
    await lookupReputation(PHONE);

    mockIpqs({ fraud_score: 10, risky: false, do_not_call: false, VOIP: true });
    expect(await lookupReputation(PHONE)).toEqual({
      spam_risk_score: 10,
      is_known_robocall: false,
      is_dnc_listed: false,
      is_voip_risk: true,
      cached: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a 500', 500],
    ['a 503', 503],
    ['a 429 rate limit', 429],
    ['a 400', 400],
    ['a 404', 404],
  ])('returns a degraded result and does not cache on %s from IPQS', async (_label, status) => {
    ipqsReturns({ success: false, message: 'nope' }, status);
    expect(await lookupReputation(PHONE)).toEqual(DEGRADED);
    expect(await getCached(PHONE, 'reputation')).toBeNull();
  });

  it('returns a degraded result and does not cache on a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await lookupReputation(PHONE)).toEqual(DEGRADED);
    expect(await getCached(PHONE, 'reputation')).toBeNull();
  });

  it('degrades, and does not throw, when a network error carries the key in its message and cause', async () => {
    // The request URL (key in the path) can be echoed by a network error. The adapter swallows
    // network errors, so nothing carrying the key can escape the call.
    fetchMock.mockRejectedValue(
      new TypeError(`fetch failed: https://ipqualityscore.com/api/json/phone/${mockEnv.IPQS_API_KEY}/${DIGITS}`, {
        cause: new Error(`connect ECONNRESET ipqualityscore.com (${mockEnv.IPQS_API_KEY})`),
      }),
    );
    await expect(lookupReputation(PHONE)).resolves.toEqual(DEGRADED);
    expect(await getCached(PHONE, 'reputation')).toBeNull();
  });

  it.each([
    ['a body that is not JSON', () => new Response('<html>gateway</html>', { status: 200 })],
    ['JSON without a success flag', () => new Response(JSON.stringify({ fraud_score: 90, risky: true }), { status: 200 })],
  ])('treats a 200 with %s as a vendor gap: degraded and not cached', async (_label, make) => {
    fetchMock.mockImplementation(async () => make());
    expect(await lookupReputation(PHONE)).toEqual(DEGRADED);
    expect(await getCached(PHONE, 'reputation')).toBeNull();
  });

  it('degrades on a per-number error (success false, "Invalid/nonexistent phone number") instead of throwing', async () => {
    // IPQS's documented response for a number it cannot find. That is a normal answer, not an auth
    // failure, so it must not stop the lookup. Not cached, per the brief's degrade rule.
    ipqsReturns({ success: false, message: 'Invalid/nonexistent phone number or no country specified.' });
    expect(await lookupReputation(PHONE)).toEqual(DEGRADED);
    expect(await getCached(PHONE, 'reputation')).toBeNull();
  });

  it.each([
    ['401', 401],
    ['403', 403],
  ])('throws loudly on an IPQS %s instead of degrading, without leaking the key', async (_label, status) => {
    // The upstream body echoes the credential, as a misbehaving gateway might.
    ipqsReturns({ success: false, message: `Bad key ${mockEnv.IPQS_API_KEY}` }, status);
    const error = await lookupReputation(PHONE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(new RegExp(`ipqs.*(${status}|auth)`, 'i'));
    // Status only: nothing from the upstream body or request may reach the logs, in the message,
    // a `cause` chain, or any other property (util.inspect walks them all).
    expect(inspect(error, { depth: null, showHidden: true })).not.toContain(mockEnv.IPQS_API_KEY);
    expect((error as Error).cause).toBeUndefined();
    expect(await getCached(PHONE, 'reputation')).toBeNull();
  });

  it.each([
    ['an invalid API key', 'Invalid API key provided'],
    ['a bad token', 'Invalid or unexpected token'],
    ['an exhausted quota', 'You have exceeded your monthly request limit'],
  ])('throws loudly on success:false for %s', async (_label, message) => {
    ipqsReturns({ success: false, message });
    await expect(lookupReputation(PHONE)).rejects.toThrow(/IPQS rejected the request/);
    expect(await getCached(PHONE, 'reputation')).toBeNull();
  });

  it('redacts the key from the thrown message if IPQS echoes it back', async () => {
    ipqsReturns({ success: false, message: `Invalid key ${mockEnv.IPQS_API_KEY}` });
    const error = await lookupReputation(PHONE).catch((e: unknown) => e);

    expect((error as Error).message).toContain('[redacted]');
    expect(inspect(error, { depth: null, showHidden: true })).not.toContain(mockEnv.IPQS_API_KEY);
    expect((error as Error).cause).toBeUndefined();
  });

  it('throws a clear error, without calling IPQS, when IPQS_API_KEY is unset', async () => {
    mockEnv.IPQS_API_KEY = undefined;
    await expect(lookupReputation(PHONE)).rejects.toThrow('IPQS_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
