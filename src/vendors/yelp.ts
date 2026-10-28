import { getCached, setCached } from '../cache/cache.js';
import { env } from '../env.js';

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

  // One AbortController covers connect, headers and body read: fetch rejects with an AbortError
  // when it fires. The timer is always cleared so a fast response leaves no live handle behind.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let status: number;
  let body: { businesses?: unknown } | undefined;
  try {
    // "+" must be percent-encoded: left bare in a query string it decodes to a space.
    const response = await fetch(`${ENDPOINT}?phone=${encodeURIComponent(phoneE164)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    status = response.status;
    if (response.ok) body = (await response.json()) as { businesses?: unknown };
  } catch {
    return DEGRADED; // timeout, network error, or a 200 body that is not JSON
  } finally {
    clearTimeout(timer);
  }

  // Bad credentials do not fix themselves, and degrading would hide them behind "no business" on
  // every call. Surface 401/403 loudly, with the status only: never the response body or request.
  if (status === 401 || status === 403) throw new Error(`Yelp authentication failed (HTTP ${status})`);
  // Any other non-2xx (400, 404, 429, 5xx): degrade like a timeout, and do not cache.
  if (!body) return DEGRADED;

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
