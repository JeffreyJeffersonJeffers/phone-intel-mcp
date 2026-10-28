import { describe, expect, it } from 'vitest';
import { redact, safeErrorMessage } from '../../src/lib/logSafe.js';

// Vendor and database error text is attacker-adjacent and vendor-controlled: it can quote the URL
// that was fetched (the phone number, sometimes an API key). It may be logged only after this.
describe('redact', () => {
  it.each([
    '+15165551234',
    '15165551234',
    '5165551234',
    '%2B15165551234',
    '(516) 555-1234',
    '516-555-1234',
    '516.555.1234',
    '1-516-555-1234',
    '+1 516 555 1234',
  ])('removes the phone number %s', (phone) => {
    const out = redact(`GET https://lookups.example/PhoneNumbers/${phone}?x=1 failed`, []);
    expect(out).not.toMatch(/516\D*555\D*1234/);
    expect(out).toContain('failed');
  });

  it('removes a long run of digits that is not formatted as a US number', () => {
    expect(redact('lookup 4420712345678 failed', [])).not.toContain('2071234');
  });

  it('removes configured secrets, raw and URL-encoded', () => {
    const secret = 'sk_live/abc+def==';
    const out = redact(`fetch ${secret} and ${encodeURIComponent(secret)} failed`, [secret]);
    expect(out).not.toContain('abc');
    expect(out).not.toContain('def');
    expect(out).toContain('failed');
  });

  it('removes a secret even if it is made of digits that look like a phone number', () => {
    const out = redact('key=1234567890123 rejected', ['1234567890123']);
    expect(out).toBe('key=[redacted] rejected');
  });

  it('keeps the parts of an error that make it diagnosable', () => {
    for (const message of [
      'Twilio authentication failed (HTTP 401, Twilio code 20003)',
      'IPQS_API_KEY is not set',
      'connect ECONNREFUSED 10.0.0.7:5432',
      'getaddrinfo ENOTFOUND aws-0-us-east-1.pooler.supabase.com',
      'Request failed with status code 403',
      'timeout after 900ms',
    ]) {
      expect(redact(message, [])).toBe(message);
    }
  });
});

describe('safeErrorMessage', () => {
  it('returns only the message of an Error: no name, no stack', () => {
    const err = new TypeError('boom');
    expect(safeErrorMessage(err)).toBe('boom');
    expect(safeErrorMessage(err)).not.toContain('at ');
  });

  it('redacts the phone number out of the message', () => {
    expect(safeErrorMessage(new Error('lookup for +15165551234 failed'))).toBe('lookup for [number] failed');
  });

  it('handles things that are not Errors', () => {
    expect(safeErrorMessage('plain +15165551234')).toBe('plain [number]');
    expect(safeErrorMessage(undefined)).toBe('undefined');
    expect(safeErrorMessage({ phone: '+15165551234' })).not.toContain('5165551234');
  });

  it('truncates a very long message', () => {
    expect(safeErrorMessage(new Error('x'.repeat(5_000))).length).toBeLessThanOrEqual(300);
  });
});
