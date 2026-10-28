import { Client, PlaceInputType } from '@googlemaps/google-maps-services-js';
import { getCached, setCached } from '../cache/cache.js';
import { env } from '../env.js';

// Enrichment only: call this after Yelp has resolved a business, never on a consumer-cell path.

export type Hours = Record<string, { open: string; close: string }[]>;

export interface GoogleEnrichmentInput {
  yelpName: string;
  yelpAddressLine1: string;
  yelpCity: string;
  yelpState: string;
  // Keys the cache. Not sent to Google.
  phoneE164: string;
}

export interface GoogleEnrichment {
  hours: Hours | null;
  is_open_now: boolean | null;
  rating: { stars: number; count: number } | null;
  place_id: string | null;
  cached: boolean;
}

// Two cache fields with different lifetimes. Hours and open-now go stale within the hour and the
// global constraint caps them at 1 h, so they live alone in `hours`. Rating and place_id are stable
// for days and live in `enrichment` (7 d). Yelp owns `business`, so Google needs its own field.
interface CachedHours {
  hours: Hours | null;
  is_open_now: boolean | null;
}
interface CachedPlace {
  rating: GoogleEnrichment['rating'];
  place_id: string | null;
}
// Stored in `enrichment` for a confirmed "Google has no such place", so a repeat call is a cache
// hit instead of two more paid calls. A match is stored as the CachedPlace itself.
interface CachedMiss {
  matched: false;
}

const TIMEOUT_MS = 900;
// Place Details bills per field group, and omitting `fields` returns (and bills) everything.
const DETAIL_FIELDS = ['opening_hours', 'current_opening_hours', 'rating', 'user_ratings_total', 'place_id'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const NULLS: Omit<GoogleEnrichment, 'cached'> = { hours: null, is_open_now: null, rating: null, place_id: null };

// The subset of Place Details we read. Everything is unknown: this is upstream data. (The SDK's
// own Place type predates current_opening_hours, so it is not used here.)
interface ApiHours {
  open_now?: unknown;
  periods?: unknown;
}
interface ApiDetails {
  place_id?: unknown;
  rating?: unknown;
  user_ratings_total?: unknown;
  opening_hours?: ApiHours;
  current_opening_hours?: ApiHours;
}

type Fetched = { kind: 'degraded' } | { kind: 'no_match' } | { kind: 'found'; foundId: string; details: ApiDetails };
const DEGRADED: Fetched = { kind: 'degraded' };

// One client for the process: it shares the SDK's keep-alive HTTPS agent. The API key travels per
// request, so nothing here needs credentials at construction.
const places = new Client({});

// Bad credentials do not fix themselves, and degrading would hide them behind "no hours" on every
// call. The SDK turns Google's REQUEST_DENIED into an HTTP 403 error. The message carries the
// status only: never the original error, whose `config` holds the request, API key included.
function throwIfAuthError(err: unknown): void {
  const { status, response } = (err ?? {}) as { status?: unknown; response?: { status?: unknown } };
  const code = response?.status ?? status;
  if (code === 401 || code === 403) throw new Error(`Google Places authentication failed (HTTP ${code})`);
}

// Find Place, then Place Details, under one 900 ms deadline: the abort signal is shared, so a slow
// first call leaves the second only what remains. Any non-auth failure is "degraded".
async function fetchFromGoogle(query: string, key: string): Promise<Fetched> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // The SDK retries 5xx by default: that would double-bill Google and blow the deadline.
  const options = { signal: controller.signal, raxConfig: { retry: 0 } };
  try {
    const search = await places.findPlaceFromText({
      params: { input: query, inputtype: PlaceInputType.textQuery, fields: ['place_id'], key },
      ...options,
    });
    const candidates: unknown = search.data?.candidates;
    if (!Array.isArray(candidates)) return DEGRADED; // vendor gap, not a confirmed miss
    if (candidates.length === 0) return { kind: 'no_match' };
    const foundId = (candidates[0] as { place_id?: unknown } | undefined)?.place_id;
    if (typeof foundId !== 'string' || foundId === '') return DEGRADED;

    const detail = await places.placeDetails({ params: { place_id: foundId, fields: DETAIL_FIELDS, key }, ...options });
    const result: unknown = detail.data?.result;
    if (typeof result !== 'object' || result === null) return DEGRADED;
    return { kind: 'found', foundId, details: result as ApiDetails };
  } catch (err) {
    throwIfAuthError(err);
    return DEGRADED; // timeout (abort), network error, or any other HTTP failure
  } finally {
    clearTimeout(timer);
  }
}

