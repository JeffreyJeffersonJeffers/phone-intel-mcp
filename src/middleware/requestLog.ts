// The fields every lookup writes about itself, on GET /lookup and on MCP alike, so one query finds
// both. The other two of the six come from the request's own logger: `request_id` (Fastify's reqId,
// renamed in server.ts) and, once a payment is verified, `wallet_address_last6` (see setPayer).
//
// All four are required on purpose: a log site that cannot supply one does not compile.
export interface LookupLogFields {
  // The outcome in GET /lookup's taxonomy (200, 400, 502, 500). For MCP the HTTP status is 200
  // whatever happened, so this is the equivalent outcome, not the transport's status.
  status: number;
  latencyMs: number;
  // SHA-256 prefix of the E.164 number; null when the input was rejected before it was a number.
  phoneHash: string | null;
  // Adapters that were answered from the cache (dossier.meta.cached_fields); empty on failure.
  cacheHits: readonly string[];
}

export function lookupLogFields({ status, latencyMs, phoneHash, cacheHits }: LookupLogFields) {
  return { phone_hash: phoneHash, status, latency_ms: latencyMs, cache_hits: cacheHits };
}
