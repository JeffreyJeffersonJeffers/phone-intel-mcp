import { inspect } from 'node:util';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCached } from '../../../src/cache/cache.js';
import { lookupYelp } from '../../../src/vendors/yelp.js';

// Yelp is mocked (global fetch: no network, no spend); the cache is the real Supabase Postgres,
// same as the Task 3/4 tests, so cache behaviour here is exercised end to end.
const { fetchMock, mockEnv, logChunks } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  mockEnv: {} as Record<string, string | undefined>,
  logChunks: [] as string[],
}));

// The adapter's own log (vendorLog) is a real pino logger; here it writes to memory so a test can
// read the lines it would send to the Fly logs.
vi.mock('../../../src/lib/vendorLog.js', async () => {
  const { default: pino } = await import('pino');
  const { Writable } = await import('node:stream');
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logChunks.push(chunk.toString());
      done();
    },
  });
  return { vendorLog: pino({ level: 'info' }, stream) };
});
const loggedLines = () =>
  logChunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

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
  logChunks.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  mockEnv.YELP_API_KEY = 'test-yelp-key';
  // Unset unless a test sets it: with a ScraperAPI key Yelp is called through the proxy, and a key
  // exported in the developer's shell must not flip the direct-call tests onto that path.
  mockEnv.SCRAPERAPI_KEY = undefined;
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

