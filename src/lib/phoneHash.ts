import { createHmac, randomBytes } from 'node:crypto';
import { env } from '../env.js';

const MIN_KEY_CHARS = 32;

let key: string | undefined;

// The key phone_hash is computed under. It lives only in the environment (LOG_PHONE_HMAC_KEY), never
// in the logs, so someone holding a copy of the logs cannot recompute hashes for numbers they guess.
// Production refuses to run without one. Elsewhere a random per-process key stands in (hashes then
// differ between runs, which is fine for dev), with a single warning.
export function phoneHashKey(): string {
  if (key) return key;
  const configured = env.LOG_PHONE_HMAC_KEY;
  if (configured) {
    if (configured.length < MIN_KEY_CHARS) {
      throw new Error(`LOG_PHONE_HMAC_KEY must be at least ${MIN_KEY_CHARS} characters (use: openssl rand -hex 32)`);
    }
    return (key = configured);
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'LOG_PHONE_HMAC_KEY is not set. phone_hash in the logs must be keyed; generate a key with ' +
        '`openssl rand -hex 32` and set it as a secret.',
    );
  }
  process.emitWarning(
    'LOG_PHONE_HMAC_KEY is not set: using a random per-process key, so phone_hash differs between runs.',
  );
  return (key = randomBytes(32).toString('hex'));
}

// Log-safe stand-in for a phone number: the raw number never goes to the logs. A correlation handle,
// not anonymization: the same number always gives the same value (that is its use), so it still says
// "this number again". It is keyed (HMAC-SHA256) because a plain hash of a US number is recoverable
// from a precomputed table of all ~10^10 of them; without LOG_PHONE_HMAC_KEY it is not.
export function hashPhone(e164: string): string {
  return createHmac('sha256', phoneHashKey()).update(e164).digest('hex').slice(0, 16);
}
