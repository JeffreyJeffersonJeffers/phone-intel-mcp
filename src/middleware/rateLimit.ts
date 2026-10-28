import type { preHandlerAsyncHookHandler } from 'fastify';
import { payerOf } from '../payment/payer.js';

// Per-wallet limit on paid lookups: LIMIT requests in any rolling WINDOW_MS. In memory, so single
// instance only; with several Fly machines each would keep its own count and it needs Redis.
//
// An exact sliding-window log (at most LIMIT timestamps per wallet) rather than a refilling token
// bucket: a bucket that refills continuously lets the 101st request through a second after the
// 100th, which is not "100 per minute".
const LIMIT = 100;
const WINDOW_MS = 60_000;
const SWEEP_EVERY_MS = 10 * 60_000;

export interface WalletRateLimiterOptions {
  limit?: number;
  windowMs?: number;
  sweepEveryMs?: number;
  now?: () => number;
}

export type RateVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

export function createWalletRateLimiter({
  limit = LIMIT,
  windowMs = WINDOW_MS,
  sweepEveryMs = SWEEP_EVERY_MS,
  now = Date.now,
}: WalletRateLimiterOptions = {}) {
  const hits = new Map<string, number[]>(); // per wallet, oldest first, only requests that were allowed
  let lastSweep = now();

  return {
    take(wallet: string): RateVerdict {
      const t = now();
      // Swept on use, not on a timer: nothing to cancel on shutdown, and the map only grows when
      // requests arrive, which is also what triggers the sweep.
      if (t - lastSweep >= sweepEveryMs) {
        lastSweep = t;
        for (const [key, stamps] of hits) if ((stamps.at(-1) ?? 0) <= t - windowMs) hits.delete(key);
      }

      const key = wallet.toLowerCase();
      const stamps = hits.get(key) ?? [];
      while (stamps.length > 0 && stamps[0]! <= t - windowMs) stamps.shift();
      if (stamps.length >= limit) {
        // A refused request is not recorded, so hammering while limited does not extend the wait.
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((stamps[0]! + windowMs - t) / 1000)) };
      }
      stamps.push(t);
      hits.set(key, stamps);
      return { ok: true };
    },
    // Wallets currently tracked.
    size: () => hits.size,
  };
}

export type WalletRateLimiter = ReturnType<typeof createWalletRateLimiter>;

// Runs after the x402 gate, which is what tells it who is paying. A request with no verified payer
// (/health, MCP initialize and tools/list, anything the gate rejected) passes untouched.
export function walletRateLimit(limiter: WalletRateLimiter): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const wallet = payerOf(request);
    if (!wallet) return;
    const verdict = limiter.take(wallet);
    if (verdict.ok) return;
    const seconds = verdict.retryAfterSeconds;
    request.log.info({ rate_limited: true, retry_after_seconds: seconds }, 'wallet rate limited');
    return reply
      .code(429)
      .header('retry-after', String(seconds))
      .send({ error: { code: 'rate_limited', retry_after_seconds: seconds } });
  };
}
