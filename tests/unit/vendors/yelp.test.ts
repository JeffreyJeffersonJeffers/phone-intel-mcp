import { inspect } from 'node:util';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCached } from '../../../src/cache/cache.js';
import { lookupYelp } from '../../../src/vendors/yelp.js';

// Yelp is mocked (global fetch: no network, no spend); the cache is the real Supabase Postgres,
// same as the Task 3/4 tests, so cache behaviour here is exercised end to end.
const { fetchMock, mockEnv } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  mockEnv: {} as Record<string, string | undefined>,
}));

// vitest.config.ts deliberately keeps vendor keys out of the test env, so inject a fake one.
vi.mock('../../../src/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/env.js')>();
  Object.assign(mockEnv, actual.env, { YELP_API_KEY: 'test-yelp-key' });
  return { ...actual, env: mockEnv };
});

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set: the cache round-trip needs the real Supabase database (.env.local)');
}
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 });

// Distinct from the numbers in tests/integration/cache.test.ts (+15165551234..6) and the Twilio
// test (+15165559401): all files share one database and vitest runs them in parallel, so a shared
// fixture would let their cleanups race.
const PHONE = '+12125553333';
const DEGRADED = { business: null, cached: false };

const JOES = {
  id: 'y1',
  name: "Joe's Pizza",
  categories: [{ alias: 'pizza', title: 'Pizza' }, { alias: 'italian', title: 'Italian' }],
  location: { address1: '7 Carmine St', city: 'New York', state: 'NY', zip_code: '10014' },
  rating: 4.5,
  review_count: 2100,
};
const JOES_MAPPED = {
  name: "Joe's Pizza",
  category: 'Pizza',
  yelp_id: 'y1',
  address: { line1: '7 Carmine St', city: 'New York', state: 'NY', postal: '10014' },
  rating: { stars: 4.5, count: 2100 },
};

// A fresh Response per call: a body can only be read once.
const yelpReturns = (body: unknown, status = 200) =>
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
const mockYelp = (body: unknown) => yelpReturns(body);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  mockEnv.YELP_API_KEY = 'test-yelp-key';
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await sql`DELETE FROM phone_lookups WHERE phone_e164 = ${PHONE}`;
});
afterAll(() => sql.end());

