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

   Also **`YELP_PROXY_URL`** and **`YELP_PROXY_AUTH`**, together. Yelp answers 403 to Fly's (datacenter)
   addresses, so on Fly the Yelp calls go through our proxy on Vercel (project `phone-intel-yelp-proxy`):
   `YELP_PROXY_URL` is its base URL (`https://phone-intel-yelp-proxy.vercel.app`) and `YELP_PROXY_AUTH` is
   the shared secret, which must equal `PROXY_AUTH_SECRET` in the Vercel project. The Yelp key itself now
   lives in the Vercel project (`YELP_API_KEY` there); Fly does not need it while the proxy is in use. Keep
   it on Fly only for the local-development direct-call fallback. **If only one of the two is set the
   server calls Yelp directly, and on Fly that is a Yelp 403 and a `502` on every lookup.**
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

## The Yelp proxy (Vercel)

With `YELP_PROXY_URL` and `YELP_PROXY_AUTH` set, each uncached Yelp lookup is one
`GET <YELP_PROXY_URL>/api/yelp?phone=%2B1…` with an `X-Proxy-Auth` header and **no** Yelp `Authorization`
(the proxy adds the Yelp key itself, so it never leaves Vercel). The proxy returns Yelp's response verbatim,
status and body, plus a few errors of its own. Source: `phone-intel-yelp-proxy/api/yelp.ts`. A cache hit
makes no call.

How our errors map (all of these end up in the `adapter_errors` of a `lookup failed: vendor failure` log
line, as a `502 vendor_failure` that is not charged to the payer):

| Message | Meaning | Fix |
|---|---|---|
| `Yelp proxy auth failed (HTTP 401)` | The proxy said `unauthorized`, or answered with a non-JSON 401 page. | `YELP_PROXY_AUTH` differs from `PROXY_AUTH_SECRET` on Vercel, or Vercel's Deployment Protection is on for the project. |
| `Yelp proxy rejected request (HTTP 400)` | The proxy said `invalid_phone` (it takes only `+1` and ten digits). | A bug on our side: we only send normalized US E.164. |
| `Yelp proxy misconfigured (HTTP 500)` | The proxy has no `YELP_API_KEY`. | Set it in the Vercel project. |
| `Yelp authentication failed (HTTP 401 or 403)` | Yelp itself refused the key held by the proxy, or Yelp blocks Vercel's addresses too. | Check the Yelp key in Vercel; test the proxy. |

The proxy's own errors have a string `error` ("unauthorized") and Yelp's an object, which is how the two are
told apart, since the proxy passes Yelp's statuses through unchanged. Everything else degrades quietly to "no
business" and is not cached: the proxy's `502 upstream_failure`, Vercel's own 5xx, Yelp's 429 and 5xx. **Only
a timeout is logged**: a `yelp_timeout` line at warn level, with `vendor`, `proxied` and `timeout_ms`
(2500 through the proxy, 900 direct). It has no `request_id`; correlate by time. If business matches
suddenly vanish, look for `yelp_timeout` lines and test the proxy by hand.

- **Latency.** The limit through the proxy is 2.5 s, so a number with a business can take up to 2.5 s (Yelp)
  + 0.9 s (Google) = 3.4 s, over the 2 s target.
- **Privacy.** The phone number being looked up is in the proxy URL's query string. Vercel can show request
  URLs in its logs, so numbers may appear there, outside our "no raw phone in logs" rule. Keeping them out
  needs the proxy to take the number in a header or a POST body.
- **Vercel's terms.** The proxy is on Vercel's free Hobby plan. As I understand Vercel's fair-use terms that
  plan is for personal, non-commercial use, which this is not; check before relying on it, and expect to
  need a paid plan.

After deploy, look up a number that has a Yelp listing and check that `business_match` is not `null`.
