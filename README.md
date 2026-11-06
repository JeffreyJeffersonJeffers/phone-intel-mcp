# phone-intel-mcp

One call turns a US phone number into a dossier: carrier and line type, the business that owns it (name, category, address, hours, open-now, rating), and a spam/robocall reputation score. Built for AI agents (voice agents screening inbound calls, outbound dialers, lead-qualification and fraud workflows) that need to know who is behind a number in under two seconds, without a human signing up for four vendor accounts. Pay per call in USDC over [x402](https://www.x402.org) ([spec and reference code](https://github.com/coinbase/x402)); no API key, no account.

**Listed on:** [PayAPI Market](https://payapi.market/api/phone-intel-mcp) · [mcp.so](https://mcp.so/servers/phone-intel-mcp) · [x402scan](https://www.x402scan.com/)

## Try it in 30 seconds

See the x402 v2 challenge the server returns when you ask without paying (no account, no setup):

```bash
curl -i 'https://phone-intel-mcp.fly.dev/lookup/%2B15165551234'
```

You'll get **HTTP 402** with a `payment-required` response header (base64) and a JSON body spelling out the terms — amount, asset, recipient, network. To actually receive the dossier, sign that challenge with any x402 v2 client and resend with the signed payload in the `PAYMENT-SIGNATURE` header. See [`scripts/verify-mainnet.mjs`](scripts/verify-mainnet.mjs) in this repo for a 60-line working end-to-end example that uses `@x402/core` + `@x402/evm` + `viem` and nothing else. Full MCP-over-Streamable-HTTP example and raw-HTTP reference are below.

## Service

| | |
|---|---|
| Base URL | `https://phone-intel-mcp.fly.dev` |
| REST | `GET /lookup/{phone}` |
| MCP | `POST /mcp` (Streamable HTTP), tool `phone_intel.lookup` |
| Discovery | `GET /openapi.json` (OpenAPI 3.1 with `x-payment-info`) |
| Stats | `GET /stats` (aggregate counters: cache hit rate, p50/p95 latency, total lookups, uptime) |
| Health | `GET /health` |
| Price | **$0.03 USDC per lookup**, on **Base mainnet** |
| Payment protocol | x402 **v2** (CAIP-2 network `eip155:8453`, `exact` scheme, `payment-required` + `PAYMENT-SIGNATURE` + `payment-response` headers). v1 clients (`X-PAYMENT` / `x-payment-response`) are also accepted for backward compatibility. |

## Compliance & privacy

- **US only.** International numbers return `400 not_us_number`.
- **Business numbers + public-record data only.** No consumer-cell reverse-identity. Mobile numbers get carrier + reputation + classification, not a name match. This keeps the service out of the aggregated-data-broker space and respects the stricter state privacy laws (CA, IL, FL, PA, VT).
- **`caller_name` is CNAM-only** (telco-issued, mostly landline businesses) or public business-registry matches — never a data-broker lookup on a consumer phone.
- **No long-term storage of lookup results** beyond cache TTLs. No cross-querier correlation. The URL contains the phone number, so don't log it or share it if the number is sensitive.

## The dossier (schema v1)

Typed in [`src/dossier/types.ts`](src/dossier/types.ts). Illustrative response (the number and business are made up):

```json
{
  "phone": "+15165551234",
  "number_classification": "business",
  "carrier": { "name": "Verizon", "type": "landline" },
  "caller_name": "GARDEN CITY HARDWARE",
  "business_match": {
    "name": "Garden City Hardware",
    "category": "Hardware Stores",
    "address": { "line1": "100 Franklin Ave", "city": "Garden City", "state": "NY", "postal": "11530" },
    "hours": {
      "sunday": [{ "open": "09:00", "close": "17:00" }],
      "monday": [{ "open": "07:30", "close": "18:00" }],
      "tuesday": [{ "open": "07:30", "close": "18:00" }],
      "wednesday": [{ "open": "07:30", "close": "18:00" }],
      "thursday": [{ "open": "07:30", "close": "18:00" }],
      "friday": [{ "open": "07:30", "close": "18:00" }],
      "saturday": [{ "open": "08:00", "close": "17:00" }]
    },
    "is_open_now": true,
    "rating": { "stars": 4.6, "count": 212 },
    "place_id": "ChIJ-example-place-id",
    "yelp_id": "garden-city-hardware-garden-city"
  },
  "reputation": {
    "spam_risk_score": 3,
    "is_known_robocall": false,
    "is_dnc_listed": null,
    "is_voip_risk": false
  },
  "meta": {
    "lookup_id": "3f0c7a52-6a52-4b8e-9d3b-0f6f1f6d2a11",
    "schema_version": "v1",
    "cached_fields": ["carrier", "reputation"],
    "timestamp": "2026-10-28T14:03:11.482Z"
  }
}
```

- `number_classification`: `business` when a business is found at the number; otherwise from the line type: `consumer_mobile`, `consumer_landline`, `voip`, `toll_free`, or `unknown`.
- `carrier.type`: `mobile`, `landline`, `voip`, `tollFree`, `unknown`. `caller_name` is `null` when the carrier has no CNAM record (most US mobile numbers).
- `business_match` is `null` when no business is found. Its `hours`, `is_open_now` and `place_id` come from Google and are `null` when Google has no match; `rating` is Google's, falling back to Yelp's, and is `null` only if neither has one.
- `reputation.spam_risk_score` is 0-100 (higher is riskier). `is_dnc_listed` is `null` when unknown.
- `meta.cached_fields` lists the sections served from cache (`carrier`, `business`, `enrichment`, `hours`, `reputation`). Cached answers are faster; the price is the same.
- **Degraded sections.** If one vendor times out, you still get a dossier: that section carries neutral defaults (`carrier.type: "unknown"`, `spam_risk_score: 0`, `is_dnc_listed: null`) and you are charged as usual. A dossier where both `reputation.spam_risk_score` is `0` and `reputation.is_dnc_listed` is `null` means the reputation vendor returned no usable record for the number (it timed out, or does not know it): treat that as "no data" rather than "clean". (A zero score alone is a legitimate result for a clean number, with or without `cached_fields`.)

## How payment works (x402 v2)

You never create an account. The server asks for payment; you sign an authorization; the server serves the lookup and then collects.

1. **Call the endpoint with no payment.** The server answers **HTTP 402** with the x402 v2 terms in the `payment-required` response header (base64-encoded JSON) and in the response body:

   ```json
   {
     "x402Version": 2,
     "accepts": [{
       "scheme": "exact",
       "network": "eip155:8453",
       "amount": "30000",
       "resource": { "url": "https://phone-intel-mcp.fly.dev/lookup/%2B15165551234" },
       "payTo": "0x…the receiving wallet, always read from this response…",
       "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
       "maxTimeoutSeconds": 60,
       "extra": { "name": "USD Coin", "version": "2" }
     }]
   }
   ```

   `amount` is in USDC atomic units (6 decimals): `30000` = $0.03. `network` is CAIP-2 — `eip155:8453` is Base mainnet.
2. **Sign an EIP-3009 `transferWithAuthorization`** for exactly those terms (any x402 v2 client library does this) and resend with the signed payload in the **`PAYMENT-SIGNATURE`** request header. (v1 clients using `X-PAYMENT` are still accepted — the server dual-decodes.)
3. **The server verifies, runs the lookup, and only on success settles the USDC on-chain.** A `200` carries a `payment-response` header (base64 JSON) with the transaction hash. A v1 client gets the same payload under the legacy `x-payment-response` header too.

**You are charged only for a 2xx.** A malformed number, a vendor failure, a rate-limit or concurrency rejection never settles, so no USDC moves. An authorization is single-use and valid for about a minute: after a non-2xx, sign a fresh one rather than resending it (resending a used one gets `402 payment_already_used`). The one exception is `429 concurrent_request`, which turns the request away before it is used, so the same header can be resent. The paying wallet needs USDC on Base and nothing else; the facilitator pays gas.

## From an MCP client

Any MCP client that speaks Streamable HTTP can list the tool for free (`initialize` and `tools/list` are never charged) and call it. Payment is HTTP-level, so wrap `fetch`: when the server answers 402, sign the challenge and retry. Full integration with the official TypeScript SDK and the v2 x402 client packages (`npm i @modelcontextprotocol/sdk @x402/core @x402/evm viem`):

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as `0x${string}`); // wallet w/ USDC on Base
const scheme = new ExactEvmScheme(account);

// x402 v2 over fetch: when the server answers 402, sign its challenge and send the request
// again with the payment attached. Anything that is not a 402 (initialize, tools/list) passes through.
const payingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status !== 402) return response;
  const challenge = decodePaymentRequiredHeader(response.headers.get('payment-required')!);
  const requirements = challenge.accepts.find((r) => r.network === 'eip155:8453' && r.scheme === 'exact')!;
  const result = await scheme.createPaymentPayload(2, requirements);
  const paymentHeader = encodePaymentSignatureHeader({ ...result, accepted: requirements });
  return fetch(input, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init?.headers)), 'PAYMENT-SIGNATURE': paymentHeader },
  });
};

