import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashPhone } from '../../src/lib/phoneHash.js';

// The fixed key vitest.config.ts gives every test worker as LOG_PHONE_HMAC_KEY.
const TEST_KEY = 'test-only-phone-hmac-key-0123456789abcdef';

// src/env.ts reads process.env once at import, so each case that changes the environment imports a
// fresh copy of the module.
async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import('../../src/lib/phoneHash.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('hashPhone', () => {
  it('returns 16 lowercase hex chars that do not contain the number', () => {
    const hash = hashPhone('+15165551234');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toContain('5165551234');
  });

  it('is stable for the same number and differs between numbers', () => {
    expect(hashPhone('+15165551234')).toBe(hashPhone('+15165551234'));
    expect(hashPhone('+15165551234')).not.toBe(hashPhone('+15165551235'));
  });

  // Vectors from `printf %s <number> | openssl dgst -sha256 -hmac <key>`, first 16 hex chars: computed
  // outside the code under test, so this fails if it is not HMAC-SHA256 under the configured key.
  it('is the first 16 hex chars of HMAC-SHA256 of the E.164 number under LOG_PHONE_HMAC_KEY', () => {
    expect(hashPhone('+15165551234')).toBe('a4bb8488634da34d');
    expect(hashPhone('+15165551235')).toBe('6ae0b023088bbde4');
  });

  // The point of keying it: a precomputed table of SHA-256 over all ~10^10 US numbers must not
  // recover anything from a leaked log.
  it('is not the plain SHA-256 of the number', () => {
    const plain = createHash('sha256').update('+15165551234').digest('hex').slice(0, 16);
    expect(plain).toBe('8e1c4b69bfd7d850');
    expect(hashPhone('+15165551234')).not.toBe(plain);
  });

  it('changes with the key', async () => {
    const other = await load({ LOG_PHONE_HMAC_KEY: `other-${TEST_KEY}` });
    expect(other.hashPhone('+15165551234')).toMatch(/^[0-9a-f]{16}$/);
    expect(other.hashPhone('+15165551234')).not.toBe('a4bb8488634da34d');
  });
});

describe('the key', () => {
  it('is required in production: no key, no hashing (and so no startup)', async () => {
    const { phoneHashKey } = await load({ NODE_ENV: 'production', LOG_PHONE_HMAC_KEY: '' });

    expect(() => phoneHashKey()).toThrow(/LOG_PHONE_HMAC_KEY is not set.*openssl rand -hex 32/s);
  });

  it('is used as is in production when set, without a warning', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const { hashPhone: prod } = await load({ NODE_ENV: 'production', LOG_PHONE_HMAC_KEY: TEST_KEY });

    expect(prod('+15165551234')).toBe('a4bb8488634da34d');
    expect(warn).not.toHaveBeenCalled();
  });

  it('must be at least 32 characters, in any environment', async () => {
    const { phoneHashKey } = await load({ NODE_ENV: 'development', LOG_PHONE_HMAC_KEY: 'too-short' });

    expect(() => phoneHashKey()).toThrow(/at least 32/);
  });

  it('falls back to a random per-process key outside production, with one warning', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const a = await load({ NODE_ENV: 'development', LOG_PHONE_HMAC_KEY: '' });

    const first = a.hashPhone('+15165551234');
    const second = a.hashPhone('+15165551234');

    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(second).toBe(first); // stable for the life of the process
    expect(first).not.toBe('a4bb8488634da34d'); // not any fixed key
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/LOG_PHONE_HMAC_KEY/);

    const b = await load({ NODE_ENV: 'development', LOG_PHONE_HMAC_KEY: '' }); // "another process"
    expect(b.hashPhone('+15165551234')).not.toBe(first);
  });
});
