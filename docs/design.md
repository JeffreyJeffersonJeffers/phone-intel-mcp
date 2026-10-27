# Phone Intel MCP — Design Document

**Status:** Design (awaiting Jeff approval). Created 2026-10-27.
**Owner:** Jeff (non-technical lead); Claude Code executes.
**Classification:** Software project. Side build with capped time budget.

---

## Intent

Build a pay-per-call MCP server + plain HTTP endpoint that voice-AI agents (Vapi, Retell, Bland, OpenAI Realtime, and vertical builders on top of them) call to get a **composite dossier on a US phone number** in a single request. Agents pay in USDC on Base via the x402 protocol. No signup, no API key, no credit card, no SDK. Wallet → endpoint → paid → JSON.

## Why now

- The x402 protocol (Coinbase) is live and has been adopted by a growing but still-small ecosystem (61 x402-tagged MCP servers on mcp.so, 359 tools on agentstools as of this scan).
- Voice-AI agents are the hottest agent category in late 2026 — all of them have the same pre-call and inbound-call need: "who is this number, is this legit, is this business open, is this a known spammer?"
- Existing phone-via-x402 tools (SiteCheck Agent Intel, Phone Validation X402 MCP, ClawRouter, Truecaller MCP) all ship the **thin slice** (carrier + line type at $0.002, or basic validation). None bundles business match + reputation + hours + spam-risk + caller name into one call.
- The composite tier at **$0.02–0.05** is genuinely empty right now. Early-not-first — pioneers are 6–12 months ahead in the thinner tier; we enter one tier up.

## Goals

1. Ship a working MCP server + HTTP endpoint listed on x402.org, Smithery, mcp.so, and PayAPI Market within **4–6 weeks** of design approval.
2. Charge **$0.03/call** via x402. Target variable cost under $0.015/call steady-state via caching.
3. Produce output voice agents can drop directly into pre-call briefings and inbound-call context — no stitching required by the agent.
4. Break even at **~1,500–2,000 paid calls/month** against ~$30/mo fixed burn.
5. Pivot path to Stripe-billed API in one weekend if x402 adoption stalls.

## Non-goals (v1)

- International phone number support. US only.
- Marketplace / multi-provider aggregation of lookups.
- Human-in-the-loop verification.
- Rich human-facing UI or dashboard. This is an agent endpoint.
- Realtime HLR status. Static libphonenumber + Twilio Lookup is sufficient.
- Owner-identity lookup for consumer cell phones (compliance; see below).

## Anti-goals (what makes this a failure even if it "works")

- p95 latency over 2 seconds. Voice agents need sub-2s or they drop the tool.
- Output no deeper than the $0.002 competitors — if we don't visibly beat the thin tier, we're not justified at $0.03.
- Vendor-cost blowup from poor caching. We must defend the margin from day 1.
- Single-vendor lock-in on any critical field.
- Jeff spends more than **25 hours of personal time** end-to-end on build + launch. If it starts to exceed, we scope down, not expand.

## Constraints

- Jeff is non-technical. Claude Code writes the code; Jeff reviews and approves changes.
- Total upfront spend: **under $200** (vendor prepaid floats, domain, incidentals).
- Monthly fixed burn: **under $50** until revenue appears. Scale-to-zero hosting required.
- Must survive x402 failure. Payment layer is isolated; Stripe pivot is a weekend.
- Compliance: output restricted to **business numbers and public-record data**. No reverse-lookup of personal consumer cell phones in a way that violates state privacy laws (CA, IL, FL, PA, VT). Caller-name field returns only CNAM/public-business-registry matches, never aggregated-data-broker consumer identity.
- No long-term storage of lookup results beyond cache TTL. No cross-querier correlation.

## Decisions (the "how")

**Language and runtime:** Node.js / TypeScript. Fits Coinbase's x402 reference libraries, the dominant MCP server examples, and matches the stack already in use elsewhere in Jeff's work (business-os).

**Hosting:** Fly.io. Scale-to-zero, low fixed cost, global edge for latency, easy TypeScript deploy. Railway as backup if Fly.io quotas bite.

**Database (cache):** Postgres on Supabase or Neon free tier. Single table keyed by E.164 phone number with per-field TTLs. 7-day TTL on static fields (carrier, line type, business match, address). 24-hour TTL on dynamic fields (hours "open now", spam-risk score).

**Payment:** x402 protocol via Coinbase CDP server wallet on Base. USDC collection on-chain. Weekly or monthly batch off-ramp through Coinbase Advanced to USD. Both MCP tool and HTTP endpoint enforce payment.

**Data sources (v1):**
- **Twilio Lookup** — carrier, line type, caller name where CNAM is available. Expect null caller name on most US mobile numbers (CNAM is largely landline). Schema signals null vs. unavailable clearly so agents know what they got. ~$0.015/call bundle.
- **Yelp Fusion API (primary reverse-phone → business resolution).** Free tier covers early volume; paid is cheap. Chosen over Google Places as primary because Google Places reverse-phone requires Text Search (~$0.032/call), which breaks unit economics on cold hits.
- **Google Places (enrichment only).** Called after Yelp (or cache) resolves a business — pulls hours, rating, place_id. Not on cold-cold calls. Cached per place_id so repeats cost zero.
- **IPQualityScore (primary reputation + spam-risk).** Self-serve onboarding. Composite spam-risk + robocall + DNC + consumer-complaint signal. ~$0.003–0.01/call.
- **BBB / FTC Consumer Sentinel: deferred from v1.** BBB ToS forbids scraping; FTC Consumer Sentinel isn't per-phone queryable. v1 reputation field is IPQS composite. Revisit if a licensed partner becomes viable.

