import { describe, expect, it } from 'vitest';
import { supportsV1OnBase } from '../../../scripts/check-cdp-mainnet.js';

// What scripts/check-cdp-mainnet.ts decides is "will our middleware's x402 v1 / `base` payments be
// accepted by CDP's facilitator?". The /supported body is the evidence; this is the verdict.
describe('supportsV1OnBase', () => {
  it('is true when /supported lists exact on `base` at x402 version 1', () => {
    const body = { kinds: [{ x402Version: 1, scheme: 'exact', network: 'base' }] };
    expect(supportsV1OnBase(body)).toBe(true);
  });

  it('is true when v1 and v2 entries are mixed', () => {
    const body = {
      kinds: [
        { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
        { x402Version: 1, scheme: 'exact', network: 'base' },
      ],
    };
    expect(supportsV1OnBase(body)).toBe(true);
  });

  it('is false for a v2-only list (CAIP-2 network ids)', () => {
    const body = {
      kinds: [
        { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
        { x402Version: 2, scheme: 'exact', network: 'eip155:84532' },
      ],
    };
    expect(supportsV1OnBase(body)).toBe(false);
  });

  it('is false when v1 is listed only for other networks', () => {
    const body = { kinds: [{ x402Version: 1, scheme: 'exact', network: 'base-sepolia' }] };
    expect(supportsV1OnBase(body)).toBe(false);
  });

  it('is false when `base` is listed for a scheme other than exact', () => {
    const body = { kinds: [{ x402Version: 1, scheme: 'upto', network: 'base' }] };
    expect(supportsV1OnBase(body)).toBe(false);
  });

  it('is false when `base` is listed at version 2 only', () => {
    const body = { kinds: [{ x402Version: 2, scheme: 'exact', network: 'base' }] };
    expect(supportsV1OnBase(body)).toBe(false);
  });

  it.each([null, undefined, 'nope', 42, [], {}, { kinds: null }, { kinds: 'x' }, { kinds: [null, 7, 'x'] }])(
    'is false (and does not throw) for a malformed body: %j',
    (body) => {
      expect(supportsV1OnBase(body)).toBe(false);
    },
  );
});
