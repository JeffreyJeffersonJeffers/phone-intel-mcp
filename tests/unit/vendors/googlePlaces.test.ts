import { inspect } from 'node:util';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCached, setCached } from '../../../src/cache/cache.js';
import { enrichFromGoogle } from '../../../src/vendors/googlePlaces.js';

// Google Places is mocked (the SDK client: no network, no spend); the cache is the real Supabase
// Postgres, same as the Task 3-5 tests, so cache behaviour here is exercised end to end.
const { findPlaceMock, detailsMock, mockEnv } = vi.hoisted(() => ({
  findPlaceMock: vi.fn(),
  detailsMock: vi.fn(),
  mockEnv: {} as Record<string, string | undefined>,
}));

vi.mock('@googlemaps/google-maps-services-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@googlemaps/google-maps-services-js')>();
  return {
    ...actual,
    // `function`, not an arrow: the adapter calls this with `new`.
    Client: vi.fn(function () {
      return { findPlaceFromText: findPlaceMock, placeDetails: detailsMock };
    }),
  };
});

// vitest.config.ts deliberately keeps vendor keys out of the test env, so inject a fake one.
vi.mock('../../../src/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/env.js')>();
  Object.assign(mockEnv, actual.env, { GOOGLE_PLACES_API_KEY: 'test-google-key' });
  return { ...actual, env: mockEnv };
});

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set: the cache round-trip needs the real Supabase database (.env.local)');
}
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 });

// Distinct from the numbers in the other test files (+15165551234..6, +15165559401, +12125553333):
// all files share one database and vitest runs them in parallel, so a shared fixture would let
// their cleanups race.
const PHONE = '+19175551212';
const NULLS = { hours: null, is_open_now: null, rating: null, place_id: null, cached: false };

const INPUT = {
  yelpName: "Joe's Pizza",
  yelpAddressLine1: '7 Carmine St',
  yelpCity: 'New York',
  yelpState: 'NY',
  phoneE164: PHONE,
};

const PLACE_ID = 'ChIJjoes';

// Google "periods": day 0 = Sunday, time is "HHMM". Close defaults to the same day.
const period = (day: number, open: string, close: string, closeDay = day) => ({
  open: { day, time: open },
  close: { day: closeDay, time: close },
});
const WEEKDAY_PERIODS = [1, 2, 3, 4, 5].map((day) => period(day, '0900', '1700'));
const NINE_TO_FIVE = [{ open: '09:00', close: '17:00' }];
const WEEKDAY_HOURS = {
  sunday: [],
  monday: NINE_TO_FIVE,
  tuesday: NINE_TO_FIVE,
  wednesday: NINE_TO_FIVE,
  thursday: NINE_TO_FIVE,
  friday: NINE_TO_FIVE,
  saturday: [],
};

const JOES_DETAILS = {
  place_id: PLACE_ID,
  rating: 4.4,
  user_ratings_total: 3120,
  opening_hours: { open_now: false, periods: WEEKDAY_PERIODS },
  current_opening_hours: { open_now: true, periods: WEEKDAY_PERIODS },
};
const JOES_ENRICHED = {
  hours: WEEKDAY_HOURS,
  is_open_now: true,
  rating: { stars: 4.4, count: 3120 },
  place_id: PLACE_ID,
  cached: false,
};

// What the SDK resolves with on success: an axios response whose body is Google's JSON.
const findPlaceReturns = (candidates: unknown) =>
  findPlaceMock.mockResolvedValue({
    data: { status: Array.isArray(candidates) && candidates.length ? 'OK' : 'ZERO_RESULTS', candidates },
  });
const detailsReturn = (result: unknown) =>
  detailsMock.mockResolvedValue({ data: { status: 'OK', result, html_attributions: [] } });
const mockGoogle = (result: unknown = JOES_DETAILS) => {
  findPlaceReturns([{ place_id: PLACE_ID }]);
  detailsReturn(result);
};

// What the SDK rejects with on an HTTP-level failure. Like the real AxiosError it carries the
// request config, key included, so the tests can prove the adapter never forwards it.
const sdkError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    status,
    response: { status, data: { status: 'REQUEST_DENIED', error_message: `Bad key ${mockEnv.GOOGLE_PLACES_API_KEY}` } },
    config: { params: { key: mockEnv.GOOGLE_PLACES_API_KEY } },
  });

// A real axios call rejects with a CanceledError when its signal fires; the mock does the same.
const hangUntilAborted = (mock: typeof findPlaceMock) =>
  mock.mockImplementation(
    (request: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' })),
        );
      }),
  );

