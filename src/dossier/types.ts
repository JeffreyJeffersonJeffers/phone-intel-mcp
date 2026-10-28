import type { Hours } from '../vendors/googlePlaces.js';
import type { ReputationLookup } from '../vendors/ipqs.js';
import type { TwilioLookup } from '../vendors/twilio.js';
import type { YelpBusiness } from '../vendors/yelp.js';

// Which tier of response the caller got. `business` means Yelp resolved a business at the number;
// every other value comes from the Twilio line type when Yelp found nothing.
export type NumberClassification =
  | 'business'
  | 'consumer_mobile'
  | 'consumer_landline'
  | 'voip'
  | 'toll_free'
  | 'unknown';

export interface BusinessMatch {
  name: string;
  category: string;
  address: YelpBusiness['address'];
  // The Google half is null when Google found no place, or timed out.
  hours: Hours | null;
  is_open_now: boolean | null;
  rating: { stars: number; count: number } | null;
  place_id: string | null;
  yelp_id: string;
}

// Response schema v1. A vendor that timed out still fills its section, with that adapter's safe
// defaults (carrier.type 'unknown', spam_risk_score 0, is_dnc_listed null, ...).
export interface Dossier {
  phone: string;
  number_classification: NumberClassification;
  carrier: TwilioLookup['carrier'];
  caller_name: string | null;
  business_match: BusinessMatch | null;
  reputation: Omit<ReputationLookup, 'cached'>;
  meta: {
    lookup_id: string;
    schema_version: 'v1';
    // Sections served from the cache instead of a vendor call: carrier, business, enrichment,
    // hours, reputation.
    cached_fields: string[];
    timestamp: string;
  };
}
