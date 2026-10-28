import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeDossier } from '../../../src/dossier/compose.js';
import { enrichFromGoogle, type GoogleEnrichment } from '../../../src/vendors/googlePlaces.js';
import { lookupReputation, type ReputationLookup } from '../../../src/vendors/ipqs.js';
import { lookupTwilio, type TwilioLookup } from '../../../src/vendors/twilio.js';
import { lookupYelp, type YelpLookup } from '../../../src/vendors/yelp.js';

// All four adapters are mocked, so this file tests compose's own logic: fan-out, classification,
// mapping, cached_fields and the loud-failure rule. The adapters' real timeouts and degrade
// behaviour are covered in tests/unit/vendors/*; the two together are in composeHang.test.ts.
vi.mock('../../../src/vendors/twilio.js', () => ({ lookupTwilio: vi.fn() }));
vi.mock('../../../src/vendors/yelp.js', () => ({ lookupYelp: vi.fn() }));
vi.mock('../../../src/vendors/googlePlaces.js', () => ({ enrichFromGoogle: vi.fn() }));
vi.mock('../../../src/vendors/ipqs.js', () => ({ lookupReputation: vi.fn() }));

const BUSINESS_PHONE = '+12125553333';
const MOBILE_PHONE = '+15165551234';
const NEUTRAL_PHONE = '+16175551234';

const HOURS = { monday: [{ open: '09:00', close: '17:00' }], tuesday: [] };

// What each adapter returns when it succeeds fresh, and what it returns after its own 900 ms
// timeout (a FULFILLED result with safe defaults, never a rejection).
const twilioOk = (over: Partial<TwilioLookup> = {}): TwilioLookup => ({
  carrier: { name: 'Verizon', type: 'landline' },
  caller_name: 'JOES PIZZA',
  cached: false,
  ...over,
});
const twilioDegraded: TwilioLookup = { carrier: { name: null, type: 'unknown' }, caller_name: null, cached: false };

const yelpHit = (cached = false): YelpLookup => ({
  business: {
    name: "Joe's Pizza",
    category: 'Pizza',
    yelp_id: 'joes-pizza-new-york',
    address: { line1: '1 Main St', city: 'New York', state: 'NY', postal: '10001' },
    rating: { stars: 4.5, count: 120 },
  },
  cached,
});
const yelpMiss: YelpLookup = { business: null, cached: false };

const googleOk = (over: Partial<GoogleEnrichment> = {}): GoogleEnrichment => ({
  hours: HOURS,
  is_open_now: true,
  rating: { stars: 4.2, count: 300 },
  place_id: 'ChIJ-joes',
  cached: false,
  ...over,
});
const googleDegraded: GoogleEnrichment = { hours: null, is_open_now: null, rating: null, place_id: null, cached: false };

const ipqsOk = (over: Partial<ReputationLookup> = {}): ReputationLookup => ({
  spam_risk_score: 2,
  is_known_robocall: false,
  is_dnc_listed: false,
  is_voip_risk: false,
  cached: false,
  ...over,
});
const ipqsDegraded: ReputationLookup = {
  spam_risk_score: 0,
  is_known_robocall: false,
  is_dnc_listed: null,
  is_voip_risk: false,
  cached: false,
};

interface Vendors {
  twilio?: TwilioLookup | (() => Promise<TwilioLookup>);
  yelp?: YelpLookup | (() => Promise<YelpLookup>);
  google?: GoogleEnrichment | (() => Promise<GoogleEnrichment>);
  ipqs?: ReputationLookup | (() => Promise<ReputationLookup>);
}

// Each mock resolves with the given value, or runs the given function (to delay, or to reject).
function mockVendors({ twilio = twilioOk(), yelp = yelpMiss, google = googleOk(), ipqs = ipqsOk() }: Vendors = {}): void {
  const run = <T>(v: T | (() => Promise<T>)) => (typeof v === 'function' ? (v as () => Promise<T>)() : Promise.resolve(v));
  vi.mocked(lookupTwilio).mockImplementation(() => run(twilio));
  vi.mocked(lookupYelp).mockImplementation(() => run(yelp));
  vi.mocked(enrichFromGoogle).mockImplementation(() => run(google));
  vi.mocked(lookupReputation).mockImplementation(() => run(ipqs));
}

const delayed =
  <T>(ms: number, value: T) =>
  () =>
    new Promise<T>((resolve) => setTimeout(resolve, ms, value));