const backdate = (field: 'hours' | 'enrichment', interval: string) =>
  sql`UPDATE phone_lookups SET ${sql(`${field}_cached_at`)} = now() - ${interval}::interval WHERE phone_e164 = ${PHONE}`;

beforeEach(() => {
  findPlaceMock.mockReset();
  detailsMock.mockReset();
  mockEnv.GOOGLE_PLACES_API_KEY = 'test-google-key';
});
afterEach(async () => {
  await sql`DELETE FROM phone_lookups WHERE phone_e164 = ${PHONE}`;
});
afterAll(() => sql.end());

describe('enrichFromGoogle mapping', () => {
  it('returns hours, open_now, rating and place_id when Place Details hits', async () => {
    mockGoogle();
    expect(await enrichFromGoogle(INPUT)).toEqual(JOES_ENRICHED);
  });

  it('returns null fields when there is no Google match', async () => {
    findPlaceReturns([]);
    expect(await enrichFromGoogle({ ...INPUT, yelpName: 'Nonsense', yelpAddressLine1: '', yelpCity: '', yelpState: '' })).toEqual(
      NULLS,
    );
    expect(detailsMock).not.toHaveBeenCalled();
  });

  it('finds the place by "<name> <address1> <city> <state>", then fetches only the needed detail fields', async () => {
    mockGoogle();
    await enrichFromGoogle(INPUT);

    expect(findPlaceMock).toHaveBeenCalledTimes(1);
    expect(findPlaceMock.mock.calls[0][0].params).toMatchObject({
      input: "Joe's Pizza 7 Carmine St New York NY",
      inputtype: 'textquery',
      key: 'test-google-key',
    });
    expect(detailsMock).toHaveBeenCalledTimes(1);
    const { params } = detailsMock.mock.calls[0][0];
    expect(params).toMatchObject({ place_id: PLACE_ID, key: 'test-google-key' });
    // Place Details bills per field group, and omitting `fields` returns (and bills) everything.
    expect([...params.fields].sort()).toEqual(
      ['current_opening_hours', 'opening_hours', 'place_id', 'rating', 'user_ratings_total'].sort(),
    );
  });

  it('leaves empty address parts out of the query instead of leaving double spaces', async () => {
    findPlaceReturns([]);
    await enrichFromGoogle({ ...INPUT, yelpAddressLine1: '', yelpCity: 'New York', yelpState: '' });
    expect(findPlaceMock.mock.calls[0][0].params.input).toBe("Joe's Pizza New York");
  });

  it('sends a shared abort signal and disables SDK retries on both calls', async () => {
    mockGoogle();
    await enrichFromGoogle(INPUT);

    const first = findPlaceMock.mock.calls[0][0];
    const second = detailsMock.mock.calls[0][0];
    expect(first.signal).toBeInstanceOf(AbortSignal);
    // One deadline for the pair: both calls must see the same signal.
    expect(second.signal).toBe(first.signal);
    // The SDK retries 5xx by default, which would double-bill Google and eat the budget.
    expect(first.raxConfig).toEqual({ retry: 0 });
    expect(second.raxConfig).toEqual({ retry: 0 });
  });

  it.each([
    ['current_opening_hours wins over opening_hours', { current: { open_now: true }, regular: { open_now: false } }, true],
    ['a current false wins over a regular true', { current: { open_now: false }, regular: { open_now: true } }, false],
    ['falls back to opening_hours when current_opening_hours is absent', { regular: { open_now: false } }, false],
    ['falls back to opening_hours when current open_now is missing', { current: {}, regular: { open_now: true } }, true],
    ['is null when neither says', { current: {}, regular: {} }, null],
    ['is null when there is no hours data at all', {}, null],
  ])('is_open_now: %s', async (_label, hours, expected) => {
    const { current, regular } = hours as { current?: object; regular?: object };
    mockGoogle({ place_id: PLACE_ID, current_opening_hours: current, opening_hours: regular });
    expect((await enrichFromGoogle(INPUT)).is_open_now).toBe(expected);
  });

  it.each([
    ['rating present', { rating: 4.4, user_ratings_total: 3120 }, { stars: 4.4, count: 3120 }],
    ['rating 0 (a number, not missing)', { rating: 0, user_ratings_total: 0 }, { stars: 0, count: 0 }],
    ['count missing', { rating: 4.4 }, { stars: 4.4, count: 0 }],
    ['rating absent', { user_ratings_total: 12 }, null],
    ['rating a string', { rating: '4.4', user_ratings_total: 12 }, null],
  ])('rating: %s', async (_label, fields, expected) => {
    mockGoogle({ place_id: PLACE_ID, ...fields });
    expect((await enrichFromGoogle(INPUT)).rating).toEqual(expected);
  });

  it('falls back to the Find Place id when Place Details omits place_id', async () => {
    mockGoogle({ rating: 4.4, user_ratings_total: 10 });
    expect((await enrichFromGoogle(INPUT)).place_id).toBe(PLACE_ID);
  });

  it('returns hours null, but still rating and place_id, when Google has no hours for the place', async () => {
    mockGoogle({ place_id: PLACE_ID, rating: 4.4, user_ratings_total: 10 });
    expect(await enrichFromGoogle(INPUT)).toEqual({
      hours: null,
      is_open_now: null,
      rating: { stars: 4.4, count: 10 },
      place_id: PLACE_ID,
      cached: false,
    });
  });
});