const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('https://phone-intel-mcp.fly.dev/mcp'), { fetch: payingFetch }),
);

const result = await client.callTool({ name: 'phone_intel.lookup', arguments: { phone: '+15165551234' } });
console.log(result.structuredContent); // the dossier; result.content[0].text is the same JSON
```

Tool-level failures come back as a normal result with `isError: true` and the error code as its text (`invalid_phone`, `not_us_number`, `vendor_failure`, `internal_error`). Payment (402) and throttling (429) failures are HTTP errors, raised by the transport before any tool result exists. Some MCP hosts restrict tool names to `[A-Za-z0-9_-]`; if yours rejects the dot in `phone_intel.lookup`, use the REST endpoint.

## Over raw HTTP

```bash
# 1. Ask. No payment yet: you get the x402 v2 challenge shown above (in the `payment-required`
#    response header and in the body).
curl -i 'https://phone-intel-mcp.fly.dev/lookup/%2B15165551234'

# 2. Sign the terms into a base64 PAYMENT-SIGNATURE header. In TypeScript this is:
#      const signed = await signPaymentPayload(signer, requirements);
#      const PAYMENT = encodePaymentSignatureHeader(signed);

# 3. Ask again with the payment.
curl -i -H "PAYMENT-SIGNATURE: $PAYMENT" 'https://phone-intel-mcp.fly.dev/lookup/%2B15165551234'

