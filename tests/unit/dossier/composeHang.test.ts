import { describe, expect, it, vi } from 'vitest';
import { composeDossier } from '../../../src/dossier/compose.js';
import { enrichFromGoogle } from '../../../src/vendors/googlePlaces.js';
import { lookupReputation } from '../../../src/vendors/ipqs.js';
import { lookupYelp } from '../../../src/vendors/yelp.js';

// Review Focus 3, end to end. A mocked adapter cannot "hang past 900 ms" (the 900 ms timeout lives
// inside the real adapter), so this file runs the REAL lookupTwilio against a Twilio SDK whose
// request never settles, and mocks only the other three adapters. compose has no timeout of its
// own: the 2 s bound holds only because the adapter degrades, and this test is what proves it.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('twilio', () => ({
  default: vi.fn(() => ({ lookups: { v2: { phoneNumbers: vi.fn(() => ({ fetch: fetchMock })) } } })),
}));
vi.mock('../../../src/env.js', () => ({ env: { TWILIO_SID: 'ACtest', TWILIO_TOKEN: 'test-token' } }));
// No database: a cache miss on every read, and writes are dropped.
vi.mock('../../../src/cache/cache.js', () => ({
  getCached: vi.fn(async () => null),
  setCached: vi.fn(async () => undefined),
}));
vi.mock('../../../src/vendors/yelp.js', () => ({ lookupYelp: vi.fn() }));
vi.mock('../../../src/vendors/googlePlaces.js', () => ({ enrichFromGoogle: vi.fn() }));
vi.mock('../../../src/vendors/ipqs.js', () => ({ lookupReputation: vi.fn() }));

const PHONE = '+12125553333';

describe('composeDossier when one vendor hangs (real Twilio adapter)', () => {
  it('returns within 2 s with carrier unknown, and keeps every other vendor section intact', async () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // Twilio never answers
    vi.mocked(lookupYelp).mockResolvedValue({
      business: {
        name: "Joe's Pizza",
        category: 'Pizza',
        yelp_id: 'joes-pizza-new-york',
        address: { line1: '1 Main St', city: 'New York', state: 'NY', postal: '10001' },
        rating: { stars: 4.5, count: 120 },
      },
      cached: false,
    });
    vi.mocked(enrichFromGoogle).mockResolvedValue({
      hours: { monday: [{ open: '09:00', close: '17:00' }] },
      is_open_now: true,
      rating: { stars: 4.2, count: 300 },
      place_id: 'ChIJ-joes',
      cached: false,
    });
    vi.mocked(lookupReputation).mockResolvedValue({
      spam_risk_score: 2,
      is_known_robocall: false,
      is_dnc_listed: false,
      is_voip_risk: false,
      cached: false,
    });

    const start = Date.now();
    const d = await composeDossier(PHONE);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(850); // held for the adapter's 900 ms timeout, so it really did hang
    expect(elapsed).toBeLessThan(2000);
    expect(d.carrier).toEqual({ name: null, type: 'unknown' });
    expect(d.caller_name).toBeNull();
    expect(d.number_classification).toBe('business');
    expect(d.business_match?.name).toBe("Joe's Pizza");
    expect(d.business_match?.hours).not.toBeNull();
    expect(d.reputation.spam_risk_score).toBe(2);
    expect(d.meta.cached_fields).toEqual([]);
  });
});
