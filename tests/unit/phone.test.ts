import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../../src/lib/phone.js';

describe('normalizePhone', () => {
  it('normalizes a US 10-digit number to E.164', () => {
    expect(normalizePhone('5165551234')).toEqual({ e164: '+15165551234' });
  });
  it('normalizes with punctuation', () => {
    expect(normalizePhone('(516) 555-1234')).toEqual({ e164: '+15165551234' });
  });
  it('rejects non-US country code', () => {
    expect(normalizePhone('+447911123456')).toEqual({ error: 'not_us_number' });
  });
  it('rejects malformed input', () => {
    expect(normalizePhone("abc' OR 1=1")).toEqual({ error: 'invalid_phone' });
    expect(normalizePhone('../../etc/passwd')).toEqual({ error: 'invalid_phone' });
    expect(normalizePhone('1'.repeat(200))).toEqual({ error: 'invalid_phone' });
  });
  it('rejects a 7-digit NANP local-only number', () => {
    expect(normalizePhone('5551234')).toEqual({ error: 'invalid_phone' });
  });
  it('rejects numbers with fewer than 10 national digits even if libphonenumber calls them possible', () => {
    expect(normalizePhone('555-123')).toEqual({ error: 'invalid_phone' });
  });
});
