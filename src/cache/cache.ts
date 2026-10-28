import postgres from 'postgres';
import { env } from '../env.js';

export type CacheField = 'carrier' | 'business' | 'reputation' | 'hours' | 'enrichment';

const HOUR = 3600;
const TTL_SECONDS: Record<CacheField, number> = {
  carrier: 7 * 24 * HOUR,
  business: 7 * 24 * HOUR,
  reputation: 24 * HOUR,
  hours: HOUR,
  enrichment: 7 * 24 * HOUR,
};

// Module-level singleton, created on first use. postgres.js connects lazily.
// - ssl 'require': postgres.js defaults to plaintext; cached phone/business data must not
//   cross the internet unencrypted. 'require' enforces TLS without strict CA verification.
// - connect_timeout (s): a paused free-tier Supabase project should fail fast, not hang 30s.
// - idle_timeout (s): lets pooled connections close so a quiet process (or test run) can exit.
let client: postgres.Sql | undefined;
function db(): postgres.Sql {
  if (!client) {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    client = postgres(env.DATABASE_URL, { ssl: 'require', connect_timeout: 5, idle_timeout: 20 });
  }
  return client;
}

function columns(field: CacheField): { data: string; at: string } {
  if (!Object.hasOwn(TTL_SECONDS, field)) throw new Error(`Unknown cache field: ${String(field)}`);
  return { data: `${field}_data`, at: `${field}_cached_at` };
}

export async function getCached<T>(phone: string, field: CacheField): Promise<T | null> {
  const sql = db();
  const { data, at } = columns(field);
  // Expiry is judged by the database clock (the same one that stamped *_cached_at), and the
  // last_read_at bump rides on the same statement: only a within-TTL hit updates it.
  const rows = await sql`
    UPDATE phone_lookups
    SET last_read_at = now()
    WHERE phone_e164 = ${phone}
      AND ${sql(data)} IS NOT NULL
      AND ${sql(at)} > now() - make_interval(secs => ${TTL_SECONDS[field]})
    RETURNING ${sql(data)} AS value
  `;
  return rows.length === 0 ? null : (rows[0].value as T);
}

export async function setCached<T>(phone: string, field: CacheField, value: T): Promise<void> {
  const sql = db();
  const { data, at } = columns(field);
  await sql`
    INSERT INTO phone_lookups (phone_e164, ${sql(data)}, ${sql(at)})
    VALUES (${phone}, ${sql.json(value as postgres.JSONValue)}, now())
    ON CONFLICT (phone_e164) DO UPDATE
    SET ${sql(data)} = EXCLUDED.${sql(data)}, ${sql(at)} = now()
  `;
}

// Clears one field, or all five when none is given. The row itself is kept.
export async function invalidate(phone: string, field?: CacheField): Promise<void> {
  const sql = db();
  if (field === undefined) {
    await sql`
      UPDATE phone_lookups
      SET carrier_data = NULL, carrier_cached_at = NULL,
          business_data = NULL, business_cached_at = NULL,
          reputation_data = NULL, reputation_cached_at = NULL,
          hours_data = NULL, hours_cached_at = NULL,
          enrichment_data = NULL, enrichment_cached_at = NULL
      WHERE phone_e164 = ${phone}
    `;
    return;
  }
  const { data, at } = columns(field);
  await sql`
    UPDATE phone_lookups
    SET ${sql(data)} = NULL, ${sql(at)} = NULL
    WHERE phone_e164 = ${phone}
  `;
}
