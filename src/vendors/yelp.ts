import { getCached, setCached } from '../cache/cache.js';
import { env } from '../env.js';
import { vendorLog } from '../lib/vendorLog.js';

export interface YelpBusiness {
  name: string;
  category: string;
  yelp_id: string;
  address: { line1: string; city: string; state: string; postal: string };
  rating: { stars: number; count: number } | null;
}

export interface YelpLookup {
  business: YelpBusiness | null;
  cached: boolean;
}

const ENDPOINT = 'https://api.yelp.com/v3/businesses/search/phone';
const TIMEOUT_MS = 900;

// Yelp refuses requests from datacenter IPs (403 from Fly.io), so with SCRAPERAPI_KEY set the same
// GET goes through ScraperAPI (https://docs.scraperapi.com): `url` is the Yelp URL and
// `keep_headers=true` makes it forward our headers, i.e. the Yelp Authorization. Its median is about
// 2 s, so the limit is longer than a direct call's. (ScraperAPI charges for a request that we cancel
// before its own 70 s retry window ends, so a timeout still costs a credit.)
const SCRAPERAPI_ENDPOINT = 'https://api.scraperapi.com/';
const PROXY_TIMEOUT_MS = 2_500;

// The status code of a proxied response is ScraperAPI's: 401 a bad ScraperAPI key, 403 the monthly
// credits used up, 429 too many concurrent requests, 500 a request that failed after its retries
// (not charged); 200 and 404 are the target's. A 401 is a broken configuration and stops the lookup.
// A 403 is a capacity limit: the lookup carries on without Yelp (the payer still gets a dossier, with
// no business) and an error-level log line tells the operator to upgrade. The rest degrade quietly,
// like any vendor miss.

// Stored in the business field for a confirmed "no business at this number", so a repeat call is a
// cache hit instead of another paid Yelp call. A match is stored as the YelpBusiness itself.
interface CachedMiss {
  matched: false;
}

// The subset of Yelp's business object we read. Everything is optional: this is upstream data.
interface YelpApiBusiness {
  id: string;
  name: string;
  categories?: { title?: string }[];
  location?: { address1?: string | null; city?: string | null; state?: string | null; zip_code?: string | null };
  rating?: unknown;
  review_count?: number;
}

const DEGRADED: YelpLookup = { business: null, cached: false };

function toBusiness(b: YelpApiBusiness): YelpBusiness {
  return {
    name: b.name,
    category: b.categories?.[0]?.title ?? 'Unknown',
    yelp_id: b.id,
    address: {
      line1: b.location?.address1 ?? '',
      city: b.location?.city ?? '',
      state: b.location?.state ?? '',
      postal: b.location?.zip_code ?? '',
    },
    rating: typeof b.rating === 'number' ? { stars: b.rating, count: b.review_count ?? 0 } : null,
  };
}

export async function lookupYelp(phoneE164: string): Promise<YelpLookup> {
  const apiKey = env.YELP_API_KEY;
  if (!apiKey) throw new Error('YELP_API_KEY is not set');

  const hit = await getCached<YelpBusiness | CachedMiss>(phoneE164, 'business');
  if (hit) return 'matched' in hit ? { business: null, cached: true } : { business: hit, cached: true };

  // "+" must be percent-encoded: left bare in a query string it decodes to a space.
  const yelpUrl = `${ENDPOINT}?phone=${encodeURIComponent(phoneE164)}`;
  const scraperApiKey = env.SCRAPERAPI_KEY;
  const proxied = scraperApiKey !== undefined;
  const url = proxied
    ? `${SCRAPERAPI_ENDPOINT}?api_key=${encodeURIComponent(scraperApiKey)}` +
      `&url=${encodeURIComponent(yelpUrl)}&keep_headers=true`
    : yelpUrl;

  // One AbortController covers connect, headers and body read: fetch rejects with an AbortError
  // when it fires. The timer is always cleared so a fast response leaves no live handle behind.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), proxied ? PROXY_TIMEOUT_MS : TIMEOUT_MS);
  let status: number;
  let ok: boolean;
  let body: { businesses?: unknown; error?: { code?: unknown } } | undefined;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    status = response.status;
    ok = response.ok;
    // Through the proxy the status is ScraperAPI's, so Yelp's own verdict (an error body) has to be
    // read from whatever JSON came back. Not for 401/403: those are ScraperAPI's own and have no
    // Yelp body.
    if (ok || (proxied && status !== 401 && status !== 403)) body = (await response.json()) as typeof body;
  } catch {
    return DEGRADED; // timeout, network error, or a body that is not JSON
  } finally {
    clearTimeout(timer);
  }

  // Bad credentials do not fix themselves, and degrading would hide them behind "no business" on
  // every call. Surface them loudly, with the status only: never the response body or the request
  // (the proxied URL holds the ScraperAPI key).
  if (proxied && status === 401) throw new Error('ScraperAPI auth failed (HTTP 401): invalid SCRAPERAPI_KEY');
  // Credits used up: degrade, not cached (it says nothing about the number), but not quietly. This is
  // logged on every lookup that needed Yelp, so it is the line to alert on.
  if (proxied && status === 403) {
    vendorLog.error({ vendor: 'scraperapi', status }, 'scraperapi_credits_exhausted');
    return DEGRADED;
  }
  if (!proxied && (status === 401 || status === 403)) throw new Error(`Yelp authentication failed (HTTP ${status})`);
  if (proxied && body?.error?.code === 'TOKEN_INVALID') {
    throw new Error(`Yelp authentication failed (via ScraperAPI, HTTP ${status})`);
  }
  // Any other non-2xx (400, 404, 429, 5xx): degrade like a timeout, and do not cache.
  if (!ok || !body) return DEGRADED;

  // A 200 without a businesses array is a vendor gap, not a confirmed "no match": do not cache it.
  if (!Array.isArray(body.businesses)) return DEGRADED;

  const first = body.businesses[0] as YelpApiBusiness | undefined;
  if (!first) {
    await setCached<CachedMiss>(phoneE164, 'business', { matched: false });
    return { business: null, cached: false };
  }
  const business = toBusiness(first);
  await setCached(phoneE164, 'business', business);
  return { business, cached: false };
}
