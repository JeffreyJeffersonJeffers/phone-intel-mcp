import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCached } from '../../../src/cache/cache.js';
import { lookupTwilio } from '../../../src/vendors/twilio.js';

// Twilio is mocked (no network, no spend); the cache is the real Supabase Postgres, same as the
// Task 3 tests, so cache behaviour here is exercised end to end.
const { fetchMock, phoneNumbersMock, mockEnv } = vi.hoisted(() => {
  const fetchMock = vi.fn();
  const phoneNumbersMock = vi.fn((_phone: string) => ({ fetch: fetchMock }));
  const mockEnv: Record<string, string | undefined> = {};
  return { fetchMock, phoneNumbersMock, mockEnv };
});

vi.mock('twilio', () => ({
  default: vi.fn(() => ({ lookups: { v2: { phoneNumbers: phoneNumbersMock } } })),
}));

// vitest.config.ts deliberately keeps vendor keys out of the test env, so inject fake ones.
vi.mock('../../../src/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/env.js')>();
  Object.assign(mockEnv, actual.env, { TWILIO_SID: 'ACtest', TWILIO_TOKEN: 'test-token' });
  return { ...actual, env: mockEnv };
});

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set: the cache round-trip needs the real Supabase database (.env.local)');
}
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 });

// Distinct from the numbers in tests/integration/cache.test.ts: both files share one database
// and vitest runs files in parallel, so a shared fixture would let their cleanups race.
const PHONE = '+15165559401';
const DEGRADED = { carrier: { name: null, type: 'unknown' }, caller_name: null, cached: false };

// Shapes below are what the Twilio SDK hands back: camelCase instance fields (the SDK maps
// carrier_name -> carrierName, caller_name -> callerName), null for a field that was not returned.
const twilioResponse = (
  line: { type?: string | null; carrierName?: string | null } | null,
  callerName: string | null = null,
) => ({
  lineTypeIntelligence: line,
  callerName: callerName === null ? null : { callerName },
});

beforeEach(() => {
  fetchMock.mockReset();
  phoneNumbersMock.mockClear();
  mockEnv.TWILIO_SID = 'ACtest';
  mockEnv.TWILIO_TOKEN = 'test-token';
});
afterEach(() => sql`DELETE FROM phone_lookups WHERE phone_e164 = ${PHONE}`);
afterAll(() => sql.end());

describe('lookupTwilio mapping', () => {
  it('maps Twilio line_type to our carrier.type', async () => {
    fetchMock.mockResolvedValue(twilioResponse({ type: 'mobile', carrierName: 'Verizon' }));
    expect(await lookupTwilio(PHONE)).toEqual({
      carrier: { type: 'mobile', name: 'Verizon' },
      caller_name: null,
      cached: false,
    });
  });

  it('returns null caller_name on US mobile without CNAM', async () => {
    fetchMock.mockResolvedValue(twilioResponse({ type: 'mobile', carrierName: 'T-Mobile' }, null));
    expect((await lookupTwilio(PHONE)).caller_name).toBeNull();
  });

  it('returns caller_name when Twilio has CNAM', async () => {
    fetchMock.mockResolvedValue(twilioResponse({ type: 'landline', carrierName: 'Frontier' }, 'ACME PLUMBING'));
    expect(await lookupTwilio(PHONE)).toMatchObject({ carrier: { type: 'landline' }, caller_name: 'ACME PLUMBING' });
  });

  it.each([
    ['mobile', 'mobile'],
    ['landline', 'landline'],
    ['nonFixedVoip', 'voip'],
    ['fixedVoip', 'voip'],
    ['tollFree', 'tollFree'],
    ['toll-free', 'tollFree'],
    ['personal', 'unknown'],
    ['constructor', 'unknown'], // must not resolve through Object.prototype
    [null, 'unknown'],
  ])('maps Twilio type %j to %s', async (twilioType, expected) => {
    fetchMock.mockResolvedValue(twilioResponse({ type: twilioType, carrierName: 'X' }));
    expect((await lookupTwilio(PHONE)).carrier.type).toBe(expected);
  });

  it('degrades carrier fields to null/unknown when line_type_intelligence is absent', async () => {
    fetchMock.mockResolvedValue(twilioResponse(null, 'SOMEONE'));
    expect(await lookupTwilio(PHONE)).toEqual({
      carrier: { name: null, type: 'unknown' },
      caller_name: 'SOMEONE',
      cached: false,
    });
  });

  it('asks Twilio Lookup v2 for line_type_intelligence and caller_name on the E.164 number', async () => {
    fetchMock.mockResolvedValue(twilioResponse({ type: 'mobile' }));
    await lookupTwilio(PHONE);
    expect(phoneNumbersMock).toHaveBeenCalledWith(PHONE);
    expect(fetchMock).toHaveBeenCalledWith({ fields: 'line_type_intelligence,caller_name' });
  });
});

describe('lookupTwilio cache', () => {
  it('reads from cache on second call', async () => {
    fetchMock.mockResolvedValue(twilioResponse({ type: 'mobile', carrierName: 'Verizon' }, 'JANE DOE'));
    const first = await lookupTwilio(PHONE);
    const second = await lookupTwilio(PHONE);

    expect(first.cached).toBe(false);
    expect(second).toEqual({ ...first, cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stores the carrier/caller_name payload (without the cached flag) in the carrier field', async () => {
    fetchMock.mockResolvedValue(twilioResponse({ type: 'mobile', carrierName: 'Verizon' }));
    await lookupTwilio(PHONE);
    expect(await getCached(PHONE, 'carrier')).toEqual({
      carrier: { name: 'Verizon', type: 'mobile' },
      caller_name: null,
    });
  });
});

describe('lookupTwilio failure handling', () => {
  it('returns a degraded result within the 900ms budget when Twilio hangs, and does not cache it', async () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never settles
    const started = Date.now();
    const result = await lookupTwilio(PHONE);
    const elapsed = Date.now() - started;

    expect(result).toEqual(DEGRADED);
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThan(1500);
    expect(await getCached(PHONE, 'carrier')).toBeNull();
  });

  it('retries Twilio on the next call after a timeout instead of serving a poisoned cache', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    await lookupTwilio(PHONE);

    fetchMock.mockResolvedValue(twilioResponse({ type: 'landline', carrierName: 'Frontier' }));
    expect(await lookupTwilio(PHONE)).toMatchObject({ carrier: { type: 'landline' }, cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns a degraded result and does not cache when Twilio rejects', async () => {
    fetchMock.mockRejectedValue(new Error('Twilio 503'));
    expect(await lookupTwilio(PHONE)).toEqual(DEGRADED);
    expect(await getCached(PHONE, 'carrier')).toBeNull();
  });

  it.each(['TWILIO_SID', 'TWILIO_TOKEN'])('throws a clear error, without calling Twilio, when %s is unset', async (key) => {
    mockEnv[key] = undefined;
    await expect(lookupTwilio(PHONE)).rejects.toThrow(key);
    expect(phoneNumbersMock).not.toHaveBeenCalled();
  });
});
