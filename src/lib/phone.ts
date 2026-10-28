import libphonenumber from 'google-libphonenumber';

const { PhoneNumberFormat, PhoneNumberUtil } = libphonenumber;

const MAX_INPUT_LENGTH = 32;
const NON_US_PLUS_PREFIX = /^\+(?!1)\d/;
const phoneUtil = PhoneNumberUtil.getInstance();

export function normalizePhone(raw: string): { e164: string } | { error: 'invalid_phone' | 'not_us_number' } {
  const input = raw.trim();
  if (input.length > MAX_INPUT_LENGTH) return { error: 'invalid_phone' };
  if (NON_US_PLUS_PREFIX.test(input)) return { error: 'not_us_number' };

  let parsed: libphonenumber.PhoneNumber;
  try {
    parsed = phoneUtil.parse(input, 'US');
  } catch {
    return { error: 'invalid_phone' };
  }

  if (parsed.getCountryCodeOrDefault() !== 1) return { error: 'not_us_number' };
  if (!phoneUtil.isPossibleNumber(parsed)) return { error: 'invalid_phone' };
  if (String(parsed.getNationalNumberOrDefault()).length !== 10) return { error: 'invalid_phone' };

  return { e164: phoneUtil.format(parsed, PhoneNumberFormat.E164) };
}
