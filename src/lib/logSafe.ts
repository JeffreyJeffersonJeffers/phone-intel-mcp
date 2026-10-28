import { env } from '../env.js';

// Vendor, database and framework error text is not ours: it can quote the URL that was fetched,
// which holds the phone number (and for IPQS the API key). Nothing from an error object reaches a
// log line except through here.

const MAX_LOGGED_ERROR_CHARS = 300;
const SHORTEST_SECRET = 8;

// A US number in any common spelling (+1, 1-, (516), dots, dashes, spaces; a percent-encoded + leaves
// its 1 and digits intact), E.164 of other countries, or any run of 10+ digits. Deliberately not
// "any digits": codes (HTTP 401, Twilio 20003), ports and IP addresses carry the diagnosis.
const PHONE_LIKE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|\+\d{8,15}|\d{10,}/g;

// Credentials this process holds. (One shorter than SHORTEST_SECRET would be redacting ordinary words.)
function configuredSecrets(): string[] {
  return [
    env.TWILIO_TOKEN,
    env.YELP_API_KEY,
    env.SCRAPERAPI_KEY,
    env.GOOGLE_PLACES_API_KEY,
    env.IPQS_API_KEY,
    env.CDP_API_KEY,
    env.CDP_API_SECRET,
    env.DATABASE_URL,
    env.LOG_PHONE_HMAC_KEY,
  ].filter((value): value is string => !!value && value.length >= SHORTEST_SECRET);
}

export function redact(text: string, secrets: readonly string[] = configuredSecrets()): string {
  let out = text;
  // Secrets first: one that is all digits would otherwise be half-eaten by the phone pattern.
  // Raw and URL-encoded, since a key that was in a request URL appears encoded.
  for (const secret of secrets) {
    if (!secret) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) out = out.split(form).join('[redacted]');
  }
  return out.replace(PHONE_LIKE, '[number]');
}

// The message of an error (never its name, stack, cause or other properties), redacted and capped.
// This is the only form of an error that may be logged.
export function safeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redact(message).slice(0, MAX_LOGGED_ERROR_CHARS);
}
