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

export async function lookupTwilio(phoneE164: string): Promise<TwilioLookup> {
  const { TWILIO_SID: sid, TWILIO_TOKEN: token } = env;
  if (!sid) throw new Error('TWILIO_SID is not set');
  if (!token) throw new Error('TWILIO_TOKEN is not set');

  const hit = await getCached<Omit<TwilioLookup, 'cached'>>(phoneE164, 'carrier');
  if (hit) return { ...hit, cached: true };

  let response;
  try {
    response = await withTimeout(
      twilioClient(sid, token)
        .lookups.v2.phoneNumbers(phoneE164)
        .fetch({ fields: 'line_type_intelligence,caller_name' }),
      TIMEOUT_MS,
    );
  } catch {
    response = null; // Twilio error: degrade like a timeout
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
  await setCached(phoneE164, 'carrier', result);
  return { ...result, cached: false };
}