describe('enrichFromGoogle hours mapping', () => {
  const hoursFor = async (periods: unknown) => {
    mockGoogle({ place_id: PLACE_ID, opening_hours: { periods } });
    return (await enrichFromGoogle(INPUT)).hours;
  };

  it('maps day numbers to names and "HHMM" to "HH:MM", with [] for days with no period', async () => {
    expect(await hoursFor(WEEKDAY_PERIODS)).toEqual(WEEKDAY_HOURS);
  });

  it('keeps several periods on one day (split shifts) in order', async () => {
    const hours = await hoursFor([period(6, '0900', '1200'), period(6, '1500', '2100')]);
    expect(hours?.saturday).toEqual([
      { open: '09:00', close: '12:00' },
      { open: '15:00', close: '21:00' },
    ]);
  });

  it('files an overnight period under the day it opens, keeping its real close time', async () => {
    const hours = await hoursFor([period(5, '1800', '0200', 6)]);
    expect(hours?.friday).toEqual([{ open: '18:00', close: '02:00' }]);
    expect(hours?.saturday).toEqual([]);
  });

  it('maps a place that is always open (one period, no close) to every day', async () => {
    const hours = await hoursFor([{ open: { day: 0, time: '0000' } }]);
    expect(Object.keys(hours ?? {}).sort()).toEqual(
      ['friday', 'monday', 'saturday', 'sunday', 'thursday', 'tuesday', 'wednesday'],
    );
    for (const day of Object.values(hours ?? {})) expect(day).toEqual([{ open: '00:00', close: '23:59' }]);
  });

  it('skips malformed periods and keeps the good ones', async () => {
    const hours = await hoursFor([
      { open: { day: 9, time: '0900' }, close: { day: 9, time: '1700' } }, // day out of range
      { open: { day: 1, time: '9am' }, close: { day: 1, time: '1700' } }, // time not HHMM
      { open: { day: 2, time: '0900' } }, // no close, but not an always-open place
      { open: { day: 3, time: '0900' }, close: { day: 3, time: '1700' } },
    ]);
    expect(hours).toEqual({ ...Object.fromEntries(Object.keys(WEEKDAY_HOURS).map((d) => [d, []])), wednesday: NINE_TO_FIVE });
  });

  it.each([
    ['periods absent', undefined],
    ['periods empty', []],
    ['periods not an array', 'Mon-Fri 9-5'],
    ['every period malformed', [{ open: { day: 1 } }]],
  ])('returns hours null when %s', async (_label, periods) => {
    expect(await hoursFor(periods)).toBeNull();
  });

  it('uses current_opening_hours periods when opening_hours has none', async () => {
    mockGoogle({ place_id: PLACE_ID, current_opening_hours: { open_now: true, periods: WEEKDAY_PERIODS } });
    expect((await enrichFromGoogle(INPUT)).hours).toEqual(WEEKDAY_HOURS);
  });
});

