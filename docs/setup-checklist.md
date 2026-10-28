# Account Setup Checklist

Work through these in order. When you finish an account, write the credential name + value in `.env.local` at the repo root (I will create a `.env.example` template once build starts; for now, just save keys somewhere safe — password manager is fine). Don't paste any key into chat.

**Status column meaning:** `[ ]` not started, `[~]` in progress, `[x]` done.

---

## 1. Yelp Fusion API key — start here (fastest, free, instant)

- [ ] Go to https://docs.developer.yelp.com/docs/fusion-intro
- [ ] Click "Get Started" → create a Yelp developer account
- [ ] Create a new app (name: "phone-intel-mcp", any description)
- [ ] Copy the **API Key** (not the Client ID)
- [ ] Save as `YELP_API_KEY`

**Expected time:** 5 min. **Cost:** $0.

---

## 2. IPQualityScore account

- [ ] Go to https://www.ipqualityscore.com/create-account
- [ ] Sign up (free tier gives 5,000 phone lookups/month)
- [ ] Dashboard → Account → copy your **Private API Key**
- [ ] Save as `IPQS_API_KEY`

**Expected time:** 5 min. **Cost:** $0 for v1. Upgrade to Premium ($30/mo) when we're doing real volume.

---

## 3. Twilio account

- [ ] Go to https://www.twilio.com/try-twilio
- [ ] Sign up with your email, verify phone number
- [ ] Add $20 prepaid float (credit card required)
- [ ] Dashboard → copy **Account SID** and **Auth Token**
- [ ] Save as `TWILIO_SID` and `TWILIO_TOKEN`
- [ ] (No toggle needed — Lookup v2 "Line Type Intelligence" and "Caller Name" are called per-request via the API's `Fields=` parameter. Billing kicks in only when the request includes them. Nothing to enable in the console.)

**Expected time:** 15 min. **Cost:** $20 prepaid, drawn down at ~$0.015/lookup.

---

## 4. Google Cloud project + Places API

- [ ] Go to https://console.cloud.google.com and sign in with your Google account
- [ ] Create a new project named "phone-intel-mcp"
- [ ] Enable billing on the project (credit card; $300 free trial credit applies)
- [ ] APIs & Services → Library → enable **Places API (New)**
- [ ] APIs & Services → Credentials → Create Credentials → API Key
- [ ] Restrict the key: Application restrictions = none for now (we'll lock to Fly.io IP later); API restrictions = Places API only
- [ ] Save as `GOOGLE_PLACES_API_KEY`

**Expected time:** 20 min. **Cost:** $0 during trial. Then ~$0.005–0.017/call cached heavily.

---

## 5. Supabase (Postgres cache)

- [ ] Go to https://supabase.com and sign up with GitHub
- [ ] Create new project named "phone-intel-mcp"; pick the US-East region; set a strong database password (save it)
- [ ] Settings → Database → Connection string → **URI** (session mode)
- [ ] Save the full URI as `DATABASE_URL`

**Expected time:** 10 min. **Cost:** $0 (free tier is 500 MB, way more than we need).

---

## 6. Fly.io

- [ ] Install the CLI: `brew install flyctl` in Terminal
- [ ] Run `fly auth signup` and complete signup
- [ ] Add credit card (needed to launch apps; charges will be pennies/mo at our scale)
- [ ] You will not run `fly launch` yet — the implementer subagent does that in Task 1

**Expected time:** 10 min. **Cost:** ~$0–5/mo once deployed, scales to zero when idle.

---

## 7. Coinbase CDP (Developer Platform)

- [ ] Go to https://portal.cdp.coinbase.com and sign in with your existing Coinbase account (or create one)
- [ ] Complete the developer verification (basic ID check — same KYC as regular Coinbase)
- [ ] Create a new project named "phone-intel-mcp"
- [ ] Project → API Keys → create a new server API key
- [ ] Save the API Key Name + Private Key as `CDP_API_KEY` and `CDP_API_SECRET`
- [ ] (No manual wallet creation — CDP server wallets are SDK-only. The implementer subagent creates the wallet via the SDK during Task 10 of the build; `WALLET_ADDRESS` is filled in then.)

**Expected time:** 30–60 min including KYC. **Cost:** $0.

---

## 8. Base-Sepolia test USDC (for end-to-end payment testing)

- [ ] Install a browser wallet (Coinbase Wallet, MetaMask, or Rainbow) if you don't have one
- [ ] Switch to the **Base Sepolia** test network in the wallet
- [ ] Go to https://portal.cdp.coinbase.com/products/faucet and request Base-Sepolia USDC
- [ ] This test wallet is separate from your CDP server wallet; it's used to pay our endpoint during tests

**Expected time:** 10 min. **Cost:** $0.

---

## When you're done

- Save all values in a password manager or a secure note.
- Create a file at `/Users/Joy/phone-intel-mcp/.env.local` and paste all the key=value pairs. **This file is gitignored — it never gets committed.**
- Tell me "setup done" and I'll start the build.

Total expected time across all 8: **2–3 hours** of elapsed time, mostly waiting on verifications. Total upfront cost: **~$20** (the Twilio float).
