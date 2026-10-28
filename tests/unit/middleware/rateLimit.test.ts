import { describe, expect, it } from 'vitest';
import { createWalletRateLimiter } from '../../../src/middleware/rateLimit.js';

const A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const B = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';

// An injected clock keeps these about the window arithmetic, not about real time passing.
function limiterWithClock(options: Parameters<typeof createWalletRateLimiter>[0] = {}) {
  let t = 1_000_000;
  const limiter = createWalletRateLimiter({ now: () => t, ...options });
  return { limiter, advance: (ms: number) => (t += ms) };
}

describe('createWalletRateLimiter', () => {
  it('allows 100 requests in a minute and refuses the 101st', () => {
    const { limiter } = limiterWithClock();

    for (let i = 0; i < 100; i++) expect(limiter.take(A)).toEqual({ ok: true });

    expect(limiter.take(A)).toMatchObject({ ok: false });
  });

  it('tells the caller to wait a positive whole number of seconds', () => {
    const { limiter, advance } = limiterWithClock();
    for (let i = 0; i < 100; i++) limiter.take(A);
    advance(20_000); // 20 s into the window: the oldest request ages out in 40 s

    const verdict = limiter.take(A);

    expect(verdict).toEqual({ ok: false, retryAfterSeconds: 40 });
  });

  it('rounds the wait up, never down to 0', () => {
    const { limiter, advance } = limiterWithClock();
    for (let i = 0; i < 100; i++) limiter.take(A);
    advance(59_999);

    const verdict = limiter.take(A);

    expect(verdict).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it('is a rolling window: capacity comes back as the oldest requests age out', () => {
    const { limiter, advance } = limiterWithClock();
    for (let i = 0; i < 50; i++) limiter.take(A); // t0
    advance(30_000);
    for (let i = 0; i < 50; i++) limiter.take(A); // t0 + 30 s: now full
    expect(limiter.take(A)).toMatchObject({ ok: false });

    advance(30_001); // the first 50 are now over a minute old, the second 50 are not

    for (let i = 0; i < 50; i++) expect(limiter.take(A)).toEqual({ ok: true });
    expect(limiter.take(A)).toMatchObject({ ok: false });
  });

  it('does not count refused requests against the wallet', () => {
    const { limiter, advance } = limiterWithClock();
    for (let i = 0; i < 100; i++) limiter.take(A);
    for (let i = 0; i < 500; i++) limiter.take(A); // hammering while limited
    advance(60_001);

    expect(limiter.take(A)).toEqual({ ok: true });
  });

  it('keeps a separate allowance per wallet', () => {
    const { limiter } = limiterWithClock();
    for (let i = 0; i < 100; i++) limiter.take(A);

    expect(limiter.take(A)).toMatchObject({ ok: false });
    expect(limiter.take(B)).toEqual({ ok: true });
  });

  it('treats an address in a different hex case as the same wallet', () => {
    const { limiter } = limiterWithClock();
    for (let i = 0; i < 100; i++) limiter.take(A);

    expect(limiter.take(A.toLowerCase())).toMatchObject({ ok: false });
    expect(limiter.take(`0x${A.slice(2).toUpperCase()}`)).toMatchObject({ ok: false });
  });

  describe('cleanup sweep', () => {
    it('forgets wallets with no recent activity once ten minutes have passed', () => {
      const { limiter, advance } = limiterWithClock();
      limiter.take(A);
      limiter.take(B);
      expect(limiter.size()).toBe(2);

      advance(10 * 60_000);
      limiter.take(B); // any request after the sweep interval triggers the sweep

      expect(limiter.size()).toBe(1); // A was idle and is gone; B was just used
    });

    it('does not sweep before ten minutes, and keeps a wallet that is still inside its window', () => {
      const { limiter, advance } = limiterWithClock();
      limiter.take(A);
      advance(9 * 60_000);
      limiter.take(B);
      expect(limiter.size()).toBe(2); // A is idle but the sweep has not run yet

      advance(60_000); // 10 min in: the sweep runs on this request, and A is long idle
      limiter.take(B);
      expect(limiter.size()).toBe(1);
    });

    it('keeps limiting a wallet through a sweep that happens while it is over the limit', () => {
      const { limiter, advance } = limiterWithClock({ sweepEveryMs: 1_000 });
      for (let i = 0; i < 100; i++) limiter.take(A);
      advance(1_000); // sweep fires on the next call, but A's requests are still inside the window

      expect(limiter.take(A)).toMatchObject({ ok: false });
    });
  });
});