describe('enrichFromGoogle cache', () => {
  it('serves a repeat call from cache with no Google calls', async () => {
    mockGoogle();
    const first = await enrichFromGoogle(INPUT);
    const second = await enrichFromGoogle(INPUT);

    expect(first.cached).toBe(false);
    expect(second).toEqual({ ...JOES_ENRICHED, cached: true });
    expect(findPlaceMock).toHaveBeenCalledTimes(1);
    expect(detailsMock).toHaveBeenCalledTimes(1);
  });

  it('splits what it stores: rating and place_id under enrichment (7 d), hours and open-now under hours (1 h)', async () => {
    mockGoogle();
    await enrichFromGoogle(INPUT);

    // Hours must not sit in the 7-day field: the global constraint caps hours/is-open-now at 1 h.
    expect(await getCached(PHONE, 'enrichment')).toEqual({ rating: { stars: 4.4, count: 3120 }, place_id: PLACE_ID });
    expect(await getCached(PHONE, 'hours')).toEqual({ hours: WEEKDAY_HOURS, is_open_now: true });
  });

  it('leaves the Yelp business field alone', async () => {
    await setCached(PHONE, 'business', { name: 'Yelp owns this' });
    mockGoogle();
    await enrichFromGoogle(INPUT);
    expect(await getCached(PHONE, 'business')).toEqual({ name: 'Yelp owns this' });
  });

  it('re-fetches both calls when hours has expired but enrichment is still fresh, and refreshes both caches', async () => {
    mockGoogle();
    await enrichFromGoogle(INPUT);
    await backdate('hours', '61 minutes');
    await backdate('enrichment', '3 days');

    detailsReturn({ ...JOES_DETAILS, rating: 4.6, current_opening_hours: { open_now: false, periods: WEEKDAY_PERIODS } });
    const result = await enrichFromGoogle(INPUT);

    expect(result).toMatchObject({ cached: false, is_open_now: false, rating: { stars: 4.6, count: 3120 } });
    expect(findPlaceMock).toHaveBeenCalledTimes(2);
    expect(detailsMock).toHaveBeenCalledTimes(2);
    expect(await getCached(PHONE, 'hours')).toEqual({ hours: WEEKDAY_HOURS, is_open_now: false });
    expect(await getCached(PHONE, 'enrichment')).toMatchObject({ rating: { stars: 4.6, count: 3120 } });
    // The refresh is a real one: the 3-day-old enrichment row was rewritten, not left to age out.
    const [row] = await sql`SELECT extract(epoch FROM now() - enrichment_cached_at)::float8 AS age FROM phone_lookups WHERE phone_e164 = ${PHONE}`;
    expect(row.age).toBeLessThan(60);
  });

  it('re-fetches when enrichment has expired even though hours is still fresh', async () => {
    mockGoogle();
    await enrichFromGoogle(INPUT);
    await backdate('enrichment', '7 days 1 hour');

    const result = await enrichFromGoogle(INPUT);
    expect(result.cached).toBe(false);
    expect(findPlaceMock).toHaveBeenCalledTimes(2);
  });

  it('caches "no Google match" as { matched: false } under enrichment so a repeat call is served from cache', async () => {
    findPlaceReturns([]);
    expect(await enrichFromGoogle(INPUT)).toEqual(NULLS);
    expect(await getCached(PHONE, 'enrichment')).toEqual({ matched: false });
    expect(await getCached(PHONE, 'hours')).toBeNull();

    expect(await enrichFromGoogle(INPUT)).toEqual({ ...NULLS, cached: true });
    expect(findPlaceMock).toHaveBeenCalledTimes(1);
  });

  it('retries Google once the "no match" sentinel has expired', async () => {
    findPlaceReturns([]);
    await enrichFromGoogle(INPUT);
    await backdate('enrichment', '7 days 1 hour');

    mockGoogle();
    expect(await enrichFromGoogle(INPUT)).toEqual(JOES_ENRICHED);
    expect(findPlaceMock).toHaveBeenCalledTimes(2);
  });

  it('caches a place with no hours, so the repeat call is a hit that still reports hours null', async () => {
    mockGoogle({ place_id: PLACE_ID, rating: 4.4, user_ratings_total: 10 });
    await enrichFromGoogle(INPUT);

    const second = await enrichFromGoogle(INPUT);
    expect(second).toEqual({ hours: null, is_open_now: null, rating: { stars: 4.4, count: 10 }, place_id: PLACE_ID, cached: true });
    expect(findPlaceMock).toHaveBeenCalledTimes(1);
  });
});

