import twilio from 'twilio';
import { getCached, setCached } from '../cache/cache.js';
import { env } from '../env.js';

export type CarrierType = 'mobile' | 'landline' | 'voip' | 'tollFree' | 'unknown';

export interface TwilioLookup {
  carrier: { name: string | null; type: CarrierType };
  caller_name: string | null;
  cached: boolean;
}

const TIMEOUT_MS = 900;

// Twilio Lookup v2 line_type_intelligence.type -> our enum. A Map, not an object literal, so an
// odd upstream value like "constructor" cannot resolve through Object.prototype.
const CARRIER_TYPES = new Map<string, CarrierType>([
  ['mobile', 'mobile'],
  ['landline', 'landline'],
  ['nonFixedVoip', 'voip'],
  ['fixedVoip', 'voip'],
  ['tollFree', 'tollFree'],
  ['toll-free', 'tollFree'],
]);

const DEGRADED: Omit<TwilioLookup, 'cached'> = {
  carrier: { name: null, type: 'unknown' },
  caller_name: null,
};

// Created lazily and reused: the SDK client keeps its HTTPS agent (and connections) alive.
let client: ReturnType<typeof twilio> | undefined;
function twilioClient(sid: string, token: string): ReturnType<typeof twilio> {
  client ??= twilio(sid, token);
  return client;
}

// Resolves to null if `work` has not settled within `ms`. The timer is always cleared so a fast
// response does not leave a live handle behind; a late rejection from `work` is still handled
// because Promise.race subscribes to both sides.
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, ms, null);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Bad credentials do not fix themselves, and degrading would hide them behind "unknown carrier"
// on every call. Surface 401/403 (or Twilio's code 20003, "Authenticate") loudly. The message
// carries only the status and code: never the original error, which could echo request details.
function throwIfAuthError(err: unknown): void {
  const { status, code } = (err ?? {}) as { status?: unknown; code?: unknown };
  if (status === 401 || status === 403 || code === 20003) {
    throw new Error(`Twilio authentication failed (HTTP ${status ?? 'unknown'}, Twilio code ${code ?? 'unknown'})`);
  }
}

export async function lookupTwilio(phoneE164: string): Promise<TwilioLookup> {
  const { TWILIO_SID: sid, TWILIO_TOKEN: token } = env;
  if (!sid) throw new Error('TWILIO_SID is not set');
  if (!token) throw new Error('TWILIO_TOKEN is not set');

  const hit = await getCached<Omit<TwilioLookup, 'cached'>>(phoneE164, 'carrier');
  if (hit) return { ...hit, cached: true };

  // Built outside the try: a constructor failure (the SDK rejects a SID not starting with "AC")
  // is a config error with no status/code, so it must surface, not degrade to "unknown carrier".
  const api = twilioClient(sid, token);

  let response;
  try {
    response = await withTimeout(
      api.lookups.v2.phoneNumbers(phoneE164).fetch({ fields: 'line_type_intelligence,caller_name' }),
      TIMEOUT_MS,
    );
  } catch (err) {
    throwIfAuthError(err);
    response = null; // any other Twilio error (5xx, network, 404): degrade like a timeout
  }
  // Timeout or error: degrade, and do not cache, so the next call retries the vendor.
  if (!response) return { ...DEGRADED, cached: false };

  const line = response.lineTypeIntelligence;
  const result: Omit<TwilioLookup, 'cached'> = {
    carrier: {
      name: line?.carrierName ?? null,
      type: CARRIER_TYPES.get(line?.type ?? '') ?? 'unknown',
    },
    caller_name: response.callerName?.callerName ?? null,
  };
  // A 200 whose line-type lookup failed (errorCode set, or no type) is a transient vendor gap,
  // not an answer. Return what we have but do not cache it, so the next call retries.
  if (!line?.errorCode && line?.type) await setCached(phoneE164, 'carrier', result);
  return { ...result, cached: false };
}