const rejects = (message: string) => () => Promise.reject(new Error(message));

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('composeDossier: business', () => {
  it('composes a business dossier when Yelp matches', async () => {
    mockVendors({ twilio: twilioOk(), yelp: yelpHit(), google: googleOk(), ipqs: ipqsOk() });

    const d = await composeDossier(BUSINESS_PHONE);

    expect(d.phone).toBe(BUSINESS_PHONE);
    expect(d.number_classification).toBe('business');
    expect(d.carrier).toEqual({ name: 'Verizon', type: 'landline' });
    expect(d.caller_name).toBe('JOES PIZZA');
    expect(d.business_match).toEqual({
      name: "Joe's Pizza",
      category: 'Pizza',
      address: { line1: '1 Main St', city: 'New York', state: 'NY', postal: '10001' },
      hours: HOURS,
      is_open_now: true,
      rating: { stars: 4.2, count: 300 },
      place_id: 'ChIJ-joes',
      yelp_id: 'joes-pizza-new-york',
    });
  });

  it('returns reputation without the adapter-internal cached flag', async () => {
    mockVendors({ yelp: yelpHit(), ipqs: ipqsOk({ spam_risk_score: 2, is_dnc_listed: true, cached: true }) });
    const d = await composeDossier(BUSINESS_PHONE);
    expect(d.reputation).toEqual({ spam_risk_score: 2, is_known_robocall: false, is_dnc_listed: true, is_voip_risk: false });
  });

  it('calls every adapter with the phone, and Google with the Yelp fields plus phoneE164', async () => {
    mockVendors({ yelp: yelpHit() });

    await composeDossier(BUSINESS_PHONE);

    expect(lookupTwilio).toHaveBeenCalledExactlyOnceWith(BUSINESS_PHONE);
    expect(lookupYelp).toHaveBeenCalledExactlyOnceWith(BUSINESS_PHONE);
    expect(lookupReputation).toHaveBeenCalledExactlyOnceWith(BUSINESS_PHONE);
    expect(enrichFromGoogle).toHaveBeenCalledExactlyOnceWith({
      yelpName: "Joe's Pizza",
      yelpAddressLine1: '1 Main St',
      yelpCity: 'New York',
      yelpState: 'NY',
      phoneE164: BUSINESS_PHONE,
    });
  });

  it.each([
    ['voip', 'voip'],
    ['mobile', 'mobile'],
    ['tollFree', 'tollFree'],
    ['unknown', 'unknown'],
  ] as const)('a Yelp match wins over a %s line type', async (_label, type) => {
    mockVendors({ twilio: twilioOk({ carrier: { name: 'X', type } }), yelp: yelpHit() });
    expect((await composeDossier(BUSINESS_PHONE)).number_classification).toBe('business');
  });

  it('takes the rating from Google, falls back to Yelp, and is null when neither has one', async () => {
    mockVendors({ yelp: yelpHit(), google: googleOk({ rating: { stars: 3.9, count: 7 } }) });
    expect((await composeDossier(BUSINESS_PHONE)).business_match?.rating).toEqual({ stars: 3.9, count: 7 });

    mockVendors({ yelp: yelpHit(), google: googleOk({ rating: null }) });
    expect((await composeDossier(BUSINESS_PHONE)).business_match?.rating).toEqual({ stars: 4.5, count: 120 });

    const noYelpRating = yelpHit();
    noYelpRating.business!.rating = null;
    mockVendors({ yelp: noYelpRating, google: googleOk({ rating: null }) });
    expect((await composeDossier(BUSINESS_PHONE)).business_match?.rating).toBeNull();
  });

  it('keeps the Yelp half of business_match and nulls the Google half when Google found nothing', async () => {
    mockVendors({ yelp: yelpHit(), google: googleDegraded });

    const d = await composeDossier(BUSINESS_PHONE);

    expect(d.number_classification).toBe('business');
    expect(d.business_match).toMatchObject({
      name: "Joe's Pizza",
      category: 'Pizza',
      yelp_id: 'joes-pizza-new-york',
      hours: null,
      is_open_now: null,
      place_id: null,
    });
  });
});

