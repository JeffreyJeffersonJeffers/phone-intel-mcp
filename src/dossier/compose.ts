import { randomUUID } from 'node:crypto';
import { enrichFromGoogle, type GoogleEnrichment } from '../vendors/googlePlaces.js';
import { lookupReputation } from '../vendors/ipqs.js';
import { lookupTwilio, type CarrierType } from '../vendors/twilio.js';
import { lookupYelp, type YelpBusiness, type YelpLookup } from '../vendors/yelp.js';
import type { BusinessMatch, Dossier, NumberClassification } from './types.js';

// Two kinds of adapter trouble, handled differently:
//  - Degrade (timeout, 5xx, network error, unusable reply): the adapter RETURNS safe defaults, so
//    its promise fulfils and its section is simply neutral. compose has no timeout of its own; the
//    2 s budget holds because every adapter bounds itself at 900 ms. Worst case is Yelp (900 ms)
//    then Google (900 ms) = 1800 ms, with Twilio and IPQS overlapped inside the Yelp wait.
//    Except while Yelp goes through the Vercel proxy (YELP_PROXY_URL and YELP_PROXY_AUTH set): its
//    limit is then 2500 ms, so the worst case for a number with a business is 2500 + 900 = 3400 ms,
//    over the 2 s budget.
//  - Operational error (bad credentials, missing config): the adapter THROWS. A silent default
//    would hide a dead key behind "no data" on every call, so compose throws too and the route
//    decides what to return.

// Classification when Yelp found no business, from Twilio's line type. A Record over the closed
// CarrierType union, so a new carrier type fails to compile until it is classified here.
const BY_LINE_TYPE: Record<CarrierType, NumberClassification> = {
  mobile: 'consumer_mobile',
  landline: 'consumer_landline',
  voip: 'voip',
  tollFree: 'toll_free',
  unknown: 'unknown',
};

interface BusinessLookup {
  yelp: YelpLookup;
  google: GoogleEnrichment | null;
}

// Yelp, then Google only if Yelp resolved a business. Kept as one promise so Google starts the
// moment Yelp answers, instead of waiting for the slower Twilio and IPQS calls.
async function lookupBusiness(phoneE164: string): Promise<BusinessLookup> {
  const yelp = await lookupYelp(phoneE164);
  if (!yelp.business) return { yelp, google: null };
  const { name, address } = yelp.business;
  const google = await enrichFromGoogle({
    yelpName: name,
    yelpAddressLine1: address.line1,
    yelpCity: address.city,
    yelpState: address.state,
    phoneE164,
  });
  return { yelp, google };
}

function toBusinessMatch(yelp: YelpBusiness, google: GoogleEnrichment): BusinessMatch {
  return {
    name: yelp.name,
    category: yelp.category,
    address: yelp.address,
    hours: google.hours,
    is_open_now: google.is_open_now,
    // Google's rating first; Yelp's own is better than nothing when Google has none.
    rating: google.rating ?? yelp.rating,
    place_id: google.place_id,
    yelp_id: yelp.yelp_id,
  };
}

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function composeDossier(phoneE164: string): Promise<Dossier> {
  const [twilio, business, reputation] = await Promise.allSettled([
    lookupTwilio(phoneE164),
    lookupBusiness(phoneE164),
    lookupReputation(phoneE164),
  ]);

  // allSettled lets every call finish first, so one run reports every broken credential at once.
  if (twilio.status === 'rejected' || business.status === 'rejected' || reputation.status === 'rejected') {
    const errors = [twilio, business, reputation].flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    throw new AggregateError(errors, `Vendor lookup failed: ${errors.map(describeError).join('; ')}`);
  }

  const { yelp, google } = business.value;
  const { cached: reputationCached, ...reputationFields } = reputation.value;

  // Google's two cache halves (rating/place_id as `enrichment`, hours/open-now as `hours`) share
  // one `cached` flag, so a cached Google result lists both.
  const cachedFields: string[] = [];
  if (twilio.value.cached) cachedFields.push('carrier');
  if (yelp.cached) cachedFields.push('business');
  if (google?.cached) cachedFields.push('enrichment', 'hours');
  if (reputationCached) cachedFields.push('reputation');

  return {
    phone: phoneE164,
    number_classification: yelp.business ? 'business' : BY_LINE_TYPE[twilio.value.carrier.type],
    // Copied: a degraded Twilio result shares one module-level carrier object across calls.
    carrier: { ...twilio.value.carrier },
    caller_name: twilio.value.caller_name,
    business_match: yelp.business && google ? toBusinessMatch(yelp.business, google) : null,
    reputation: reputationFields,
    meta: {
      lookup_id: randomUUID(),
      schema_version: 'v1',
      cached_fields: cachedFields,
      timestamp: new Date().toISOString(),
    },
  };
}
