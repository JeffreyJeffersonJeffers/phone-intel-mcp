import { beforeEach, describe, expect, it } from 'vitest';
import { getSnapshot, recordLookup, resetStatsForTests } from '../../../src/stats/counters.js';

describe('stats counters', () => {
  beforeEach(() => resetStatsForTests());

  it('starts with zero lookups and null rates', () => {
    const s = getSnapshot('0.1.0');
    expect(s.version).toBe('0.1.0');
    expect(s.lookups.total).toBe(0);
    expect(s.lookups.success_rate).toBeNull();
    expect(s.cache_hit_rate).toBeNull();
    expect(s.latency_ms.p50_ms).toBeNull();
    expect(s.latency_ms.p95_ms).toBeNull();
    expect(s.latency_ms.sample_size).toBe(0);
    expect(s.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it('counts total and success and computes success_rate', () => {
    recordLookup({ status: 200, latencyMs: 500, cacheHits: [] });
    recordLookup({ status: 200, latencyMs: 600, cacheHits: [] });
    recordLookup({ status: 400, latencyMs: 10, cacheHits: [] });
    recordLookup({ status: 502, latencyMs: 2000, cacheHits: [] });
    const s = getSnapshot('0.1.0');
    expect(s.lookups.total).toBe(4);
    expect(s.lookups.success_rate).toBe(0.5); // 2/4
  });

  it('cache_hit_rate is (successes with any cache hit) / (total successes)', () => {
    recordLookup({ status: 200, latencyMs: 100, cacheHits: ['carrier'] });
    recordLookup({ status: 200, latencyMs: 100, cacheHits: [] });
    recordLookup({ status: 200, latencyMs: 100, cacheHits: ['reputation', 'business'] });
    recordLookup({ status: 400, latencyMs: 10, cacheHits: [] }); // ignored for cache calc
    const s = getSnapshot('0.1.0');
    expect(s.cache_hit_rate).toBeCloseTo(2 / 3, 3);
  });

  it('samples latency only from successful lookups and computes percentiles', () => {
    // 100 success samples at 100..1000 ms (10 of each tier)
    for (let i = 0; i < 100; i++) {
      recordLookup({ status: 200, latencyMs: 100 + (i % 10) * 100, cacheHits: [] });
    }
    // Failures should not pollute the latency samples
    recordLookup({ status: 500, latencyMs: 99999, cacheHits: [] });
    const s = getSnapshot('0.1.0');
    expect(s.latency_ms.sample_size).toBe(100);
    expect(s.latency_ms.p50_ms).toBeLessThanOrEqual(600);
    expect(s.latency_ms.p95_ms).toBeLessThanOrEqual(1000);
    // Sanity: no sample should exceed 1000 if the 99999 failure was excluded
    expect(s.latency_ms.p95_ms).toBeLessThan(99999);
  });

  it('latency ring buffer caps at 500 samples and keeps recent ones', () => {
    // 600 samples: first 100 at 10000 ms, next 500 at 100 ms. Ring buffer should only hold the
    // 100ms ones after wraparound.
    for (let i = 0; i < 100; i++) recordLookup({ status: 200, latencyMs: 10000, cacheHits: [] });
    for (let i = 0; i < 500; i++) recordLookup({ status: 200, latencyMs: 100, cacheHits: [] });
    const s = getSnapshot('0.1.0');
    expect(s.latency_ms.sample_size).toBe(500);
    expect(s.latency_ms.p50_ms).toBe(100);
    expect(s.latency_ms.p95_ms).toBe(100);
  });

  it('includes a started_at ISO timestamp and a human-readable note', () => {
    const s = getSnapshot('0.1.0');
    expect(s.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(s.note).toMatch(/cold start/i);
  });
});
