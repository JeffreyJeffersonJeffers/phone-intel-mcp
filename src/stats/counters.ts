// In-memory service-wide stats, populated by the HTTP lookup route and the MCP lookup tool.
// Powers GET /stats. Everything is since the current process started — Fly scales to zero when
// idle, so the window resets on every cold start. Node's single-threaded JS runtime makes the
// mutations below race-free without a mutex.
//
// Memory footprint is bounded by LATENCY_SAMPLE_SIZE × 8 bytes (~4 KB at 500 samples).

const LATENCY_SAMPLE_SIZE = 500;

interface State {
  startedAtMs: number;
  totalLookups: number;
  successLookups: number;
  lookupsWithCacheHit: number;
  // Ring buffer of successful-lookup latencies (ms). Only 2xx latencies are sampled, so the p95
  // reflects what a paying caller actually experiences, not errors that short-circuit before
  // vendors are called.
  latencySamples: number[];
  latencyWriteIdx: number;
}

const state: State = {
  startedAtMs: Date.now(),
  totalLookups: 0,
  successLookups: 0,
  lookupsWithCacheHit: 0,
  latencySamples: [],
  latencyWriteIdx: 0,
};

export function recordLookup(fields: { status: number; latencyMs: number; cacheHits: readonly string[] }): void {
  state.totalLookups++;
  if (fields.status === 200) {
    state.successLookups++;
    if (fields.cacheHits.length > 0) state.lookupsWithCacheHit++;
    // Ring buffer: fill to LATENCY_SAMPLE_SIZE, then overwrite the oldest entry.
    if (state.latencySamples.length < LATENCY_SAMPLE_SIZE) {
      state.latencySamples.push(fields.latencyMs);
    } else {
      state.latencySamples[state.latencyWriteIdx] = fields.latencyMs;
      state.latencyWriteIdx = (state.latencyWriteIdx + 1) % LATENCY_SAMPLE_SIZE;
    }
  }
}

export interface StatsSnapshot {
  version: string;
  started_at: string;
  uptime_seconds: number;
  lookups: {
    total: number;
    success_rate: number | null;
  };
  cache_hit_rate: number | null;
  latency_ms: {
    p50_ms: number | null;
    p95_ms: number | null;
    sample_size: number;
  };
  note: string;
}

export function getSnapshot(version: string): StatsSnapshot {
  const now = Date.now();
  const uptimeSeconds = Math.floor((now - state.startedAtMs) / 1000);
  const successRate = state.totalLookups === 0 ? null : round4(state.successLookups / state.totalLookups);
  const cacheHitRate = state.successLookups === 0 ? null : round4(state.lookupsWithCacheHit / state.successLookups);
  const { p50, p95 } = percentiles(state.latencySamples);
  return {
    version,
    started_at: new Date(state.startedAtMs).toISOString(),
    uptime_seconds: uptimeSeconds,
    lookups: {
      total: state.totalLookups,
      success_rate: successRate,
    },
    cache_hit_rate: cacheHitRate,
    latency_ms: {
      p50_ms: p50,
      p95_ms: p95,
      sample_size: state.latencySamples.length,
    },
    note: 'Counters reset on cold start (Fly scales to zero when idle). Latency percentiles are over the last 500 successful lookups.',
  };
}

// Visible to tests so a fresh state between cases is a one-liner.
export function resetStatsForTests(): void {
  state.startedAtMs = Date.now();
  state.totalLookups = 0;
  state.successLookups = 0;
  state.lookupsWithCacheHit = 0;
  state.latencySamples = [];
  state.latencyWriteIdx = 0;
}

function percentiles(samples: readonly number[]): { p50: number | null; p95: number | null } {
  if (samples.length === 0) return { p50: null, p95: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: pick(sorted, 0.5),
    p95: pick(sorted, 0.95),
  };
}

function pick(sorted: readonly number[], q: number): number {
  // Nearest-rank: simple, deterministic, correct for small buffers. Not interpolated — that would
  // imply more precision than the sample size warrants.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
