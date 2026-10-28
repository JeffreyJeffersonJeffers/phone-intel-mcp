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
  // Unset unless a test sets them: with both set Yelp is called through the proxy, and variables
  // exported in the developer's shell must not flip the direct-call tests onto that path.
  mockEnv.YELP_PROXY_URL = undefined;
  mockEnv.YELP_PROXY_AUTH = undefined;
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

// Yelp refuses datacenter IPs (Fly's included), so with YELP_PROXY_URL and YELP_PROXY_AUTH set the
// same Yelp GET goes to our own edge function on Vercel (phone-intel-yelp-proxy), which holds the Yelp
// key and returns Yelp's response verbatim, status and body. So it is read like a direct response, with
// the proxy's own errors on top: 401 {"error":"unauthorized"} (our X-Proxy-Auth is wrong), 400
// {"error":"invalid_phone"}, 500 {"error":"misconfigured"} (its Yelp key is missing) and 502
// {"error":"upstream_failure"}. A proxy error has a string `error`; Yelp's has an object.
describe('lookupYelp through the Vercel proxy', () => {
  const PROXY_URL = 'https://proxy.example.test';
  const PROXY_AUTH = 'proxy/auth+secret=1';
  const YELP_URL = 'https://api.yelp.com/v3/businesses/search/phone?phone=%2B12125553333';
  const PROXY_REQUEST_URL = `${PROXY_URL}/api/yelp?phone=%2B12125553333`;

  beforeEach(() => {
    mockEnv.YELP_PROXY_URL = PROXY_URL;
    mockEnv.YELP_PROXY_AUTH = PROXY_AUTH;
  });

  // The upstream body echoes the credentials, as a misbehaving gateway might.
  const echoingBody = () => ({ error: `nope ${PROXY_AUTH} ${mockEnv.YELP_API_KEY}` });
  const expectNoSecretLeak = (error: unknown) => {
    const dump = inspect(error, { depth: null, showHidden: true });
    expect(dump).not.toContain(PROXY_AUTH);
    expect(dump).not.toContain(mockEnv.YELP_API_KEY!);
    expect((error as Error).cause).toBeUndefined();
  };
  const proxyReturns = (body: unknown, status: number) =>
    fetchMock.mockImplementation(
      async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );

  describe('the request', () => {
    it('is a GET to <proxy>/api/yelp?phone=<encoded> with X-Proxy-Auth and Accept, and no other header', async () => {
      mockYelp({ businesses: [] });
      await lookupYelp(PHONE);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toBe(PROXY_REQUEST_URL); // "+" is %2B, not a bare "+"
      expect(init.method ?? 'GET').toBe('GET');
      expect(init.headers).toEqual({ 'X-Proxy-Auth': PROXY_AUTH, Accept: 'application/json' });
    });

    // The proxy adds the Yelp key itself. Sending ours would put it in front of Vercel for nothing.
    it('never sends the Yelp API key or an Authorization header', async () => {
      mockYelp({ businesses: [] });
      await lookupYelp(PHONE);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(Object.keys(init.headers as Record<string, string>).map((h) => h.toLowerCase())).not.toContain('authorization');
      expect(inspect(fetchMock.mock.calls, { depth: null })).not.toContain(mockEnv.YELP_API_KEY!);
    });

    it('does not call Yelp directly', async () => {
      mockYelp({ businesses: [] });
      await lookupYelp(PHONE);

      for (const [url] of fetchMock.mock.calls as [string][]) expect(String(url)).not.toMatch(/^https:\/\/api\.yelp\.com/);
    });

    it.each(['/', '//'])('copes with a trailing %j on YELP_PROXY_URL', async (slashes) => {
      mockEnv.YELP_PROXY_URL = `${PROXY_URL}${slashes}`;
      mockYelp({ businesses: [] });
      await lookupYelp(PHONE);

      expect(String((fetchMock.mock.calls[0] as [string])[0])).toBe(PROXY_REQUEST_URL);
    });

    it('does not need YELP_API_KEY on this machine: the proxy holds it', async () => {
      mockEnv.YELP_API_KEY = undefined;
      mockYelp({ businesses: [JOES] });

      expect(await lookupYelp(PHONE)).toEqual({ business: JOES_MAPPED, cached: false });
    });

    // Half a configuration is a direct call, which is what dev machines do. On Fly that is a Yelp 403.
    it.each([
      ['only YELP_PROXY_URL', { YELP_PROXY_URL: PROXY_URL, YELP_PROXY_AUTH: undefined }],
      ['only YELP_PROXY_AUTH', { YELP_PROXY_URL: undefined, YELP_PROXY_AUTH: PROXY_AUTH }],
    ])('calls Yelp directly, with the Bearer key, when %s is set', async (_label, vars) => {
      Object.assign(mockEnv, vars);
      mockYelp({ businesses: [] });
      await lookupYelp(PHONE);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toBe(YELP_URL);
      expect(init.headers).toMatchObject({ Authorization: 'Bearer test-yelp-key' });
      expect(init.headers).not.toHaveProperty('X-Proxy-Auth');
    });
  });

  describe('a successful lookup', () => {
    it('maps and caches the business exactly like a direct call', async () => {
      mockYelp({ businesses: [JOES] });

      expect(await lookupYelp(PHONE)).toEqual({ business: JOES_MAPPED, cached: false });
      expect(await getCached(PHONE, 'business')).toEqual(JOES_MAPPED);
    });

    it('is then served from the cache without another proxy call', async () => {
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

  // These are our own mistakes (a wrong secret, a bad number, a half-set-up proxy): degrading would
  // hide them behind "no business" on every call, so they stop the lookup.
  describe('when the proxy turns our request away', () => {
    it.each([
      ['401 unauthorized: our X-Proxy-Auth is wrong', 401, { error: 'unauthorized' }, /^Yelp proxy auth failed \(HTTP 401\)/],
      ['401 with a page that is not JSON (Vercel protecting the deployment)', 401, '<html>Authentication Required</html>', /^Yelp proxy auth failed \(HTTP 401\)/],
      ['400 invalid_phone: it rejected our number', 400, { error: 'invalid_phone' }, /^Yelp proxy rejected request \(HTTP 400\)/],
      ['500 misconfigured: it has no Yelp key', 500, { error: 'misconfigured' }, /^Yelp proxy misconfigured \(HTTP 500\)/],
    ])('throws loudly on %s', async (_label, status, body, pattern) => {
      proxyReturns(body, status);
      const error = await lookupYelp(PHONE).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(pattern);
      expectNoSecretLeak(error);
      expect(await getCached(PHONE, 'business')).toBeNull();
    });

    it('does not leak the secret even when the proxy body echoes it', async () => {
      proxyReturns(echoingBody(), 401);
      const error = await lookupYelp(PHONE).catch((e: unknown) => e);

      expect((error as Error).message).toMatch(/^Yelp proxy auth failed/);
      expectNoSecretLeak(error);
    });
  });

  // The proxy passes Yelp's own answer through, so a Yelp-shaped error is Yelp speaking: the key held
  // by the proxy, not our X-Proxy-Auth.
  describe("when Yelp itself rejects the proxy's key", () => {
    it.each([
      ['401', 401],
      ['403', 403],
    ])('throws Yelp authentication failed on a %s with a Yelp error body, not a proxy auth failure', async (_label, status) => {
      yelpReturns({ error: { code: 'TOKEN_INVALID', description: `Bad key ${mockEnv.YELP_API_KEY}` } }, status);
      const error = await lookupYelp(PHONE).catch((e: unknown) => e);

      expect((error as Error).message).toBe(`Yelp authentication failed (HTTP ${status})`);
      expectNoSecretLeak(error);
      expect(await getCached(PHONE, 'business')).toBeNull();
    });
  });

  describe('when the proxy cannot deliver an answer', () => {
    it.each([
      ['502 upstream_failure: it could not reach Yelp', 502, { error: 'upstream_failure' }],
      ['504 from Vercel', 504, '<html>Gateway Timeout</html>'],
      ['429 from Yelp', 429, { error: { code: 'ACCESS_LIMIT_REACHED', description: 'slow down' } }],
      ['500 from Yelp', 500, { error: { code: 'INTERNAL_SERVER_ERROR', description: 'oops' } }],
      ['400 from Yelp (VALIDATION_ERROR)', 400, { error: { code: 'VALIDATION_ERROR', description: 'phone invalid' } }],
      ['404', 404, { error: { code: 'NOT_FOUND', description: 'nope' } }],
    ])('degrades and does not cache on %s', async (_label, status, body) => {
      proxyReturns(body, status);

      expect(await lookupYelp(PHONE)).toEqual(DEGRADED);
      expect(await getCached(PHONE, 'business')).toBeNull();
      expect(loggedLines()).toEqual([]); // quiet: only a timeout is logged
    });

    it('degrades on a network error', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      expect(await lookupYelp(PHONE)).toEqual(DEGRADED);
    });

    it('treats a 200 that is not Yelp JSON as a vendor gap: degraded, not cached', async () => {
      proxyReturns('<html>oops</html>', 200);

      expect(await lookupYelp(PHONE)).toEqual(DEGRADED);
      expect(await getCached(PHONE, 'business')).toBeNull();
    });
  });

  // The edge function is fast (typically well under a second), so the limit is a little over a direct
  // call's 900 ms, to absorb the extra hop.
  describe('the time limit', () => {
    const hangUntilAborted = () =>
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
          }),
      );

    it('is 2.5 s, and a timeout degrades without caching', async () => {
      hangUntilAborted();
      const started = Date.now();
      const result = await lookupYelp(PHONE);
      const elapsed = Date.now() - started;

      expect(result).toEqual(DEGRADED);
      expect(elapsed).toBeGreaterThanOrEqual(2450);
      expect(elapsed).toBeLessThan(3200);
      expect(await getCached(PHONE, 'business')).toBeNull();
    });

    it('logs yelp_timeout (warn) with the limit and that the call was proxied', async () => {
      hangUntilAborted();

      await lookupYelp(PHONE);

      expect(loggedLines()).toEqual([
        expect.objectContaining({ level: 40, msg: 'yelp_timeout', vendor: 'yelp', proxied: true, timeout_ms: 2500 }),
      ]);
      const text = logChunks.join('');
      for (const secret of [PROXY_AUTH, mockEnv.YELP_API_KEY!, '2125553333']) expect(text).not.toContain(secret);
    });

    it('also logs a direct call timing out, as not proxied with the 900 ms limit', async () => {
      mockEnv.YELP_PROXY_URL = undefined;
      mockEnv.YELP_PROXY_AUTH = undefined;
      hangUntilAborted();

      await lookupYelp(PHONE);

      expect(loggedLines()).toEqual([
        expect.objectContaining({ level: 40, msg: 'yelp_timeout', vendor: 'yelp', proxied: false, timeout_ms: 900 }),
      ]);
    });

    it('lets a response that takes 1.5 s (too slow for a direct call) through', async () => {
      fetchMock.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return new Response(JSON.stringify({ businesses: [JOES] }), { status: 200 });
      });

      expect(await lookupYelp(PHONE)).toEqual({ business: JOES_MAPPED, cached: false });
    });

    it('does not log a timeout for a network error', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await lookupYelp(PHONE);

      expect(loggedLines()).toEqual([]);
    });
  });
});