// Yelp refuses datacenter IPs (Fly's included), so with SCRAPERAPI_KEY set the same Yelp GET goes
// through ScraperAPI (https://docs.scraperapi.com): GET https://api.scraperapi.com/?api_key=..&url=..
// &keep_headers=true, where keep_headers makes it forward our Authorization header to Yelp. The status
// code of the response is ScraperAPI's, not Yelp's: 200 and 404 are the target's; 401 is a bad
// ScraperAPI key; 403 is the monthly credits used up; 429 too many concurrent requests; 500 the
// request failed after ScraperAPI's own retries.
describe('lookupYelp through ScraperAPI', () => {
  const SCRAPER_KEY = 'scraper key/+&=?'; // awkward on purpose: it has to be URL-encoded
  const YELP_URL = 'https://api.yelp.com/v3/businesses/search/phone?phone=%2B12125553333';

  beforeEach(() => {
    mockEnv.SCRAPERAPI_KEY = SCRAPER_KEY;
  });

  // The upstream body echoes both credentials, as a misbehaving gateway might.
  const echoingBody = () => `Bad request ${SCRAPER_KEY} ${mockEnv.YELP_API_KEY}`;
  const expectNoKeyLeak = (error: unknown) => {
    const dump = inspect(error, { depth: null, showHidden: true });
    for (const secret of [SCRAPER_KEY, encodeURIComponent(SCRAPER_KEY), mockEnv.YELP_API_KEY!]) {
      expect(dump).not.toContain(secret);
    }
    expect((error as Error).cause).toBeUndefined();
  };

  describe('the request', () => {
    it('is a GET to api.scraperapi.com with the key, the encoded Yelp URL and keep_headers=true', async () => {
      mockYelp({ businesses: [] });
      await lookupYelp(PHONE);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [raw, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const url = new URL(String(raw));
      expect(url.origin).toBe('https://api.scraperapi.com');
      expect(url.searchParams.get('api_key')).toBe(SCRAPER_KEY); // survived & + = ? in the key
      expect(url.searchParams.get('url')).toBe(YELP_URL); // the Yelp URL, intact, including its own query
      expect(url.searchParams.get('keep_headers')).toBe('true');
      expect([...url.searchParams.keys()].sort()).toEqual(['api_key', 'keep_headers', 'url']);
      expect(init.method ?? 'GET').toBe('GET');
    });

    it('is built with every value percent-encoded, not just parsed leniently', async () => {
      mockYelp({ businesses: [] });
      await lookupYelp(PHONE);

      const raw = String((fetchMock.mock.calls[0] as [string])[0]);
      expect(raw).toBe(
        `https://api.scraperapi.com/?api_key=${encodeURIComponent(SCRAPER_KEY)}` +
          `&url=${encodeURIComponent(YELP_URL)}&keep_headers=true`,
      );
    });

    it('still sends our Yelp Authorization header, which keep_headers makes ScraperAPI forward', async () => {
      mockYelp({ businesses: [] });
      await lookupYelp(PHONE);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.headers).toMatchObject({ Authorization: 'Bearer test-yelp-key' });
    });

    it('does not call Yelp directly', async () => {
      mockYelp({ businesses: [] });
      await lookupYelp(PHONE);

      for (const [url] of fetchMock.mock.calls as [string][]) expect(String(url)).not.toMatch(/^https:\/\/api\.yelp\.com/);
    });

    it('calls Yelp directly when SCRAPERAPI_KEY is unset', async () => {
      mockEnv.SCRAPERAPI_KEY = undefined;
      mockYelp({ businesses: [] });
      await lookupYelp(PHONE);

      expect(String((fetchMock.mock.calls[0] as [string])[0])).toBe(YELP_URL);
    });
  });

  describe('a successful lookup', () => {
    it('maps and caches the business exactly like a direct call', async () => {
      mockYelp({ businesses: [JOES] });

      expect(await lookupYelp(PHONE)).toEqual({ business: JOES_MAPPED, cached: false });
      expect(await getCached(PHONE, 'business')).toEqual(JOES_MAPPED);
    });

    it('is then served from the cache without spending another ScraperAPI credit', async () => {
      mockYelp({ businesses: [JOES] });
      await lookupYelp(PHONE);

      expect(await lookupYelp(PHONE)).toEqual({ business: JOES_MAPPED, cached: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('caches a confirmed miss', async () => {
      mockYelp({ businesses: [] });
      await lookupYelp(PHONE);

      expect(await getCached(PHONE, 'business')).toEqual({ matched: false });
    });
  });

  describe('when ScraperAPI itself rejects us', () => {
    // A bad key is a configuration error that someone has to fix, so it stops the lookup.
    it('throws loudly on a 401 (a bad ScraperAPI key), with its own message and not as a Yelp failure', async () => {
      fetchMock.mockImplementation(async () => new Response(echoingBody(), { status: 401 }));
      const error = await lookupYelp(PHONE).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/ScraperAPI auth failed \(HTTP 401\)/);
      expect((error as Error).message).not.toMatch(/yelp/i);
      expectNoKeyLeak(error);
      expect(await getCached(PHONE, 'business')).toBeNull();
    });

    // Running out of credits is a capacity problem, not a broken deployment: the payer still gets a
    // dossier (without the business), and the error-level log line is how the operator finds out.
    describe('on a 403 (the monthly credits used up)', () => {
      const exhausted = () => fetchMock.mockImplementation(async () => new Response(echoingBody(), { status: 403 }));

      it('degrades to no business instead of failing the lookup, and does not cache it', async () => {
        exhausted();

        expect(await lookupYelp(PHONE)).toEqual(DEGRADED);
        expect(await getCached(PHONE, 'business')).toBeNull();
      });

      it('logs scraperapi_credits_exhausted at error level on every such lookup', async () => {
        exhausted();

        await lookupYelp(PHONE);
        await lookupYelp(PHONE);

        const lines = loggedLines();
        expect(lines).toHaveLength(2);
        for (const line of lines) {
          expect(line).toMatchObject({ level: 50, msg: 'scraperapi_credits_exhausted', vendor: 'scraperapi', status: 403 });
        }
      });

      it('logs nothing that identifies the number or a key', async () => {
        exhausted();

        await lookupYelp(PHONE);

        const text = logChunks.join('');
        for (const secret of [SCRAPER_KEY, encodeURIComponent(SCRAPER_KEY), mockEnv.YELP_API_KEY!, '2125553333']) {
          expect(text).not.toContain(secret);
        }
      });

      it('is the only status that logs it: other proxy failures degrade quietly', async () => {
        for (const status of [429, 500, 404]) {
          fetchMock.mockImplementation(async () => new Response('Request failed.', { status }));
          expect(await lookupYelp(PHONE)).toEqual(DEGRADED);
        }

        expect(loggedLines()).toEqual([]);
      });
    });
  });

  describe('when the proxied response carries a Yelp authentication failure', () => {
    // ScraperAPI's status is not Yelp's, so Yelp's own verdict is read from its error body.
    it.each([
      ['a 200', 200],
      ['a 400', 400],
    ])('throws loudly, as for a direct call, on %s whose body is Yelp\'s TOKEN_INVALID', async (_label, status) => {
      yelpReturns({ error: { code: 'TOKEN_INVALID', description: `Bad key ${mockEnv.YELP_API_KEY}` } }, status);
      const error = await lookupYelp(PHONE).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      // A Yelp failure (the message says it was seen via the proxy), not a ScraperAPI one.
      expect((error as Error).message).toMatch(/^Yelp authentication failed/);
      expect((error as Error).message).not.toMatch(/^ScraperAPI/);
      expectNoKeyLeak(error);
      expect(await getCached(PHONE, 'business')).toBeNull();
    });

    it('does not mistake other Yelp errors for an auth failure', async () => {
      yelpReturns({ error: { code: 'VALIDATION_ERROR', description: 'phone is invalid' } }, 400);

      expect(await lookupYelp(PHONE)).toEqual(DEGRADED);
    });
  });

  describe('when the proxy cannot deliver an answer', () => {
    it.each([
      ['a 429 (too many concurrent requests)', 429],
      ['a 500 (failed after ScraperAPI\'s retries)', 500],
      ['a 404', 404],
      ['a 400', 400],
    ])('degrades and does not cache on %s, with a plain-text body', async (_label, status) => {
      fetchMock.mockImplementation(async () => new Response('Request failed. You will not be charged.', { status }));

      expect(await lookupYelp(PHONE)).toEqual(DEGRADED);
      expect(await getCached(PHONE, 'business')).toBeNull();
    });

    it('degrades on a network error', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      expect(await lookupYelp(PHONE)).toEqual(DEGRADED);
    });

    it('treats a 200 that is not Yelp JSON (a captcha page, say) as a vendor gap: degraded, not cached', async () => {
      fetchMock.mockImplementation(async () => new Response('<html>captcha</html>', { status: 200 }));

      expect(await lookupYelp(PHONE)).toEqual(DEGRADED);
      expect(await getCached(PHONE, 'business')).toBeNull();
    });
  });

  // ScraperAPI's median is about 2 s, well over the 900 ms a direct Yelp call gets.
  describe('the time limit', () => {
    const hangUntilAborted = () =>
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
          }),
      );

    it('is 2.5 s, not 900 ms, and a timeout degrades without caching', async () => {
      hangUntilAborted();
      const started = Date.now();
      const result = await lookupYelp(PHONE);
      const elapsed = Date.now() - started;

      expect(result).toEqual(DEGRADED);
      expect(elapsed).toBeGreaterThanOrEqual(2450);
      expect(elapsed).toBeLessThan(3200);
      expect(await getCached(PHONE, 'business')).toBeNull();
    });

    it('lets a response that takes 1.5 s (too slow for a direct call) through', async () => {
      fetchMock.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return new Response(JSON.stringify({ businesses: [JOES] }), { status: 200 });
      });

      expect(await lookupYelp(PHONE)).toEqual({ business: JOES_MAPPED, cached: false });
    });
  });

  it('still throws a clear error, without calling anything, when YELP_API_KEY is unset', async () => {
    mockEnv.YELP_API_KEY = undefined;

    await expect(lookupYelp(PHONE)).rejects.toThrow('YELP_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
