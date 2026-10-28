-- Phone Intel cache. One row per phone; five independently-expiring JSONB fields.
-- TTLs are enforced at read time in cache.ts (7d carrier/business/enrichment, 24h reputation, 1h hours).
-- Applied by hand and safe to re-run: psql "$DATABASE_URL" -f src/cache/schema.sql

CREATE TABLE IF NOT EXISTS phone_lookups (
  phone_e164            TEXT PRIMARY KEY,
  carrier_data          JSONB,
  carrier_cached_at     TIMESTAMPTZ,
  business_data         JSONB,
  business_cached_at    TIMESTAMPTZ,
  reputation_data       JSONB,
  reputation_cached_at  TIMESTAMPTZ,
  hours_data            JSONB,
  hours_cached_at       TIMESTAMPTZ,
  enrichment_data       JSONB,
  enrichment_cached_at  TIMESTAMPTZ,
  -- Bumped on every cache hit. Defaults to row creation so the 30-day prune job
  -- (future task) can use a plain `last_read_at < now() - interval '30 days'`.
  last_read_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Task 6 (Google Places) columns. Also added by ALTER so a database created before Task 6 is
-- brought up to date by re-running this file: CREATE TABLE IF NOT EXISTS skips an existing table.
ALTER TABLE phone_lookups ADD COLUMN IF NOT EXISTS enrichment_data JSONB;
ALTER TABLE phone_lookups ADD COLUMN IF NOT EXISTS enrichment_cached_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_phone_lookups_last_read_at ON phone_lookups (last_read_at);

-- Supabase exposes public tables through its REST API. RLS on with no policies denies the
-- anon/authenticated roles everything; the server's direct Postgres connection is unaffected.
ALTER TABLE phone_lookups ENABLE ROW LEVEL SECURITY;