describe('composeDossier: no Yelp match', () => {
  it('returns consumer_mobile with null business_match on no Yelp hit + mobile line type', async () => {
    mockVendors({ twilio: twilioOk({ carrier: { name: 'T-Mobile', type: 'mobile' }, caller_name: null }), yelp: yelpMiss });

    const d = await composeDossier(MOBILE_PHONE);

    expect(d.number_classification).toBe('consumer_mobile');
    expect(d.business_match).toBeNull();
    expect(d.carrier).toEqual({ name: 'T-Mobile', type: 'mobile' });
    expect(d.reputation.spam_risk_score).toBe(2);
  });

  it('skips Google entirely when Yelp has no business', async () => {
    mockVendors({ yelp: yelpMiss });
    await composeDossier(MOBILE_PHONE);
    expect(enrichFromGoogle).not.toHaveBeenCalled();
  });

  it.each([
    ['mobile', 'consumer_mobile'],
    ['landline', 'consumer_landline'],
    ['voip', 'voip'],
    ['tollFree', 'toll_free'],
    ['unknown', 'unknown'],
  ] as const)('classifies a %s line type with no Yelp match as %s', async (type, expected) => {
    mockVendors({ twilio: twilioOk({ carrier: { name: 'X', type } }), yelp: yelpMiss });
    expect((await composeDossier(NEUTRAL_PHONE)).number_classification).toBe(expected);
  });
});

describe('composeDossier: meta', () => {
  it('stamps schema_version v1, a fresh UUID v4 lookup_id and an ISO timestamp', async () => {
    mockVendors();
    const before = Date.now();
    const a = await composeDossier(NEUTRAL_PHONE);
    const b = await composeDossier(NEUTRAL_PHONE);

    expect(a.meta.schema_version).toBe('v1');
    expect(a.meta.lookup_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b.meta.lookup_id).not.toBe(a.meta.lookup_id);
    expect(new Date(a.meta.timestamp).toISOString()).toBe(a.meta.timestamp);
    expect(Date.parse(a.meta.timestamp)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(a.meta.timestamp)).toBeLessThanOrEqual(Date.now());
  });

  it('has an empty cached_fields when every adapter fetched fresh', async () => {
    mockVendors({ yelp: yelpHit(false), google: googleOk({ cached: false }) });
    expect((await composeDossier(BUSINESS_PHONE)).meta.cached_fields).toEqual([]);
  });

  it('lists carrier, business, enrichment, hours and reputation when all five came from cache', async () => {
    mockVendors({
      twilio: twilioOk({ cached: true }),
      yelp: yelpHit(true),
      google: googleOk({ cached: true }),
      ipqs: ipqsOk({ cached: true }),
    });
    const { cached_fields } = (await composeDossier(BUSINESS_PHONE)).meta;
    expect([...cached_fields].sort()).toEqual(['business', 'carrier', 'enrichment', 'hours', 'reputation']);
  });

  it.each([
    ['carrier', { twilio: twilioOk({ cached: true }) }],
    ['reputation', { ipqs: ipqsOk({ cached: true }) }],
  ] as const)('lists only %s when only that adapter was cached', async (field, vendors) => {
    mockVendors({ yelp: yelpHit(false), google: googleOk({ cached: false }), ...vendors });
    expect((await composeDossier(BUSINESS_PHONE)).meta.cached_fields).toEqual([field]);
  });

  it('lists business, and neither Google field, when Google was cached but never called', async () => {
    // A cached Yelp *miss* (cached: true, business: null) must not drag Google into the list.
    mockVendors({ yelp: { business: null, cached: true }, google: googleOk({ cached: true }) });
    const d = await composeDossier(MOBILE_PHONE);
    expect(d.meta.cached_fields).toEqual(['business']);
  });
});

describe('composeDossier: vendor degrade (adapter returns safe defaults)', () => {
  it('fills carrier with unknown and still returns the other sections when Twilio degraded', async () => {
    mockVendors({ twilio: twilioDegraded, yelp: yelpHit(), google: googleOk() });

    const d = await composeDossier(BUSINESS_PHONE);

    expect(d.carrier).toEqual({ name: null, type: 'unknown' });
    expect(d.caller_name).toBeNull();
    expect(d.number_classification).toBe('business');
    expect(d.business_match?.name).toBe("Joe's Pizza");
    expect(d.reputation.spam_risk_score).toBe(2);
    expect(d.meta.cached_fields).toEqual([]);
  });

  it('hands back its own carrier object, so editing a dossier cannot corrupt the adapter shared default', async () => {
    mockVendors({ twilio: twilioDegraded });
    const d = await composeDossier(NEUTRAL_PHONE);
    expect(d.carrier).toEqual(twilioDegraded.carrier);
    expect(d.carrier).not.toBe(twilioDegraded.carrier);
  });

  it('returns neutral reputation defaults when IPQS degraded', async () => {
    mockVendors({ yelp: yelpHit(), ipqs: ipqsDegraded });
    const d = await composeDossier(BUSINESS_PHONE);
    expect(d.reputation).toEqual({
      spam_risk_score: 0,
      is_known_robocall: false,
      is_dnc_listed: null,
      is_voip_risk: false,
    });
  });

  it('still returns an unknown dossier when every adapter degraded', async () => {
    mockVendors({ twilio: twilioDegraded, yelp: yelpMiss, ipqs: ipqsDegraded });
    const d = await composeDossier(NEUTRAL_PHONE);
    expect(d.number_classification).toBe('unknown');
    expect(d.business_match).toBeNull();
    expect(d.carrier.type).toBe('unknown');
    expect(d.meta.schema_version).toBe('v1');
  });
});