describe('enrichFromGoogle failure handling', () => {
  const expectNothingCached = async () => {
    expect(await getCached(PHONE, 'enrichment')).toBeNull();
    expect(await getCached(PHONE, 'hours')).toBeNull();
  };

  it('returns degraded within the 900ms budget when Find Place hangs, and does not cache it', async () => {
    hangUntilAborted(findPlaceMock);
    const started = Date.now();
    const result = await enrichFromGoogle(INPUT);
    const elapsed = Date.now() - started;

    expect(result).toEqual(NULLS);
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThan(1500);
    expect(detailsMock).not.toHaveBeenCalled();
    await expectNothingCached();
  });

  it('enforces 900ms across both calls, not 900ms each', async () => {
    // Find Place answers after ~500ms, then Place Details hangs: it gets the ~400ms that are left.
    findPlaceMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ data: { status: 'OK', candidates: [{ place_id: PLACE_ID }] } }), 500)),
    );
    hangUntilAborted(detailsMock);
    const started = Date.now();
    const result = await enrichFromGoogle(INPUT);
    const elapsed = Date.now() - started;

    expect(result).toEqual(NULLS);
    expect(detailsMock).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThan(1300); // two full 900ms budgets would be ~1400ms
    await expectNothingCached();
  });

  it('retries Google on the next call after a timeout instead of serving a poisoned cache', async () => {
    hangUntilAborted(findPlaceMock);
    await enrichFromGoogle(INPUT);

    findPlaceMock.mockReset();
    mockGoogle();
    expect(await enrichFromGoogle(INPUT)).toEqual(JOES_ENRICHED);
  });

  it.each([
    ['a 500', 500],
    ['a 503', 503],
    ['a 429 rate limit', 429],
    ['a 400', 400],
    ['a 404', 404],
  ])('returns degraded and does not cache on %s from Find Place', async (_label, status) => {
    findPlaceMock.mockRejectedValue(sdkError(status));
    expect(await enrichFromGoogle(INPUT)).toEqual(NULLS);
    expect(detailsMock).not.toHaveBeenCalled();
    await expectNothingCached();
  });

  it.each([
    ['a 500', 500],
    ['a 429 rate limit', 429],
    ['a 404 (place no longer exists)', 404],
  ])('returns degraded and does not cache on %s from Place Details, even though Find Place succeeded', async (_label, status) => {
    findPlaceReturns([{ place_id: PLACE_ID }]);
    detailsMock.mockRejectedValue(sdkError(status));
    expect(await enrichFromGoogle(INPUT)).toEqual(NULLS);
    await expectNothingCached();
  });

  it('returns degraded and does not cache on a network error', async () => {
    findPlaceMock.mockRejectedValue(new TypeError('socket hang up'));
    expect(await enrichFromGoogle(INPUT)).toEqual(NULLS);
    await expectNothingCached();
  });

  it.each([
    ['candidates is not an array', () => findPlaceMock.mockResolvedValue({ data: { status: 'OK' } })],
    ['the first candidate has no place_id', () => findPlaceReturns([{ name: 'No id' }])],
    ['Place Details returns no result', () => (findPlaceReturns([{ place_id: PLACE_ID }]), detailsReturn(undefined))],
  ])('treats %s as a vendor gap: degraded and not cached (not a confirmed miss)', async (_label, arrange) => {
    arrange();
    expect(await enrichFromGoogle(INPUT)).toEqual(NULLS);
    await expectNothingCached();
  });

  it.each([
    ['Find Place 401', () => findPlaceMock.mockRejectedValue(sdkError(401)), /google.*(401|auth)/i],
    ['Find Place 403', () => findPlaceMock.mockRejectedValue(sdkError(403)), /google.*(403|auth)/i],
    [
      'Place Details 403',
      () => (findPlaceReturns([{ place_id: PLACE_ID }]), detailsMock.mockRejectedValue(sdkError(403))),
      /google.*(403|auth)/i,
    ],
  ])('throws loudly on %s instead of degrading, without leaking the key', async (_label, arrange, pattern) => {
    arrange();
    const error = await enrichFromGoogle(INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(pattern);
    // Status only: the SDK error carries the request (key included) in `config`, so the original
    // must not appear in the message, a `cause` chain, or any other property.
    expect(inspect(error, { depth: null, showHidden: true })).not.toContain(mockEnv.GOOGLE_PLACES_API_KEY);
    expect((error as Error).cause).toBeUndefined();
    await expectNothingCached();
  });

  it('throws a clear error, without calling Google, when GOOGLE_PLACES_API_KEY is unset', async () => {
    mockEnv.GOOGLE_PLACES_API_KEY = undefined;
    await expect(enrichFromGoogle(INPUT)).rejects.toThrow('GOOGLE_PLACES_API_KEY');
    expect(findPlaceMock).not.toHaveBeenCalled();
  });
});
