import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getCached, invalidate, setCached, type CacheField } from '../../src/cache/cache.js';
import { env } from '../../src/env.js';

// Real Supabase Postgres, no mocks. A missing/bad DATABASE_URL fails the suite loudly.
if (!env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set: integration tests need the real Supabase database (.env.local)');
}
const sql = postgres(env.DATABASE_URL, { max: 2 });

const P1 = '+15165551234';
const P2 = '+15165551235';
const P3 = '+15165551236';
const TEST_PHONES = [P1, P2, P3];

const cleanup = () => sql`DELETE FROM phone_lookups WHERE phone_e164 IN ${sql(TEST_PHONES)}`;

// Backdate a field's cached_at so TTL expiry can be tested without waiting.
const backdate = (phone: string, field: CacheField, interval: string) =>
  sql`UPDATE phone_lookups SET ${sql(`${field}_cached_at`)} = now() - ${interval}::interval WHERE phone_e164 = ${phone}`;

const lastReadAgeSeconds = async (phone: string) => {
  const [row] = await sql`SELECT extract(epoch FROM now() - last_read_at)::float8 AS age FROM phone_lookups WHERE phone_e164 = ${phone}`;
  return row.age as number;
};

beforeAll(cleanup); // clear leftovers from any crashed earlier run
afterEach(cleanup);
afterAll(() => sql.end());

describe('cache round-trip', () => {
  it('round-trips a carrier record', async () => {
    await setCached(P1, 'carrier', { type: 'mobile', name: 'Verizon' });
    expect(await getCached(P1, 'carrier')).toMatchObject({ type: 'mobile' });
  });

  it('returns the full stored value, including nested structures', async () => {
    const value = { name: 'Joe', hours: [{ day: 1, open: '09:00' }], flags: { a: true, b: null } };
    await setCached(P1, 'business', value);
    expect(await getCached(P1, 'business')).toEqual(value);
  });

  it('returns null when the phone has no row', async () => {
    expect(await getCached(P1, 'carrier')).toBeNull();
  });

  it('returns null when the row exists but the field is unset', async () => {
    await setCached(P1, 'carrier', { type: 'mobile' });
    expect(await getCached(P1, 'business')).toBeNull();
  });

  it('overwrites an existing value and refreshes its timestamp', async () => {
    await setCached(P1, 'carrier', { type: 'mobile' });
    await backdate(P1, 'carrier', '6 days');
    await setCached(P1, 'carrier', { type: 'landline' });
    const [row] = await sql`SELECT extract(epoch FROM now() - carrier_cached_at)::float8 AS age FROM phone_lookups WHERE phone_e164 = ${P1}`;
    expect(row.age).toBeLessThan(60);
    expect(await getCached(P1, 'carrier')).toEqual({ type: 'landline' });
  });

  it('keeps fields independent of each other', async () => {
    await setCached(P1, 'carrier', { type: 'mobile' });
    await setCached(P1, 'hours', { open_now: true });
    expect(await getCached(P1, 'carrier')).toEqual({ type: 'mobile' });
    expect(await getCached(P1, 'hours')).toEqual({ open_now: true });
  });
});

describe('per-field TTL', () => {
  it('returns null when a cached entry is past TTL', async () => {
    await setCached(P2, 'reputation', { spam_risk_score: 10 });
    await sql`UPDATE phone_lookups SET reputation_cached_at = now() - interval '25 hours' WHERE phone_e164 = '+15165551235'`;
    expect(await getCached(P2, 'reputation')).toBeNull();
  });

  // [field, age still inside TTL, age just past TTL]
  it.each([
    ['carrier', '6 days 23 hours', '7 days 1 hour'],
    ['business', '6 days 23 hours', '7 days 1 hour'],
    ['reputation', '23 hours', '25 hours'],
    ['hours', '59 minutes', '61 minutes'],
  ] as const)('%s: served at %s, null at %s', async (field, fresh, stale) => {
    await setCached(P1, field, { v: 1 });
    await backdate(P1, field, fresh);
    expect(await getCached(P1, field)).toEqual({ v: 1 });
    await backdate(P1, field, stale);
    expect(await getCached(P1, field)).toBeNull();
  });
});

describe('last_read_at', () => {
  it('is bumped by a read that is served from cache', async () => {
    await setCached(P1, 'carrier', { type: 'mobile' });
    await sql`UPDATE phone_lookups SET last_read_at = now() - interval '10 days' WHERE phone_e164 = ${P1}`;
    await getCached(P1, 'carrier');
    expect(await lastReadAgeSeconds(P1)).toBeLessThan(60);
  });

  it('is not bumped by a miss on an expired field', async () => {
    await setCached(P1, 'hours', { open_now: true });
    await backdate(P1, 'hours', '2 hours');
    await sql`UPDATE phone_lookups SET last_read_at = now() - interval '10 days' WHERE phone_e164 = ${P1}`;
    expect(await getCached(P1, 'hours')).toBeNull();
    expect(await lastReadAgeSeconds(P1)).toBeGreaterThan(9 * 24 * 3600);
  });
});

describe('invalidate', () => {
  it('invalidate removes a single field', async () => {
    await setCached(P3, 'carrier', { type: 'mobile' });
    await invalidate(P3, 'carrier');
    expect(await getCached(P3, 'carrier')).toBeNull();
  });

  it('leaves other fields on the row untouched', async () => {
    await setCached(P3, 'carrier', { type: 'mobile' });
    await setCached(P3, 'business', { name: 'Joe' });
    await invalidate(P3, 'carrier');
    expect(await getCached(P3, 'business')).toEqual({ name: 'Joe' });
  });

  it('clears all four fields when no field is given, and keeps the row', async () => {
    const fields: CacheField[] = ['carrier', 'business', 'reputation', 'hours'];
    for (const field of fields) await setCached(P3, field, { v: field });
    await invalidate(P3);
    for (const field of fields) expect(await getCached(P3, field)).toBeNull();
    const rows = await sql`SELECT * FROM phone_lookups WHERE phone_e164 = ${P3}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].carrier_cached_at).toBeNull();
    expect(rows[0].hours_data).toBeNull();
  });

  it('is a no-op for a phone with no row', async () => {
    await expect(invalidate(P3, 'carrier')).resolves.toBeUndefined();
    await expect(invalidate(P3)).resolves.toBeUndefined();
  });

  it('lets the field be set again after invalidation', async () => {
    await setCached(P3, 'carrier', { type: 'mobile' });
    await invalidate(P3, 'carrier');
    await setCached(P3, 'carrier', { type: 'landline' });
    expect(await getCached(P3, 'carrier')).toEqual({ type: 'landline' });
  });
});