describe('lookupYelp mapping', () => {
  it('resolves business by phone', async () => {
    mockYelp({ businesses: [JOES] });
    expect(await lookupYelp(PHONE)).toEqual({ business: JOES_MAPPED, cached: false });
  });

  it('returns business null on no match', async () => {
    mockYelp({ businesses: [] });
    expect(await lookupYelp(PHONE)).toEqual(DEGRADED);
  });

  it('maps only the first result', async () => {
    mockYelp({ businesses: [JOES, { ...JOES, id: 'y2', name: 'Second Place' }] });
    expect((await lookupYelp(PHONE)).business).toMatchObject({ yelp_id: 'y1', name: "Joe's Pizza" });
  });

  it.each([
    ['categories absent', undefined],
    ['categories empty', []],
  ])('falls back to category Unknown when %s', async (_label, categories) => {
    mockYelp({ businesses: [{ ...JOES, categories }] });
    expect((await lookupYelp(PHONE)).business?.category).toBe('Unknown');
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', '4.5'],
  ])('returns rating null when Yelp rating is %s', async (_label, rating) => {
    mockYelp({ businesses: [{ ...JOES, rating }] });
    expect((await lookupYelp(PHONE)).business?.rating).toBeNull();
  });

  it('keeps a rating of 0 (a number) rather than treating it as missing', async () => {
    mockYelp({ businesses: [{ ...JOES, rating: 0, review_count: 0 }] });
    expect((await lookupYelp(PHONE)).business?.rating).toEqual({ stars: 0, count: 0 });
  });

  it('defaults address parts to empty strings when Yelp omits them', async () => {
    mockYelp({ businesses: [{ ...JOES, location: { city: 'New York', address1: null } }] });
    expect((await lookupYelp(PHONE)).business?.address).toEqual({ line1: '', city: 'New York', state: '', postal: '' });
  });

  it('defaults address to empty strings when Yelp omits location entirely', async () => {
    const { location: _location, ...noLocation } = JOES;
    mockYelp({ businesses: [noLocation] });
    expect((await lookupYelp(PHONE)).business?.address).toEqual({ line1: '', city: '', state: '', postal: '' });
  });

  it('sends a GET to the Yelp phone-search endpoint with the E.164 number URL-encoded and a Bearer key', async () => {
    mockYelp({ businesses: [] });
    await lookupYelp(PHONE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // "+" must be %2B: a bare "+" in a query string decodes to a space.
    expect(String(url)).toBe('https://api.yelp.com/v3/businesses/search/phone?phone=%2B12125553333');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-yelp-key' });
  });
});

describe('lookupYelp cache', () => {
  it('reads a match from cache on second call', async () => {
    mockYelp({ businesses: [JOES] });
    const first = await lookupYelp(PHONE);
    const second = await lookupYelp(PHONE);

    expect(first.cached).toBe(false);
    expect(second).toEqual({ business: JOES_MAPPED, cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stores the mapped business in the business field', async () => {
    mockYelp({ businesses: [JOES] });
    await lookupYelp(PHONE);
    expect(await getCached(PHONE, 'business')).toEqual(JOES_MAPPED);
  });

  it('caches a miss as { matched: false } so a repeat call is served from cache', async () => {
    mockYelp({ businesses: [] });
    const first = await lookupYelp(PHONE);
    expect(first).toEqual({ business: null, cached: false });
    expect(await getCached(PHONE, 'business')).toEqual({ matched: false });

    expect(await lookupYelp(PHONE)).toEqual({ business: null, cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('lookupYelp failure handling', () => {
  // A real fetch rejects with an AbortError when its signal fires; the mock does the same.
  const hangUntilAborted = () =>
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
        }),
    );

  it('returns a degraded result within the 900ms budget when Yelp hangs, and does not cache it', async () => {
    hangUntilAborted();
    const started = Date.now();
    const result = await lookupYelp(PHONE);
    const elapsed = Date.now() - started;

    expect(result).toEqual(DEGRADED);
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThan(1500);
    expect(await getCached(PHONE, 'business')).toBeNull();
  });

  it('retries Yelp on the next call after a timeout instead of serving a poisoned cache', async () => {
    hangUntilAborted();
    await lookupYelp(PHONE);

    mockYelp({ businesses: [JOES] });
    expect(await lookupYelp(PHONE)).toEqual({ business: JOES_MAPPED, cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a 500', 500],
    ['a 503', 503],
    ['a 429 rate limit', 429],
    ['a 400', 400],
    ['a 404', 404],
  ])('returns a degraded result and does not cache on %s from Yelp', async (_label, status) => {
    yelpReturns({ error: { code: 'SOMETHING', description: 'nope' } }, status);
    expect(await lookupYelp(PHONE)).toEqual(DEGRADED);
    expect(await getCached(PHONE, 'business')).toBeNull();
  });

  it('returns a degraded result and does not cache on a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await lookupYelp(PHONE)).toEqual(DEGRADED);
    expect(await getCached(PHONE, 'business')).toBeNull();
  });

  it.each([
    ['a body that is not JSON', () => new Response('<html>gateway</html>', { status: 200 })],
    ['JSON without a businesses array', () => new Response(JSON.stringify({ total: 0 }), { status: 200 })],
  ])('treats a 200 with %s as a vendor gap: degraded and not cached (not a confirmed miss)', async (_label, make) => {
    fetchMock.mockImplementation(async () => make());
    expect(await lookupYelp(PHONE)).toEqual(DEGRADED);
    expect(await getCached(PHONE, 'business')).toBeNull();
  });

  it.each([
    ['401', 401, /yelp.*(401|auth)/i],
    ['403', 403, /yelp.*(403|auth)/i],
  ])('throws loudly on a Yelp %s instead of degrading, without leaking the key', async (_label, status, pattern) => {
    // The upstream body echoes the credential, as a misbehaving gateway might.
    yelpReturns({ error: { code: 'TOKEN_INVALID', description: `Bad key ${mockEnv.YELP_API_KEY}` } }, status);
    const error = await lookupYelp(PHONE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(pattern);
    // Status only: nothing from the upstream body or request may reach the logs, in the message,
    // a `cause` chain, or any other property (util.inspect walks them all).
    expect(inspect(error, { depth: null, showHidden: true })).not.toContain(mockEnv.YELP_API_KEY);
    expect((error as Error).cause).toBeUndefined();
    expect(await getCached(PHONE, 'business')).toBeNull();
  });

  it('throws a clear error, without calling Yelp, when YELP_API_KEY is unset', async () => {
    mockEnv.YELP_API_KEY = undefined;
    await expect(lookupYelp(PHONE)).rejects.toThrow('YELP_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
