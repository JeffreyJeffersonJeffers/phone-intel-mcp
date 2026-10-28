# Deploy notes (mainnet)

Operator checklist for the first production deploy and for any deploy that touches payment or logging.
Nothing here is run by the build; each step is a person's decision.

## Before `fly deploy`

1. **CDP still lists x402 v1 on Base mainnet.**
   `npx tsx --env-file=.env.local scripts/check-cdp-mainnet.ts` must exit 0. Exit 1 means the facilitator
   no longer lists v1/`exact`/`base` (a v2 migration is needed first); exit 2 means the check itself failed.
2. **Secrets.** Besides the vendor keys, `CDP_API_KEY`, `CDP_API_SECRET` and `WALLET_ADDRESS`, production
   now needs **`LOG_PHONE_HMAC_KEY`**: the server refuses to start without it (at least 32 characters).
   Generate it once and set it as a secret; keep it stable, because changing it changes every `phone_hash`
   and breaks correlation with older logs.
   `openssl rand -hex 32`

   Also **`SCRAPERAPI_KEY`**. Yelp answers 403 to Fly's (datacenter) addresses, so on Fly the Yelp calls go
   through ScraperAPI; without the key they go direct and Yelp refuses them (the lookup then fails with a
   Yelp authentication error, see below). Sign up for a key at https://www.scraperapi.com (no card needed) and set it as a secret. **Mind the
   quota:** ScraperAPI's pricing page gives a 7-day trial of 5,000 credits, and the free plan after that is
   **1,000 credits with at most 5 concurrent connections**, not 5,000 a month. Paid plans start at Hobby,
   $49/month for 100,000 credits and 20 concurrent threads. Nothing else needs to change: the server
   starts without it, which is right for local development from a home connection.
3. **Migrations.** The Task 6 `enrichment_*` columns must already be applied to the production database.
4. **One machine.** Deploy with `--ha=false`. The rate limiter, the per-wallet in-flight slots and the
   replay-nonce ledger are all in memory and single-instance; a second machine needs a shared store
   (Redis) for all three first. They also reset when Fly stops an idle machine, which is safe (an
   authorization expires within 70 s of signing).

## After deploy: the check that proves the in-flight cap against CDP

The cap holds a payer's slot from before `/verify` until after `/settle`, on the assumption that once
`/settle` returns the payer's balance has already dropped, so the next `/verify` for that wallet sees the
smaller balance. That is a property of CDP's facilitator, not of our code, so test it once for real:

1. Fund a fresh wallet with **exactly 0.03 USDC** on Base (plus nothing else is needed; the facilitator
   pays gas).
2. Send one paid lookup. It should return 200 with an `X-PAYMENT-RESPONSE` header, and the USDC should
   land in the receiving wallet.
3. Immediately send a second paid lookup with a **fresh** authorization from the same wallet.
4. The second must be refused at **`/verify`** (`402`, `error: "insufficient_funds"`), and the lookup must
   not have run. If instead it passes `/verify` and fails at `/settle` (`settlement_failed`), the
   assumption is false for CDP: a payer could get free vendor calls, and the cap needs re-review before
   real traffic.

Also confirm the first payment itself end to end (plan step 6): `/health` answers, a paid
`/lookup/%2B1…` call returns a dossier, and the transfer shows on-chain. `/supported` listing v1 is
necessary, not proof that `/verify` and `/settle` accept our payload.

## Things to watch in the logs after launch

- `payment: "settlement_failed"` rate: a payer who cancels or moves the funds between `/verify` and `/settle`
  gets one free lookup. Cost to them is gas; to us about one vendor round. A rising rate is the signal.
- `payment: "concurrent_request"` against `payment: "verified"`: a high ratio means clients are sending a
  second request while one is still in flight. (That line is written before the payer is known, so it has
  no `wallet_address_last6`; the `verified` lines do.) It cannot be someone naming payer addresses they
  don't control: EOA-signed requests cannot be griefed, because the signature is checked locally before
  a slot is taken, and v1 does not accept smart-wallet signatures (ERC-1271/6492), so no griefable path
  exists for them either.
- `payment: "facilitator_error"` at error level: the facilitator is failing, not rejecting payments.
- `latency_ms` on the lookup line is measured in the handler: it includes payment verification and
  excludes settlement. Fastify's own `request completed` line (`responseTime`) includes settlement.

## ScraperAPI (the Yelp proxy)

With `SCRAPERAPI_KEY` set, each uncached Yelp lookup is one GET to `https://api.scraperapi.com/` with our
Yelp URL in `url=` and `keep_headers=true`, which makes ScraperAPI forward our `Authorization: Bearer <Yelp
key>`. It costs one credit; a cache hit costs none. Things that follow from how it works
(https://docs.scraperapi.com/responses-and-formats/api-status-codes):

- **Its status codes are its own.** `401` is a bad `SCRAPERAPI_KEY`; `403` is the monthly credits used up;
  `429` is more concurrent requests than the plan allows (5 on the free plan: a burst of more than five
  uncached business lookups at once will lose the extra ones to "no business", silently, because a `429`
  degrades); `500` means it failed after its own retries (not charged); `200` and `404` are the target's.
- **A bad `SCRAPERAPI_KEY` (`401`) stops the lookup.** It throws `ScraperAPI auth failed (HTTP 401): invalid
  SCRAPERAPI_KEY`, so every lookup that needs Yelp is a `502 vendor_failure` (not charged to the payer) and the
  message appears in the `adapter_errors` of a `lookup failed: vendor failure` log line. That is a
  configuration error to fix, not a capacity limit.
- **When the credits run out (`403`), Yelp degrades** (`business_match: null`; the number is classified from
  its line type), the payer is charged as usual, and nothing is cached for the number. **Monitor the Fly logs
  for the line `scraperapi_credits_exhausted`** (error level, written once per lookup that needed Yelp):

  ```
  {"level":50,...,"vendor":"scraperapi","status":403,"msg":"scraperapi_credits_exhausted"}
  ```

  When it appears, upgrade the plan (or wait for the monthly reset) and watch the balance in the
  ScraperAPI dashboard. It has no `request_id` (it is written beneath the request, by the Yelp adapter);
  correlate by time. Dossiers served in that state are charged in full and have no business, hours or
  rating, so treat the line as an incident, not noise.
- **A revoked or broken Yelp key may not be loud any more.** ScraperAPI only documents `200` and `404` as the
  target's answers; any other target failure it retries for up to 70 s and then reports as `500`. Our limit
  for a proxied call is 5 s, so such a call times out and the lookup degrades to "no business". We still
  throw on a Yelp `TOKEN_INVALID` body if one comes through, but do not count on it. If business matches
  suddenly vanish, test the Yelp key directly from a machine Yelp does not block.
- **A timeout costs a credit.** ScraperAPI charges for a request we cancel before its 70 s window ends, and
  its median latency (about 2 s) is well under our 5 s limit now.
- **Latency.** A number with a business can now take up to 5 s (Yelp) + 0.9 s (Google) = 5.9 s, over the
  2 s target.
- **Privacy.** ScraperAPI sees the phone number being looked up (it is in the Yelp URL) and our Yelp API
  key, in addition to Yelp.

After deploy, look up a number that has a Yelp listing and check that `business_match` is not `null`.
