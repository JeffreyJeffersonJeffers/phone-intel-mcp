// x402 Bazaar discovery metadata (https://docs.cdp.coinbase.com/x402/seller/get-discovered).
// Attached to the 402 challenge body as `extensions.bazaar`. The Coinbase CDP facilitator reads
// this during verify/settle and catalogs the service in the Bazaar, which is what x402.new indexes
// from. Services that settle payments without this block are not catalogued, so dropping it means
// going invisible to Bazaar-aware agents — not a crash, but a silent regression.
//
// Shape mirrors live v1 listings (e.g. api.onesource.io): a top-level info/schema/routeTemplate
// triple. The example dossier matches README's illustrative response.

const EXAMPLE_DOSSIER = {
  phone: '+15165551234',
  number_classification: 'business',
  // Clearly illustrative values that no test fixture reuses, so that an assertion like
  // "the dossier didn't leak on failure" can still key off the real mock without colliding.
  carrier: { name: 'Spectrum Business', type: 'landline' },
  caller_name: 'GARDEN CITY HARDWARE',
  business_match: {
    name: 'Garden City Hardware',
    category: 'Hardware Stores',
    address: { line1: '100 Franklin Ave', city: 'Garden City', state: 'NY', postal: '11530' },
    hours: { monday: [{ open: '07:30', close: '18:00' }] },
    is_open_now: true,
    rating: { stars: 4.6, count: 212 },
    place_id: 'ChIJ-example-place-id',
    yelp_id: 'garden-city-hardware-garden-city',
  },
  reputation: { spam_risk_score: 3, is_known_robocall: false, is_dnc_listed: null, is_voip_risk: false },
  meta: {
    lookup_id: '3f0c7a52-6a52-4b8e-9d3b-0f6f1f6d2a11',
    schema_version: 'v1',
    cached_fields: ['carrier', 'reputation'],
    timestamp: '2026-10-28T14:03:11.482Z',
  },
};

const BAZAAR_METADATA = {
  info: {
    input: {
      method: 'GET',
      type: 'http',
      pathParams: { phone: '+15165551234' },
    },
    output: {
      type: 'json',
      example: EXAMPLE_DOSSIER,
    },
  },
  routeTemplate: '/lookup/:phone',
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['input'],
    properties: {
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'type', 'pathParams'],
        properties: {
          method: { type: 'string', enum: ['GET', 'HEAD'] },
          type: { type: 'string', const: 'http' },
          pathParams: {
            type: 'object',
            additionalProperties: false,
            required: ['phone'],
            properties: {
              phone: {
                type: 'string',
                description:
                  'US phone number, URL-encoded E.164 preferred (+15165551234). Dashed and parenthesized formats are normalized server-side.',
                pattern: '^\\+1\\d{10}$',
              },
            },
          },
        },
      },
      output: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string' },
          example: { type: 'object' },
        },
      },
    },
  },
} as const;

export function bazaarDiscovery(): Record<string, unknown> {
  return BAZAAR_METADATA as unknown as Record<string, unknown>;
}
