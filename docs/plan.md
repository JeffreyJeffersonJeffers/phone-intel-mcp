# Phone Intel MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a US-phone-number → composite-dossier HTTP endpoint and MCP server, with x402 USDC pay-per-call on Base.

**Architecture:** Fastify HTTP server behind an x402 payment middleware. One route (`GET /lookup/:phone`) fans out to four vendor adapters (Twilio, Yelp Fusion, Google Places, IPQualityScore), aggregates the results into a single `Dossier`, caches per-field in Postgres with per-field TTLs, and returns JSON. The same route is exposed as an MCP tool (`phone_intel.lookup`) through the Streamable HTTP transport, so MCP clients and raw HTTP callers share one surface and one payment path.

**Tech Stack:** Node.js 20 LTS, TypeScript 5, Fastify 4, `@modelcontextprotocol/sdk` (Streamable HTTP transport), Coinbase x402 reference middleware for Fastify, `postgres` client, Supabase Postgres (free tier), Twilio Node SDK, `@googlemaps/google-maps-services-js`, raw `fetch` for Yelp Fusion and IPQS, `vitest` for tests, `pino` for logs, Fly.io for hosting.

**Spec:** `memory/projects/phone-intel-mcp.md`

## Global Constraints

- Node.js **20 LTS** minimum; TypeScript **strict: true**.
- US (country code **+1**) numbers only; non-US input returns `400 { error.code: "not_us_number" }` without any vendor call.
- Monthly fixed burn target **under $50**. Hosting must scale to zero.
- p95 latency **under 2000 ms** end-to-end for a cold-cache lookup.
- Single pricing tier: **$0.03 USDC per paid call** on Base mainnet; Base-Sepolia for test runs.
- Response schema is **versioned `v1`**; the `schema_version` field is literal `"v1"`.
- Consumer-mobile responses return `business_match: null` with `number_classification: "consumer_mobile"`; **full price still charged**.
- No persistence of lookup inputs or outputs beyond the per-field TTLs in the cache table (7 d for carrier and business match, 24 h for reputation, 1 h for hours/is-open-now). A background job prunes rows unread for 30 days.
- CDP wallet is a server-side Coinbase CDP wallet owned by Jeff personally; USDC lands there, no third-party custody.

## Review Focus

The spec implies these inputs or failure modes but no task's happy-path test catches them. Each is pinned to the task that owns the code; the test is added to that task's step list under its own numbering.

1. **Non-US number input** — a `+44` phone must return `400 { error.code: "not_us_number" }` and make zero vendor calls (owner: Task 2).
2. **Malformed `:phone` path parameter** — letters, SQL fragments, path traversal, or over-long input must return `400 { error.code: "invalid_phone" }` and not reach the composer (owner: Task 2).
3. **Single vendor timeout** — if one of the four vendor calls hangs past its per-vendor budget (900 ms), the dossier returns within the overall 2 s budget with that vendor's fields marked degraded, not a 500 (owner: Task 7).
4. **Stale cache poison** — a manual cache-invalidate helper must exist so one bad vendor response does not get served for 7 days (owner: Task 3).
5. **Payment settles after vendor calls ran, but response delivery fails** — the composed dossier must be written to the cache before the response is streamed, so a retry on the same phone within TTL serves from cache at zero vendor cost (owner: Task 9).

---

## File Structure

```
phone-intel-mcp/
├── src/
│   ├── index.ts
│   ├── server.ts
│   ├── env.ts
│   ├── http/
│   │   ├── lookupRoute.ts
│   │   └── healthRoute.ts
│   ├── mcp/
│   │   ├── mcpServer.ts
│   │   └── tools/lookupTool.ts
│   ├── payment/
│   │   ├── x402Middleware.ts
│   │   └── wallet.ts
│   ├── vendors/
│   │   ├── twilio.ts
│   │   ├── yelp.ts
│   │   ├── googlePlaces.ts
│   │   └── ipqs.ts
│   ├── cache/
│   │   ├── schema.sql
│   │   └── cache.ts
│   ├── dossier/
│   │   ├── compose.ts
│   │   └── types.ts
│   ├── middleware/
│   │   ├── rateLimit.ts
│   │   └── requestLog.ts
│   └── lib/
│       └── phone.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── fly.toml
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env.example
└── README.md
```