**Interface:**
- **HTTP endpoint (primary surface).** `GET /lookup/{phone}` returning JSON. x402 payment enforced here. This is where the money lands.
- **MCP server over Streamable HTTP transport.** Standard MCP tool manifest wrapping the HTTP endpoint. Discoverable via Smithery, mcp.so, PayAPI Market. Payment flows through the same HTTP endpoint.
- **Stdio MCP shim: deferred post-launch.** A thin local proxy agents could install if they want in-process MCP semantics (e.g., Claude Desktop users). Still calls the paid remote endpoint under the hood. Ship only if demand appears.

**Pricing:** Single tier, **$0.03 per call**. No freemium. No volume discount in v1 (can add later once we see demand curve).

**Consumer-cell handling:** When the number resolves to a consumer mobile (not a business), return a reduced payload — line type, carrier, spam-risk, DNC flag, `business_match: null` with a reason — and charge full $0.03. The schema's `number_classification` field tells the agent what tier of response it got. Rationale: the agent doesn't know line type in advance, we still ran paid vendor calls (Twilio + IPQS), and x402 refunds are nontrivial. v1.1 may add a cheap `GET /classify/{phone}` at ~$0.005 so cost-conscious agents can pre-filter.

**Legal entity / wallet ownership:** USDC lands in a Coinbase CDP server wallet owned by **Jeff personally**, reconciled onto his Schedule C as self-employment income. No new LLC in v1. Trigger to form a dedicated LLC: $5k/month sustained revenue for 3+ months. Swift Roadside LLC is explicitly not the vehicle — unrelated line of business, wrong liability posture to co-mingle.

**Caching strategy:** Cache hit returns in under 100ms, pays zero vendor cost, keeps full fee. Expected steady-state cache hit rate 30–60% once a volume base exists (agents hit lead lists and scheduled call batches with repeated numbers). Cold-call cost ~$0.015–0.025; cached effective cost ~$0.008–0.015.

**Distribution:**
- List on x402.org, Smithery, mcp.so, PayAPI Market, agentstools, 402.com.tr.
- Submit to Coinbase CDP agent-tool showcase.
- One short launch post on X and in the Coinbase agent-builder Discord.
- Hacker News Show HN post timed to listings going live.

**Working name:** `phone-intel-mcp` for the repo. Public product name TBD — Jeff's call. Placeholder: "PhoneIntel".

## Left to the builder

- Exact JSON response schema (should be versioned and documented; propose v1 shape and iterate).
- Rate-limiting + abuse protection design (per-wallet request budgets, pattern detection, auto-blocks).
- Logging and metrics schema for later data-compounding (what gets logged, with what retention, under what privacy posture).
- Secondary spam-risk source selection and failover order.
- Fly.io region selection and autoscaling parameters.
- Billing / reconciliation flow between CDP wallet and off-ramp.
- Error taxonomy — what the endpoint returns on bad input, no match, vendor timeout, vendor failure, over-rate.
- Observability stack — uptime pings, latency budgets per field, alerting thresholds.
- Specific MCP tool schema (name, description, parameter shape) tuned for agent discovery.

## Sizing and timeline

- **Design approval:** Jeff reviews this doc. One iteration expected. Target: 2026-10-27 to 2026-10-29.
- **Plan phase:** Short written implementation plan (step-by-step build order, verification gates). ~2 hours.
- **Build phase:** 15–25 hours of supervised build time over 2–4 weeks.
- **Launch:** Listings go live, Show HN post, Discord announce.
- **First meaningful revenue signal:** 2–3 months post-launch.

## Fallback / exit scenarios

- **x402 fails:** Rip out x402 middleware, drop in Stripe metered billing. One weekend. Same codebase, same endpoint, dollar-pricing instead of USDC.
- **Composite tier gets commoditized by a well-funded entrant:** Pivot to vertical specialization (e.g., "phone intel for roadside and towing operators" — leveraging Jeff's industry) or sell the asset.
- **Doesn't take off at all:** Shut down. Cost sunk ~$200 and 25 hours. Acceptable loss.

## Decisions resolved during builder review (2026-10-27)

Reviewer-agent pass surfaced seven questions. Resolution log for traceability:

- **Transport architecture** — HTTP-first via Streamable HTTP MCP transport. Stdio shim deferred post-launch. (Claude's call.)
- **Business-match vendor economics** — Yelp Fusion as primary reverse-phone resolver; Google Places as cached enrichment only. Google reverse-phone would have required Text Search at ~$0.032/call cold, which breaks unit economics. (Claude's call.)
- **CNAM / caller-name on mobile** — accept nulls on US mobiles; schema signals clearly. (Claude's call.)
- **Consumer-cell behavior** — reduced payload at full price with explicit `number_classification`. (Jeff's call.)
- **Spam-risk vendor** — IPQualityScore as primary for v1 (self-serve onboarding fits ship window). Upgrade path to Hiya/Nextcaller if revenue justifies. (Claude's call.)
- **BBB / FTC reputation data** — dropped from v1 (BBB ToS forbids scraping; FTC Consumer Sentinel isn't per-phone queryable). Pitch bullet changes from "FTC/BBB complaint flag" to "composite reputation and spam-risk score." (Claude's call.)
- **Legal entity holding CDP wallet** — Jeff personal / Schedule C. New LLC trigger at $5k/mo sustained for 3+ months. (Jeff's call.)
