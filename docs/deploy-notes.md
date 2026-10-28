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
