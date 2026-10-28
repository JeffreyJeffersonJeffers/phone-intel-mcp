import { describe, expect, it } from 'vitest';
import { hashPhone } from '../../src/lib/phoneHash.js';

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
});