describe('composeDossier: vendor failure (adapter throws) is loud', () => {
  it.each([
    ['Twilio', { twilio: rejects('Twilio authentication failed (HTTP 401, Twilio code 20003)') }, 'Twilio authentication failed'],
    ['Yelp', { yelp: rejects('Yelp authentication failed (HTTP 401)') }, 'Yelp authentication failed'],
    ['IPQS', { ipqs: rejects('IPQS authentication failed (HTTP 403)') }, 'IPQS authentication failed'],
    [
      'Google',
      { yelp: yelpHit(), google: rejects('Google Places authentication failed (HTTP 403)') },
      'Google Places authentication failed',
    ],
  ] as const)('rejects, with the adapter message, when %s throws', async (_vendor, vendors, message) => {
    mockVendors(vendors);
    await expect(composeDossier(BUSINESS_PHONE)).rejects.toThrow(message);
  });

  it('reports every failing adapter, not just the first', async () => {
    mockVendors({ twilio: rejects('Twilio is down'), ipqs: rejects('IPQS is down') });

    const error = await composeDossier(BUSINESS_PHONE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as Error).message).toContain('Twilio is down');
    expect((error as Error).message).toContain('IPQS is down');
  });

  it('does not call Google when Yelp throws', async () => {
    mockVendors({ yelp: rejects('Yelp authentication failed (HTTP 401)') });
    await expect(composeDossier(BUSINESS_PHONE)).rejects.toThrow();
    expect(enrichFromGoogle).not.toHaveBeenCalled();
  });
});

describe('composeDossier: latency budget', () => {
  // Fake timers give exact virtual elapsed time. Each adapter holds for its own 900 ms timeout and
  // then resolves with its degraded defaults, which is what the real adapters do.
  const elapsed = async (phone: string): Promise<number> => {
    const start = Date.now();
    let doneAt = -1;
    const dossier = composeDossier(phone).then((d) => {
      doneAt = Date.now() - start;
      return d;
    });
    await vi.advanceTimersByTimeAsync(5000);
    await dossier;
    return doneAt;
  };

  it('worst case, every adapter at its 900 ms timeout, stays under the 2 s budget', async () => {
    vi.useFakeTimers();
    mockVendors({
      twilio: delayed(900, twilioDegraded),
      yelp: delayed(900, yelpHit()),
      google: delayed(900, googleDegraded),
      ipqs: delayed(900, ipqsDegraded),
    });

    // Twilio, Yelp and IPQS overlap (900 ms), then Google runs after Yelp (900 ms). A serial
    // compose would take 3600 ms.
    expect(await elapsed(BUSINESS_PHONE)).toBe(1800);
  });

  it('starts Google as soon as Yelp resolves, without waiting for a slower Twilio or IPQS', async () => {
    vi.useFakeTimers();
    mockVendors({
      twilio: delayed(900, twilioDegraded),
      yelp: delayed(100, yelpHit()),
      google: delayed(900, googleOk()),
      ipqs: delayed(900, ipqsDegraded),
    });

    // Yelp 100 + Google 900 = 1000. Waiting for all three before Google would give 900 + 900 = 1800.
    expect(await elapsed(BUSINESS_PHONE)).toBe(1000);
  });

  it('adds no Google time on the no-business path', async () => {
    vi.useFakeTimers();
    mockVendors({ twilio: delayed(900, twilioDegraded), yelp: delayed(900, yelpMiss), ipqs: delayed(900, ipqsDegraded) });
    expect(await elapsed(MOBILE_PHONE)).toBe(900);
  });
});
