# Launch listing content

Shared content for the four public listings (Smithery, mcp.so, PayAPI Market, and the x402 Bazaar via x402.new). Each directory draws from this file so copy stays identical across them. Numbers and example response here are kept in sync with `README.md` and `src/payment/discovery.ts`.

---

## One-liner (≤100 chars)

Pay-per-call US phone dossier for AI agents — $0.03 USDC via x402, no signup.

## Tagline (≤160 chars, SEO description)

One call turns a US phone number into a dossier: carrier, line type, the business behind it (name, hours, open-now, rating), and a spam-risk score. $0.03 USDC via x402.

## Longer description (for a listing page body)

**phone-intel-mcp** is a pay-per-call HTTP + MCP endpoint that turns a US phone number into a single-shot dossier an agent can drop into a pre-call briefing or an inbound-call context. One call returns:

- **Carrier and line type** (mobile, landline, VoIP, toll-free, unknown), plus CNAM caller-name where available.
- **Business match** — name, category, address, 7-day hours, open-now flag, Google rating, place_id, yelp_id. `null` if no business is at that number.
- **Reputation** — composite spam-risk score (0–100), robocall / DNC / VoIP-risk flags.
- **Classification** — `business`, `consumer_mobile`, `consumer_landline`, `voip`, `toll_free`, or `unknown` so the agent knows what tier of answer it got.

**Payment: $0.03 USDC per lookup, on Base mainnet, via x402 v1.** No signup, no API key, no credit card. The paying wallet needs USDC on Base and nothing else; the facilitator pays gas. You are charged only on a 2xx response — malformed numbers, vendor failures and rate-limit rejections never settle.

**Target workflow:** voice-AI agents (Vapi, Retell, Bland, OpenAI Realtime, and vertical builders on top of them) that need to know who is behind an inbound number, or whether an outbound number is a legitimate business, in under two seconds.

**p95 under 2 seconds** on cache hit; up to about 3.4s on a cold business lookup. 100 paid lookups per minute per wallet. One request in flight per wallet.

## Endpoints

| | |
|---|---|
| Base URL | `https://phone-intel-mcp.fly.dev` |
| REST | `GET /lookup/{phone}` |
| MCP (Streamable HTTP) | `POST /mcp` — tool `phone_intel.lookup` |
| Health | `GET /health` (free, unrate-limited) |

## Example request (REST)

```bash
# 1. Unpaid — returns 402 with the x402 challenge body
curl -i 'https://phone-intel-mcp.fly.dev/lookup/%2B15165551234'

# 2. Sign the challenge into an X-PAYMENT header (any x402 v1 client lib does this), then
curl -i -H "X-PAYMENT: $PAYMENT" 'https://phone-intel-mcp.fly.dev/lookup/%2B15165551234'
```

## Example response (illustrative)

```json
{
  "phone": "+15165551234",
  "number_classification": "business",
  "carrier": { "name": "Spectrum Business", "type": "landline" },
  "caller_name": "GARDEN CITY HARDWARE",
  "business_match": {
    "name": "Garden City Hardware",
    "category": "Hardware Stores",
    "address": { "line1": "100 Franklin Ave", "city": "Garden City", "state": "NY", "postal": "11530" },
    "hours": { "monday": [{ "open": "07:30", "close": "18:00" }] },
    "is_open_now": true,
    "rating": { "stars": 4.6, "count": 212 },
    "place_id": "ChIJ-example-place-id",
    "yelp_id": "garden-city-hardware-garden-city"
  },
  "reputation": { "spam_risk_score": 3, "is_known_robocall": false, "is_dnc_listed": null, "is_voip_risk": false },
  "meta": {
    "lookup_id": "3f0c7a52-6a52-4b8e-9d3b-0f6f1f6d2a11",
    "schema_version": "v1",
    "cached_fields": ["carrier", "reputation"],
    "timestamp": "2026-10-28T14:03:11.482Z"
  }
}
```

## Tags / categories