Each file has one responsibility; vendor adapters are split so one vendor's outage or re-selection does not touch another.

---

### Task 1: Project scaffold and health endpoint

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `fly.toml`
- Create: `src/index.ts`, `src/server.ts`, `src/env.ts`, `src/http/healthRoute.ts`
- Test: `tests/integration/health.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `buildServer(): FastifyInstance` in `src/server.ts`
  - `env` object in `src/env.ts` with typed access to `DATABASE_URL`, `TWILIO_SID`, `TWILIO_TOKEN`, `YELP_API_KEY`, `GOOGLE_PLACES_API_KEY`, `IPQS_API_KEY`, `CDP_API_KEY`, `CDP_API_SECRET`, `WALLET_ADDRESS`, `PORT`, `NODE_ENV`
  - `GET /health` → `200 { status: "ok", version: string }`

- [ ] **Step 1: Write the failing test**

```ts
it('GET /health returns 200 ok', async () => {
  const server = buildServer();
  const res = await server.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ status: 'ok' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/health.test.ts`
Expected: FAIL with module not found or `buildServer` undefined.

- [ ] **Step 3: Scaffold the project**

Initialize `package.json` with scripts `dev`, `build`, `start`, `test`. Install dependencies listed in Tech Stack. Configure `tsconfig.json` with `strict: true`, `moduleResolution: "bundler"`, `target: "ES2022"`. Configure `vitest.config.ts` with Node environment. Add `.env.example` listing every variable in the Interfaces block. Add `fly.toml` with `[http_service]`, `auto_stop_machines = true`, `auto_start_machines = true`, `min_machines_running = 0`, `[http_service.ports]` 443 and 80.

- [ ] **Step 4: Implement `buildServer()` in `src/server.ts` and the health route in `src/http/healthRoute.ts`**

`buildServer()` returns a Fastify instance with the pino logger wired, registers `healthRoute`, and nothing else. `healthRoute` reads `version` from `package.json` and responds `{ status: 'ok', version }`.

- [ ] **Step 5: Implement `src/env.ts`**

Export a frozen `env` object populated from `process.env` with each variable typed. Throw at startup if a required variable is missing.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/integration/health.test.ts`
Expected: PASS.

- [ ] **Step 7: Deploy to Fly.io and curl the deployed health endpoint**

Run: `fly launch --no-deploy` to generate app config, then `fly deploy`.
Expected: `curl https://<app>.fly.dev/health` → `200 {"status":"ok","version":"..."}`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "scaffold: fastify server with health endpoint deployed to fly"
```

---

### Task 2: Phone validation and E.164 normalization

**Files:**
- Create: `src/lib/phone.ts`
- Test: `tests/unit/phone.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `normalizePhone(raw: string): { e164: string } | { error: 'invalid_phone' | 'not_us_number' }` in `src/lib/phone.ts`

- [ ] **Step 1: Write the failing tests (happy + Review Focus 1 + Review Focus 2)**

```ts
it('normalizes a US 10-digit number to E.164', () => {
  expect(normalizePhone('5165551234')).toEqual({ e164: '+15165551234' });
});
it('normalizes with punctuation', () => {
  expect(normalizePhone('(516) 555-1234')).toEqual({ e164: '+15165551234' });
});
it('rejects non-US country code', () => {
  expect(normalizePhone('+447911123456')).toEqual({ error: 'not_us_number' });
});
it('rejects malformed input', () => {
  expect(normalizePhone("abc' OR 1=1")).toEqual({ error: 'invalid_phone' });
  expect(normalizePhone('../../etc/passwd')).toEqual({ error: 'invalid_phone' });
  expect(normalizePhone('1'.repeat(200))).toEqual({ error: 'invalid_phone' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/phone.test.ts`
Expected: FAIL — `normalizePhone` not defined.

- [ ] **Step 3: Implement `normalizePhone(raw)` in `src/lib/phone.ts`**

Use `google-libphonenumber`. Parse as US first; if country code is present and not `+1`, return `not_us_number`. If parse fails or number is not possible, return `invalid_phone`. Cap input length at 32 before parsing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/phone.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: E.164 phone normalization with US-only guard"
```

---

### Task 3: Postgres cache layer

**Files:**
- Create: `src/cache/schema.sql`, `src/cache/cache.ts`
- Test: `tests/integration/cache.test.ts`

**Interfaces:**
- Consumes: `env.DATABASE_URL`
- Produces:
  - `getCached<T>(phone: string, field: CacheField): Promise<T | null>` where `CacheField = 'carrier' | 'business' | 'reputation' | 'hours'`
  - `setCached<T>(phone: string, field: CacheField, value: T): Promise<void>` (writes JSONB + sets `<field>_cached_at = now()`)
  - `invalidate(phone: string, field?: CacheField): Promise<void>` — Review Focus 4
  - Per-field TTLs are enforced inside `getCached`: 7 d carrier/business, 24 h reputation, 1 h hours.

- [ ] **Step 1: Write the failing tests (round-trip + TTL expiry + invalidate)**

```ts
it('round-trips a carrier record', async () => {
  await setCached('+15165551234', 'carrier', { type: 'mobile', name: 'Verizon' });
  expect(await getCached('+15165551234', 'carrier')).toMatchObject({ type: 'mobile' });
});
it('returns null when a cached entry is past TTL', async () => {
  await setCached('+15165551235', 'reputation', { spam_risk_score: 10 });
  await sql`UPDATE phone_lookups SET reputation_cached_at = now() - interval '25 hours' WHERE phone_e164 = '+15165551235'`;
  expect(await getCached('+15165551235', 'reputation')).toBeNull();
});
it('invalidate removes a single field', async () => {
  await setCached('+15165551236', 'carrier', { type: 'mobile' });
  await invalidate('+15165551236', 'carrier');
  expect(await getCached('+15165551236', 'carrier')).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/integration/cache.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/cache/schema.sql`**

One table `phone_lookups` with primary key `phone_e164 TEXT`, four JSONB columns (`carrier_data`, `business_data`, `reputation_data`, `hours_data`) each paired with a `TIMESTAMPTZ` `<field>_cached_at`. Index `last_read_at TIMESTAMPTZ` for the TTL-pruning job.

- [ ] **Step 4: Implement `src/cache/cache.ts`**

Use the `postgres` client. `getCached` returns null if the cached-at timestamp is older than the per-field TTL. `setCached` uses `INSERT ... ON CONFLICT (phone_e164) DO UPDATE`. `invalidate(phone, field?)` clears one field (or all four if no field passed).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/integration/cache.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: postgres cache with per-field TTLs and invalidate"
```

---

### Task 4: Twilio Lookup adapter

**Files:**
- Create: `src/vendors/twilio.ts`
- Test: `tests/unit/vendors/twilio.test.ts`

**Interfaces:**
- Consumes: `env.TWILIO_SID`, `env.TWILIO_TOKEN`, cache from Task 3
- Produces:
  - `lookupTwilio(phoneE164: string): Promise<{ carrier: { name: string | null; type: 'mobile' | 'landline' | 'voip' | 'tollFree' | 'unknown' }; caller_name: string | null; cached: boolean }>`

- [ ] **Step 1: Write the failing tests**

```ts
it('maps Twilio line_type to our carrier.type', async () => {
  mockTwilio({ line_type_intelligence: { type: 'mobile' }, carrier_name: 'Verizon', caller_name: null });
  expect(await lookupTwilio('+15165551234')).toMatchObject({ carrier: { type: 'mobile', name: 'Verizon' }, caller_name: null, cached: false });
});
it('returns null caller_name on US mobile without CNAM', async () => {
  mockTwilio({ line_type_intelligence: { type: 'mobile' }, caller_name: null });
  expect((await lookupTwilio('+15165551234')).caller_name).toBeNull();
});
it('reads from cache on second call', async () => {
  mockTwilio({ /* one response */ });
  await lookupTwilio('+15165551234');
  const second = await lookupTwilio('+15165551234');
  expect(second.cached).toBe(true);
  expect(twilioCallCount()).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/vendors/twilio.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lookupTwilio` in `src/vendors/twilio.ts`**

Check cache first (`getCached(phone, 'carrier')`). On miss, call the Twilio Lookup v2 endpoint with the `line_type_intelligence` + `caller_name` fields. Map Twilio's `line_type` to our enum. `setCached` the result. 900 ms timeout.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/vendors/twilio.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: twilio lookup adapter with cache + 900ms timeout"
```

---

### Task 5: Yelp Fusion adapter

**Files:**
- Create: `src/vendors/yelp.ts`
- Test: `tests/unit/vendors/yelp.test.ts`

**Interfaces:**
- Consumes: `env.YELP_API_KEY`, cache from Task 3
- Produces:
  - `lookupYelp(phoneE164: string): Promise<{ business: null | { name: string; category: string; yelp_id: string; address: { line1: string; city: string; state: string; postal: string }; rating: { stars: number; count: number } | null }; cached: boolean }>`

- [ ] **Step 1: Write the failing tests**

```ts
it('resolves business by phone', async () => {
  mockYelp({ businesses: [{ id: 'y1', name: "Joe's Pizza", categories: [{ title: 'Pizza' }], location: { address1: '7 Carmine St', city: 'New York', state: 'NY', zip_code: '10014' }, rating: 4.5, review_count: 2100 }] });
  expect(await lookupYelp('+12125553333')).toMatchObject({ business: { name: "Joe's Pizza", category: 'Pizza' } });
});
it('returns business null on no match', async () => {
  mockYelp({ businesses: [] });
  expect((await lookupYelp('+15165551234')).business).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/vendors/yelp.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lookupYelp` in `src/vendors/yelp.ts`**

Check cache (`getCached(phone, 'business')`). On miss, `GET https://api.yelp.com/v3/businesses/search/phone?phone=<e164>`. Map the first result into the shape above. `setCached` the result (including `null` on no match — cache the miss too). 900 ms timeout.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/vendors/yelp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: yelp fusion reverse-phone adapter with miss caching"
```

---

### Task 6: Google Places enrichment adapter

**Files:**
- Create: `src/vendors/googlePlaces.ts`
- Test: `tests/unit/vendors/googlePlaces.test.ts`

**Interfaces:**
- Consumes: `env.GOOGLE_PLACES_API_KEY`, cache from Task 3
- Produces:
  - `enrichFromGoogle(input: { yelpName: string; yelpAddressLine1: string; yelpCity: string; yelpState: string }): Promise<{ hours: Record<string, { open: string; close: string }[]> | null; is_open_now: boolean | null; rating: { stars: number; count: number } | null; place_id: string | null; cached: boolean }>`

Google is called **only** when Yelp returned a business; `enrichFromGoogle` is never called on consumer-cell paths. Cache key is `${name}|${addressLine1}` normalized.

- [ ] **Step 1: Write the failing tests**

```ts
it('returns hours and open_now when Place Details hits', async () => {
  mockGoogle({ /* findPlace returns place_id, then placeDetails returns opening_hours and rating */ });
  const result = await enrichFromGoogle({ yelpName: "Joe's Pizza", yelpAddressLine1: '7 Carmine St', yelpCity: 'New York', yelpState: 'NY' });
  expect(result.place_id).toBeDefined();
  expect(result.hours).toBeDefined();
});
it('returns null fields when no Google match', async () => {
  mockGoogle({ findPlace: { candidates: [] } });
  const result = await enrichFromGoogle({ yelpName: 'Nonsense', yelpAddressLine1: '', yelpCity: '', yelpState: '' });
  expect(result).toMatchObject({ hours: null, place_id: null });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/vendors/googlePlaces.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `enrichFromGoogle` in `src/vendors/googlePlaces.ts`**

Use `@googlemaps/google-maps-services-js`. Call Find Place From Text with the composed query `"<name> <addressLine1> <city> <state>"`. On a candidate, call Place Details with fields `opening_hours,current_opening_hours,rating,user_ratings_total,place_id`. Map `current_opening_hours.open_now` to `is_open_now`. 900 ms timeout. Cache hours separately (1 h TTL) from rating/place_id (7 d TTL).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/vendors/googlePlaces.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: google places enrichment for hours + rating with split TTLs"
```

---

### Task 7: IPQS reputation adapter

**Files:**
- Create: `src/vendors/ipqs.ts`
- Test: `tests/unit/vendors/ipqs.test.ts`

**Interfaces:**
- Consumes: `env.IPQS_API_KEY`, cache from Task 3
- Produces:
  - `lookupReputation(phoneE164: string): Promise<{ spam_risk_score: number; is_known_robocall: boolean; is_dnc_listed: boolean | null; is_voip_risk: boolean; cached: boolean }>`

- [ ] **Step 1: Write the failing tests**

```ts
it('maps IPQS fraud_score to spam_risk_score', async () => {
  mockIpqs({ fraud_score: 85, risky: true, do_not_call: true, VOIP: false });
  expect(await lookupReputation('+15165559999')).toMatchObject({ spam_risk_score: 85, is_known_robocall: true, is_dnc_listed: true, is_voip_risk: false });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/vendors/ipqs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lookupReputation` in `src/vendors/ipqs.ts`**

Cache first (`getCached(phone, 'reputation')`). On miss, `GET https://ipqualityscore.com/api/json/phone/<key>/<e164>?strictness=1`. 900 ms timeout. `setCached` the normalized result.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/vendors/ipqs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: ipqs reputation adapter"
```

---

### Task 8: Compose dossier

**Files:**
- Create: `src/dossier/types.ts`, `src/dossier/compose.ts`
- Test: `tests/unit/dossier/compose.test.ts`

**Interfaces:**
- Consumes: `lookupTwilio` (Task 4), `lookupYelp` (Task 5), `enrichFromGoogle` (Task 6), `lookupReputation` (Task 7)
- Produces:
  - `type Dossier` in `src/dossier/types.ts` — fields: `phone`, `number_classification` (`'business' | 'consumer_mobile' | 'consumer_landline' | 'voip' | 'unknown'`), `carrier`, `caller_name`, `business_match` (nullable object with `name, category, address, hours, is_open_now, rating, place_id, yelp_id`), `reputation`, `meta` (with `lookup_id`, `schema_version: 'v1'`, `cached_fields: string[]`, `timestamp`).
  - `composeDossier(phoneE164: string): Promise<Dossier>` in `src/dossier/compose.ts`.

- [ ] **Step 1: Write the failing tests (happy + consumer-cell + Review Focus 3)**

```ts
it('composes a business dossier when Yelp matches', async () => {
  mockVendors({ twilio: { type: 'landline', name: 'Verizon' }, yelp: { name: "Joe's Pizza" }, google: { hours: {} }, ipqs: { spam_risk_score: 2 } });
  const d = await composeDossier('+12125553333');
  expect(d.number_classification).toBe('business');
  expect(d.business_match?.name).toBe("Joe's Pizza");
});
it('returns consumer_mobile with null business_match on no Yelp hit + mobile line type', async () => {
  mockVendors({ twilio: { type: 'mobile' }, yelp: null, ipqs: { spam_risk_score: 2 } });
  const d = await composeDossier('+15165551234');
  expect(d.number_classification).toBe('consumer_mobile');
  expect(d.business_match).toBeNull();
});
it('still returns within 2s and marks degraded when one vendor hangs past 900ms', async () => {
  mockVendors({ twilio: delayed(2000), yelp: { name: "Joe's" }, google: {}, ipqs: {} });
  const start = Date.now();
  const d = await composeDossier('+12125553333');
  expect(Date.now() - start).toBeLessThan(2000);
  expect(d.carrier.type).toBe('unknown');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/dossier/compose.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `composeDossier` in `src/dossier/compose.ts`**

Run Twilio, Yelp, IPQS in parallel (`Promise.allSettled`); each adapter already has its own 900 ms timeout. Only call `enrichFromGoogle` after Yelp resolves with a business (serial on that branch). Classify: `business` if Yelp hit; `consumer_mobile` if Twilio says mobile and no Yelp hit; `consumer_landline` if Twilio says landline and no Yelp; `voip` if Twilio says voip; else `unknown`. Degraded vendor (`rejected` from `allSettled`) → that section populated with safe defaults (carrier.type `unknown`, rating null, etc.). Compose `meta.cached_fields` from each adapter's `cached` flag.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/dossier/compose.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: dossier composition with classification + degraded-vendor tolerance"
```

---

### Task 9: HTTP lookup route (unprotected)

**Files:**
- Create: `src/http/lookupRoute.ts`
- Modify: `src/server.ts` (register route)
- Test: `tests/integration/lookup.test.ts`

**Interfaces:**
- Consumes: `normalizePhone` (Task 2), `composeDossier` (Task 8)
- Produces:
  - `GET /lookup/:phone` → `200 Dossier` on success; `400 { error }` on invalid/non-US; `502 { error }` on all-vendor failure.
  - Review Focus 5: the dossier is written to the vendor caches before the response is returned; a retry on the same phone within TTL serves from cache.

- [ ] **Step 1: Write the failing tests (happy + Review Focus 1 + Review Focus 2 + Review Focus 5)**

```ts
it('GET /lookup/+15165551234 returns a dossier', async () => {
  mockVendorsStable();
  const res = await server.inject({ method: 'GET', url: '/lookup/%2B15165551234' });
  expect(res.statusCode).toBe(200);
  expect(res.json().meta.schema_version).toBe('v1');
});
it('GET /lookup/+447911123456 returns 400 not_us_number with zero vendor calls', async () => {
  const beforeCalls = allVendorCallCounts();
  const res = await server.inject({ method: 'GET', url: '/lookup/%2B447911123456' });
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe('not_us_number');
  expect(allVendorCallCounts()).toEqual(beforeCalls);
});
it("GET /lookup/abc'OR1=1 returns 400 invalid_phone", async () => {
  const res = await server.inject({ method: 'GET', url: "/lookup/abc'OR1=1" });
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe('invalid_phone');
});
it('second call to same phone within TTL hits cache (no vendor calls)', async () => {
  mockVendorsStable();
  await server.inject({ method: 'GET', url: '/lookup/%2B15165551234' });
  const before = allVendorCallCounts();
  await server.inject({ method: 'GET', url: '/lookup/%2B15165551234' });
  expect(allVendorCallCounts()).toEqual(before);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/integration/lookup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lookupRoute` in `src/http/lookupRoute.ts`**

Parse `:phone`, call `normalizePhone`. On error, map to `400`. On success, call `composeDossier(e164)` and return the result. If `composeDossier` throws (all four vendors failed), log and return `502 { error: { code: 'vendor_failure' } }`. Register the route in `src/server.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/integration/lookup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: GET /lookup/:phone with validation + error taxonomy"
```

---

### Task 10: x402 payment middleware

**Files:**
- Create: `src/payment/wallet.ts`, `src/payment/x402Middleware.ts`
- Modify: `src/server.ts` (install middleware before `lookupRoute`)
- Test: `tests/e2e/payment.test.ts`

**Interfaces:**
- Consumes: `env.CDP_API_KEY`, `env.CDP_API_SECRET`, `env.WALLET_ADDRESS`
- Produces:
  - `requirePayment(amountUsdc: '0.03', network: 'base' | 'base-sepolia'): FastifyPreHandler` in `src/payment/x402Middleware.ts`
  - Returns `402 Payment Required` with the x402 challenge headers on unpaid requests; passes through once a valid x402 payment header is presented.

- [ ] **Step 1: Write the failing tests**

```ts
it('unpaid GET /lookup returns 402 with x402 challenge headers', async () => {
  const res = await server.inject({ method: 'GET', url: '/lookup/%2B15165551234' });
  expect(res.statusCode).toBe(402);
  expect(res.headers).toHaveProperty('x-payment-requirements');
});
it('paid request on base-sepolia returns the dossier', async () => {
  const paymentHeader = await buildTestPayment({ amount: '0.03', network: 'base-sepolia', to: env.WALLET_ADDRESS });
  const res = await server.inject({ method: 'GET', url: '/lookup/%2B15165551234', headers: { 'x-payment': paymentHeader } });
  expect(res.statusCode).toBe(200);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/e2e/payment.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/payment/wallet.ts`**

Instantiate a Coinbase CDP server wallet from `CDP_API_KEY` / `CDP_API_SECRET`. Export the wallet address and a `verifyPayment(x402Header, requiredAmount, network)` helper that defers to the Coinbase x402 reference verifier.

- [ ] **Step 4: Implement `requirePayment` in `src/payment/x402Middleware.ts`**

Fastify preHandler. If no `x-payment` header, respond with 402 and the challenge headers naming amount `0.03`, network from `NODE_ENV` (`base` in prod, `base-sepolia` otherwise), and `env.WALLET_ADDRESS` as the destination. If a header is present, call `verifyPayment`; on success, `return` (route runs); on failure, respond `402` with error reason.

- [ ] **Step 5: Register the middleware in `src/server.ts`**

Install `requirePayment('0.03', network)` as preHandler on the `/lookup/:phone` route. Health endpoint stays unprotected.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/e2e/payment.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: x402 payment middleware on /lookup with base-sepolia e2e"
```

---

### Task 11: MCP server wrapping the lookup

**Files:**
- Create: `src/mcp/mcpServer.ts`, `src/mcp/tools/lookupTool.ts`
- Modify: `src/server.ts` (register MCP Streamable HTTP transport)
- Test: `tests/e2e/mcp.test.ts`

**Interfaces:**
- Consumes: the same `composeDossier` + `requirePayment` the HTTP route uses
- Produces:
  - MCP tool `phone_intel.lookup` with input schema `{ phone: string }` and output schema matching `Dossier`
  - Streamable HTTP transport served at `/mcp`

- [ ] **Step 1: Write the failing test**

```ts
it('MCP client lists phone_intel.lookup and calls it with payment', async () => {
  const client = createMcpClient('http://localhost:PORT/mcp', { paymentHandler: testWallet });
  const tools = await client.listTools();
  expect(tools.some(t => t.name === 'phone_intel.lookup')).toBe(true);
  const result = await client.callTool('phone_intel.lookup', { phone: '+15165551234' });
  expect(result.meta.schema_version).toBe('v1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/e2e/mcp.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lookupTool` in `src/mcp/tools/lookupTool.ts` and `mcpServer` in `src/mcp/mcpServer.ts`**

Use `@modelcontextprotocol/sdk/server` with `StreamableHTTPServerTransport`. Register one tool `phone_intel.lookup`. The handler normalizes the phone, enforces payment through the same `requirePayment` logic (via the HTTP transport's request object), calls `composeDossier`, and returns the dossier as the tool result. Register the MCP transport in `src/server.ts` at `POST /mcp`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/e2e/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: MCP server exposes phone_intel.lookup over streamable HTTP"
```

---

### Task 12: Rate limiting, request log, readme, deploy to prod

**Files:**
- Create: `src/middleware/rateLimit.ts`, `src/middleware/requestLog.ts`, `README.md`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: wallet address from the x402 payment envelope
- Produces:
  - Per-wallet rate limit: max 100 requests per minute per paying wallet; over → `429 { error: { code: 'rate_limited', retry_after_seconds } }`
  - Request log: one `pino` line per request with `request_id`, `phone_hash` (SHA-256 of E.164, not the raw phone), `status`, `latency_ms`, `cache_hits`, `wallet_address_last6`

- [ ] **Step 1: Write the failing tests**

```ts
it('101st request within a minute from the same wallet returns 429', async () => {
  for (let i = 0; i < 100; i++) await paidInject(wallet, '/lookup/%2B15165551234');
  const res = await paidInject(wallet, '/lookup/%2B15165551234');
  expect(res.statusCode).toBe(429);
  expect(res.json().error.retry_after_seconds).toBeGreaterThan(0);
});
it('logs include phone_hash not phone', async () => {
  const logs = captureLogs(() => paidInject(wallet, '/lookup/%2B15165551234'));
  expect(logs.join('')).not.toContain('5165551234');
  expect(logs.some(l => l.includes('phone_hash'))).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/integration/rateLimit.test.ts tests/integration/requestLog.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement rate limiting and request log**

`rateLimit.ts` — in-memory token bucket keyed by `wallet_address`, 100/min, 10-min cleanup. (Note: single-instance only — if we scale beyond one Fly machine, move to Redis. v1 ships one machine.) `requestLog.ts` — pino child logger with the fields above; derive `phone_hash` with Node's `crypto.createHash('sha256')`.

- [ ] **Step 4: Write README.md**

Cover: what the endpoint does, the response schema (`Dossier` v1), pricing, the x402 flow for agents, how to call it from an MCP client, how to call it over raw HTTP, example `curl`, example MCP client snippet. Keep it under 300 lines.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS (all tests).

- [ ] **Step 6: Deploy to prod on Fly.io with base mainnet network**

Set production env (`NODE_ENV=production`), ensure `WALLET_ADDRESS` is the Base mainnet address, run `fly secrets set` for all keys, `fly deploy`. Curl the deployed `/health` and attempt a paid `/lookup/+15165551234` call from a funded test wallet. Verify USDC settles to Jeff's CDP wallet on-chain.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: rate limit, request log with phone hashing, README, prod deploy"
```

---

### Task 13: Public listings and launch (non-code)

**Files:** none (external submissions)

**Deliverable:** published on at least four of five directories.

- [ ] **Step 1: Submit to x402.org** — tool manifest, pricing, description, example response.
- [ ] **Step 2: Submit to Smithery** — MCP tool manifest for `phone_intel.lookup`.
- [ ] **Step 3: Submit to mcp.so** — same manifest, tag `x402`.
- [ ] **Step 4: Submit to PayAPI Market** — same pricing, description.
- [ ] **Step 5: Submit to agentstools** — if accepted.
- [ ] **Step 6: Post launch note** — Coinbase agent-builder Discord, X thread, Show HN (short).
- [ ] **Step 7: Commit the launch artifacts (manifests, screenshots)**

```bash
git add docs/launch/
git commit -m "docs: launch artifacts for public listings"
```

---

## Self-Review

**1. Spec coverage.** Walked each section of the spec against the plan:
- HTTP endpoint + MCP server + payment — Tasks 9, 10, 11.
- Twilio + Yelp + Google Places + IPQS — Tasks 4, 5, 6, 7.
- Cache with per-field TTLs — Task 3.
- Consumer-cell handling — Task 8 (classification), Task 9 (full-price single tier is enforced by the single-tier middleware in Task 10).
- Compliance / schema signaling — Task 8 (`number_classification`), Task 12 (phone hashing in logs).
- Fallback to Stripe — not a v1 build task; the x402 middleware is isolated to one file (`src/payment/x402Middleware.ts`) so a Stripe swap stays weekend-sized. Noted here, no task.
- Distribution — Task 13.

No gaps.

**2. Step scan.** Each code step names a file, a signature or a specific external call; no "TBD" or "handle edge cases"; no function bodies written out. Test steps carry test names and assertions with concrete values. Verification steps carry commands and expected output.

**3. Type consistency.** `Dossier` fields defined in Task 8 types; `composeDossier` return type matches route return type (Task 9) and MCP tool output (Task 11). Vendor adapter return shapes match what `composeDossier` consumes (Twilio returns `{ carrier, caller_name, cached }`; Yelp returns `{ business, cached }`; etc.). `CacheField` enum consistent across Task 3 and vendor tasks.

**4. Review Focus.** Five lines; each line's test is pinned to its owning task's step list:
- Non-US input — Task 2 Step 1 + Task 9 Step 1.
- Malformed input — Task 2 Step 1 + Task 9 Step 1.
- Single vendor timeout — Task 8 Step 1.
- Cache invalidate — Task 3 Step 1.
- Pre-response cache write on payment — Task 9 Step 1 (second-call-hits-cache test).

**5. Proportion.** Spec ~2000 words; plan ~3400 words. Within 2x. No function bodies written as code; code blocks are signatures, test names, and small test fixtures.
