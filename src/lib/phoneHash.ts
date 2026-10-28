import { createHash } from 'node:crypto';

// Log-safe stand-in for a phone number: the raw number never goes to the logs. Only a correlation
// handle: SHA-256 of a 10-digit number is brute-forceable, so this is not anonymization.
export function hashPhone(e164: string): string {
  return createHash('sha256').update(e164).digest('hex').slice(0, 16);
}