`phone`, `lookup`, `voice-ai`, `agents`, `x402`, `usdc`, `base`, `mcp`, `business`, `reputation`, `caller-id`, `cnam`, `spam-risk`

## Pricing

Single tier, **$0.03 USDC per lookup**. No freemium, no monthly fee, no volume discount.

## Links

- Service: https://phone-intel-mcp.fly.dev
- MCP endpoint: https://phone-intel-mcp.fly.dev/mcp
- GitHub: (filled in once the public repo lands)
- Author: Jeff Shaw (jeffrey.shaw4@gmail.com)
- Payment wallet: `0x921f9ad89600518D16e33Ae5e0cEd069e355F4dE` (Base mainnet, USDC)

## Per-directory submission notes

### PayAPI Market — https://payapi.market/list

Free, email-verified listing. Form takes three steps.

- Step 1 (Your Details): Name = Jeff Shaw, Email = jeffrey.shaw4@gmail.com, Company (optional) = (leave blank or "Swift Roadside Service LLC" if a company is required).
- Step 2 (Your API): URL = https://phone-intel-mcp.fly.dev, paid route = `/lookup/{phone}` (or whatever their field asks for), Base USDC wallet = `0x921f9ad89600518D16e33Ae5e0cEd069e355F4dE`, price = $0.03.
- Step 3 (Review): submit.

They run one $0.03 canary call themselves (cap is $0.10, we're under). Listing goes live once their test call succeeds and a human has reviewed. One email with the result.

### Smithery — https://smithery.ai/new

Signin required (Google / GitHub / WorkOS email). Points at a public GitHub repo and scans the MCP server at the URL you give it.

- Signin: use Jeff's github (JeffreyJeffersonJeffers) or Google account.
- Repo URL: https://github.com/JeffreyJeffersonJeffers/phone-intel-mcp (once the public repo exists; see below).
- MCP URL: https://phone-intel-mcp.fly.dev/mcp
- Transport: Streamable HTTP
- Scanner should now accept the server — resources/list and prompts/list answer with empty lists (commit `aa4b35c`).

### mcp.so — https://mcp.so/submit

Signin required. Repository URL + name are the two main fields. Free tier goes through human review; $39 premium publishes immediately with a verified badge and a dofollow link.

- Default: free tier. Can revisit paid later if traffic justifies.
- Repository URL: https://github.com/JeffreyJeffersonJeffers/phone-intel-mcp.
- Name: `Phone Intel MCP`.
- Description: the one-liner above.
- Tag: `x402` (per plan.md).

### x402 Bazaar / x402.new — DEFERRED

No submission form. The Coinbase CDP facilitator catalogs services during verify/settle when the 402 carries `extensions.bazaar`, which ours now does (commit `18fd466`).

**Current state (2026-10-29):** we are NOT in the Bazaar after a confirmed paid settlement on the new build (tx `0x11de8b8ae8e707ec5605e5876648e7d5f764fd0ee355a641d77ea0468a6632be`). Every one of the 20,345 Bazaar listings is `x402Version: 2`; zero `x402Version: 1` entries exist. Our server uses `x402: 1.2.0` and emits `x402Version: 1`. The facilitator's current indexing path is effectively v2-only. GitHub issue [x402-foundation/x402#2112](https://github.com/x402-foundation/x402/issues/2112) tracks the broken `EXTENSION-RESPONSES` header on CDP settlements that also prevents cataloging for some v2 setups.

**Follow-up:** upgrade to x402 v2 (switch from `x402` package to `@x402/core` + `@x402/evm` + `@x402/extensions/bazaar`) once that work is scheduled. Our bazaar block already matches the v2 wire shape, so the content side of the change is done.

Alternative discovery tools reported working by other v1 services: **x402scan** and **awesome-x402** — worth exploring as cheap wins while Bazaar is unresolved.

### agentstools — https://agentstools.ai (per plan.md's "if accepted")

Lower priority, revisit after the three above are live.

## Launch posts (deferred to Tuesday–Thursday morning US time, next week)

Draft text lives separately once the directory listings have been live for 24–48 hours.