# v1 clients: send `X-PAYMENT: $PAYMENT_V1` instead. The server dual-decodes.
```

`{phone}` is a US number, ideally URL-encoded E.164 (`%2B15165551234`); `(516) 555-1234` and `5165551234` are normalized too. Don't log or share the URL if the number is sensitive: it is the number. (`HEAD` is gated and charged exactly like `GET`.)

## Errors

| HTTP | `error.code` | Meaning | Charged | What to do |
|---|---|---|---|---|
| 400 | `invalid_phone` | Missing, malformed, or not a valid number | No | Fix the input |
| 400 | `not_us_number` | A valid number outside +1 | No | US only |
| 402 | (none: the x402 challenge) | No valid payment. The body is the x402 v2 challenge above, not the envelope below, and has no `error.code`; its plain `error` string says why: `PAYMENT-SIGNATURE header is required`, `invalid_payment_header`, `invalid_network`, `invalid_exact_evm_payload_authorization_value`, `payment_already_used`, `insufficient_funds`, `invalid_exact_evm_payload_signature`, `settlement_failed`, ... | No | Sign a fresh payment for the terms in the body |
| 429 | `rate_limited` | Over 100 paid lookups in a rolling minute for your wallet | No | Wait `retry_after_seconds` (also `Retry-After`), then sign a fresh payment |
| 429 | `concurrent_request` | Your wallet already has a lookup in flight | No | Wait `retry_after_seconds` (2), then resend; the same payment header still works |
| 502 | `vendor_failure` | A vendor failed hard, e.g. the service's own credentials for it were rejected. (Timeouts and vendor 5xx degrade that section instead of failing the call.) | No | Retry later |
| 500 | `internal_error` | Unexpected server error | No | Retry later |

Errors other than 402 share one envelope: `{ "error": { "code": "...", "message": "..." } }`; the 429s carry `retry_after_seconds` instead of `message`.

## Limits

- **US numbers only** (+1). Anything else is `400 not_us_number`.
- **100 paid lookups per minute per paying wallet**, rolling window, counted across REST and MCP together.
- **One request in flight per wallet.** Use several wallets for parallelism, or queue.
- **EOA (externally-owned account) signatures only.** Smart-contract wallets (ERC-1271 / 6492: Safe, Coinbase Smart Wallet, Argent, etc.) are not supported. A payment whose signature is not a 65-byte signature by the wallet it names is rejected with `402 invalid_exact_evm_payload_signature` before anything is run.
- **p95 target under 2 seconds** for the lookup itself. Each vendor is bounded at 900 ms and a slow one degrades rather than blocking, with one exception: Yelp is bounded at 2.5 s (see the next point), so a number that has a business can take up to about 3.4 s. Payment verification and settlement are extra round trips on top of that.
- **Yelp calls route through a Vercel edge function** (`https://phone-intel-yelp-proxy.vercel.app`), because Yelp blocks datacenter IPs. It adds an extra network hop, typically well under a second, to uncached business lookups; a repeat lookup of the same number is served from the cache and does not call it. If the proxy is slow or unreachable the lookup still succeeds, with `business_match` `null`.
- `GET /health`, `GET /openapi.json`, `GET /stats`, MCP `initialize` and `tools/list` are free and never rate limited.

## Health

`GET https://phone-intel-mcp.fly.dev/health` returns `{ "status": "ok", "version": "…" }`. The service scales to zero when idle, so the first request after a quiet period can take a few seconds longer.