const TIME = /^\d{4}$/;
const clock = (hhmm: string): string => `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;

// Google periods -> { monday: [{ open: "09:00", close: "17:00" }], ... }. Every day is present;
// a day with no period is closed ([]). An overnight period is filed under the day it opens and
// keeps its real close time (Friday 18:00 -> 02:00 is friday [{ "18:00", "02:00" }]). A period
// that is malformed is skipped; if none survive, hours is null.
function toHours(...sources: (ApiHours | undefined)[]): Hours | null {
  const periods = sources.map((s) => s?.periods).find((p) => Array.isArray(p) && p.length > 0) as unknown[] | undefined;
  if (!periods) return null;

  // Google marks a place that is always open as a single period opening Sunday 00:00 with no close.
  const only = periods[0] as { open?: { day?: unknown; time?: unknown }; close?: unknown } | undefined;
  if (periods.length === 1 && only?.close === undefined && only?.open?.day === 0 && only?.open?.time === '0000') {
    return Object.fromEntries(DAYS.map((day) => [day, [{ open: '00:00', close: '23:59' }]]));
  }

  const hours: Hours = Object.fromEntries(DAYS.map((day) => [day, []]));
  let kept = 0;
  for (const p of periods as { open?: { day?: unknown; time?: unknown }; close?: { time?: unknown } }[]) {
    const day = p?.open?.day;
    const open = p?.open?.time;
    const close = p?.close?.time;
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) continue;
    if (typeof open !== 'string' || !TIME.test(open) || typeof close !== 'string' || !TIME.test(close)) continue;
    hours[DAYS[day]].push({ open: clock(open), close: clock(close) });
    kept++;
  }
  return kept > 0 ? hours : null;
}

function openNow(details: ApiDetails): boolean | null {
  for (const source of [details.current_opening_hours, details.opening_hours]) {
    if (typeof source?.open_now === 'boolean') return source.open_now;
  }
  return null;
}

export async function enrichFromGoogle(input: GoogleEnrichmentInput): Promise<GoogleEnrichment> {
  const key = env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is not set');

  const { phoneE164 } = input;
  const [place, hours] = await Promise.all([
    getCached<CachedPlace | CachedMiss>(phoneE164, 'enrichment'),
    getCached<CachedHours>(phoneE164, 'hours'),
  ]);
  if (place && 'matched' in place) return { ...NULLS, cached: true };
  // Hours going stale (1 h) forces a re-fetch even when the 7-day half is still fresh.
  if (place && hours) return { ...hours, ...place, cached: true };

  // Empty address parts are left out rather than leaving double spaces in the query.
  const query = [input.yelpName, input.yelpAddressLine1, input.yelpCity, input.yelpState].filter(Boolean).join(' ');
  const fetched = await fetchFromGoogle(query, key);
  if (fetched.kind === 'degraded') return { ...NULLS, cached: false };
  if (fetched.kind === 'no_match') {
    await setCached<CachedMiss>(phoneE164, 'enrichment', { matched: false });
    return { ...NULLS, cached: false };
  }

  const { details, foundId } = fetched;
  const fresh: CachedPlace & CachedHours = {
    hours: toHours(details.opening_hours, details.current_opening_hours),
    is_open_now: openNow(details),
    rating:
      typeof details.rating === 'number'
        ? { stars: details.rating, count: typeof details.user_ratings_total === 'number' ? details.user_ratings_total : 0 }
        : null,
    // Place Details echoes the id; the Find Place id is the same place if it somehow does not.
    place_id: typeof details.place_id === 'string' && details.place_id !== '' ? details.place_id : foundId,
  };
  await Promise.all([
    setCached<CachedPlace>(phoneE164, 'enrichment', { rating: fresh.rating, place_id: fresh.place_id }),
    setCached<CachedHours>(phoneE164, 'hours', { hours: fresh.hours, is_open_now: fresh.is_open_now }),
  ]);
  return { ...fresh, cached: false };
}
