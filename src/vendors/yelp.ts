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

// Yelp refuses requests from datacenter IPs (403 from Fly.io). With YELP_PROXY_URL and YELP_PROXY_AUTH
// both set, the same GET goes to our own edge function on Vercel (the phone-intel-yelp-proxy project),
// whose addresses Yelp does not block: `<YELP_PROXY_URL>/api/yelp?phone=<E.164>` with an X-Proxy-Auth
// header. The proxy holds the Yelp key itself, so this process sends none, and returns Yelp's response
// verbatim, status and body. The limit is a little over a direct call's to absorb the extra hop.
const PROXY_TIMEOUT_MS = 2_500;

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
  const proxy =
    env.YELP_PROXY_URL && env.YELP_PROXY_AUTH ? { url: env.YELP_PROXY_URL, auth: env.YELP_PROXY_AUTH } : undefined;
  const proxied = proxy !== undefined;
  // Only a direct call needs our Yelp key: the proxy has its own.
  const apiKey = env.YELP_API_KEY;
  if (!proxied && !apiKey) throw new Error('YELP_API_KEY is not set');

  const hit = await getCached<YelpBusiness | CachedMiss>(phoneE164, 'business');
  if (hit) return 'matched' in hit ? { business: null, cached: true } : { business: hit, cached: true };

  // "+" must be percent-encoded: left bare in a query string it decodes to a space.
  const query = `phone=${encodeURIComponent(phoneE164)}`;
  const url = proxy ? `${proxy.url.replace(/\/+$/, '')}/api/yelp?${query}` : `${ENDPOINT}?${query}`;
  const headers: Record<string, string> = proxy
    ? { 'X-Proxy-Auth': proxy.auth, Accept: 'application/json' }
    : { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  // One AbortController covers connect, headers and body read: fetch rejects with an AbortError
  // when it fires. The timer is always cleared so a fast response leaves no live handle behind.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), proxied ? PROXY_TIMEOUT_MS : TIMEOUT_MS);
  let status: number;
  let ok: boolean;
  // `error` is a string on the proxy's own errors ("unauthorized", ...) and an object on Yelp's.
  let body: { businesses?: unknown; error?: unknown } | undefined;
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    status = response.status;
    ok = response.ok;
    if (ok) body = (await response.json()) as typeof body;
    // A proxied error is read when it parses, to tell the proxy's own errors from Yelp's. One that
    // doesn't (a Vercel error page) just has no body.
    else if (proxied) body = await response.json().then((b) => b as typeof body, () => undefined);
  } catch (err) {
    // Log Yelp timeouts (abort) so we can tell "no business match" from "proxy was too slow".
    // Network and non-JSON errors degrade silently as before.
    if (err instanceof Error && err.name === 'AbortError') {
      vendorLog.warn(
        { vendor: 'yelp', proxied, timeout_ms: proxied ? PROXY_TIMEOUT_MS : TIMEOUT_MS },
        'yelp_timeout',
      );
    }
    return DEGRADED;
  } finally {
    clearTimeout(timer);
  }

  // Bad credentials and a broken setup do not fix themselves, and degrading would hide them behind
  // "no business" on every call. Surface them loudly, with the status only: never the response body
  // or the request (which carries the proxy secret).
  if (proxy) {
    const yelpSpoke = typeof body?.error === 'object' && body.error !== null;
    if (status === 401 && !yelpSpoke) throw new Error('Yelp proxy auth failed (HTTP 401)'); // our X-Proxy-Auth
    if (status === 400 && !yelpSpoke) throw new Error('Yelp proxy rejected request (HTTP 400)'); // our number
    if (status === 500 && body?.error === 'misconfigured') throw new Error('Yelp proxy misconfigured (HTTP 500)');
  }
  // Yelp refusing a key: ours on a direct call, the proxy's when it passes Yelp's answer through.
  if (status === 401 || status === 403) throw new Error(`Yelp authentication failed (HTTP ${status})`);
  // Any other non-2xx (400, 404, 429, 5xx, the proxy's 502): degrade like a timeout, and do not cache.
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
