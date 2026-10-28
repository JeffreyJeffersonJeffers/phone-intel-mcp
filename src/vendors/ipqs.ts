import { getCached, setCached } from '../cache/cache.js';
import { env } from '../env.js';

interface Reputation {
  spam_risk_score: number;
  is_known_robocall: boolean;
  is_dnc_listed: boolean | null;
  is_voip_risk: boolean;
}

export type ReputationLookup = Reputation & { cached: boolean };

const TIMEOUT_MS = 900;

// Neutral default for a timeout, network error or unusable vendor reply. Not cached, so the next call retries.
const DEGRADED: ReputationLookup = {
  spam_risk_score: 0,
  is_known_robocall: false,
  is_dnc_listed: null,
  is_voip_risk: false,
  cached: false,
};

// The subset of IPQS's phone-validation response we read. Upstream data, so everything is optional.
interface IpqsPhoneResponse {
  success?: unknown;
  message?: unknown;
  fraud_score?: unknown;
  risky?: unknown;
  do_not_call?: unknown;
  VOIP?: unknown;
}

// IPQS reports a bad key or an exhausted quota as success:false with a message. The bare word
// "invalid" is deliberately not here: IPQS also answers an unknown number with success:false and
// "Invalid/nonexistent phone number...", which is a normal answer and must degrade, not throw.
const AUTH_MESSAGE = /\bkey\b|token|quota|limit|exceed|credit/i;

function toReputation(b: IpqsPhoneResponse): Reputation {
  return {
    spam_risk_score: typeof b.fraud_score === 'number' && Number.isFinite(b.fraud_score) ? b.fraud_score : 0,
    is_known_robocall: b.risky === true,
    is_dnc_listed: typeof b.do_not_call === 'boolean' ? b.do_not_call : null,
    is_voip_risk: b.VOIP === true,
  };
}

export async function lookupReputation(phoneE164: string): Promise<ReputationLookup> {
  const apiKey = env.IPQS_API_KEY;
  if (!apiKey) throw new Error('IPQS_API_KEY is not set');

  const hit = await getCached<Reputation>(phoneE164, 'reputation');
  if (hit) return { ...hit, cached: true };

  // One AbortController covers connect, headers and body read, as in the Yelp adapter.
  // The key sits in the URL path, so no error from this block is ever rethrown: see the catch below.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let status: number;
  let body: IpqsPhoneResponse | undefined;
  try {
    const url =
      `https://ipqualityscore.com/api/json/phone/${encodeURIComponent(apiKey)}/` +
      `${phoneE164.replace(/^\+/, '')}?strictness=1`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    status = response.status;
    if (response.ok) body = (await response.json()) as IpqsPhoneResponse;
  } catch {
    return DEGRADED; // timeout, network error, or a 200 body that is not JSON
  } finally {
    clearTimeout(timer);
  }

  // Bad credentials do not fix themselves. Surface 401/403 loudly, with the status only.
  if (status === 401 || status === 403) throw new Error(`IPQS authentication failed (HTTP ${status})`);
  // Any other non-2xx: degrade like a timeout, and do not cache.
  if (!body) return DEGRADED;

  if (body.success === false) {
    const message = String(body.message ?? '');
    if (!AUTH_MESSAGE.test(message)) return DEGRADED;
    // Redact the key in case IPQS echoes it back. The error carries no cause, so nothing else can leak.
    throw new Error(`IPQS rejected the request: ${message.replaceAll(apiKey, '[redacted]')}`);
  }
  // A 200 without success:true is a vendor gap, not an answer: do not cache it.
  if (body.success !== true) return DEGRADED;

  const result = toReputation(body);
  await setCached(phoneE164, 'reputation', result);
  return { ...result, cached: false };
}
