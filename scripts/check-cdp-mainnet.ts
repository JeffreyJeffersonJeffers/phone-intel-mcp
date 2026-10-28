// Pre-deploy gate for Base mainnet: asks Coinbase's CDP x402 facilitator what it supports and
// fails unless it still accepts the protocol our middleware speaks, x402 version 1 (`X-PAYMENT`
// header, `network: "base"`, EIP-3009 authorization). CDP's docs only show version 2 (CAIP-2
// network ids), so this has to be checked against the live endpoint with the real key.
//
//   npx tsx --env-file=.env.local scripts/check-cdp-mainnet.ts
//
// Exit 0: version 1 on `base` is listed. Exit 1: the facilitator answered but does not list it
// (do not deploy). Exit 2: could not find out (missing key, auth/HTTP error, network, bad reply).
//
// It builds the facilitator the same way src/payment/wallet.ts does (`createFacilitatorConfig`
// from @coinbase/x402: same URL, same JWT signing), so the request is the one the middleware would
// make. It prints the response body, which is public capability data, and never the credentials or
// the Authorization header.
import { pathToFileURL } from 'node:url';
import { createFacilitatorConfig } from '@coinbase/x402';

const TIMEOUT_MS = 10_000;
const MAX_PRINTED_CHARS = 4_000;

// True when /supported lists `exact` on `base` at x402 version 1. Anything unrecognizable is false:
// "can't tell" must never read as "go".
export function supportsV1OnBase(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const { kinds } = body as { kinds?: unknown };
  if (!Array.isArray(kinds)) return false;
  return kinds.some((kind) => {
    if (typeof kind !== 'object' || kind === null) return false;
    const { x402Version, scheme, network } = kind as Record<string, unknown>;
    return x402Version === 1 && scheme === 'exact' && network === 'base';
  });
}

function fail(code: 1 | 2, message: string): never {
  console.error(`\nFAIL: ${message}`);
  process.exit(code);
}

async function main(): Promise<void> {
  const { CDP_API_KEY, CDP_API_SECRET } = process.env;
  if (!CDP_API_KEY || !CDP_API_SECRET) {
    fail(2, 'CDP_API_KEY and CDP_API_SECRET must be set (run with `tsx --env-file=.env.local`).');
  }

  const facilitator = createFacilitatorConfig(CDP_API_KEY, CDP_API_SECRET);
  const url = `${facilitator.url}/supported`;
  console.log(`GET ${url}`);

  let status: number;
  let text: string;
  try {
    const auth = facilitator.createAuthHeaders ? (await facilitator.createAuthHeaders()).supported : {};
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...auth },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    // Message only: it names the failure (DNS, timeout, bad key format) and carries no secret.
    fail(2, `request did not complete: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`HTTP ${status}`);
  console.log(text.length > MAX_PRINTED_CHARS ? `${text.slice(0, MAX_PRINTED_CHARS)}\n... (truncated)` : text);

  if (status !== 200) {
    fail(2, `facilitator answered HTTP ${status}, not 200. Check the CDP key (401/403) before reading anything into this.`);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    fail(2, 'facilitator answered 200 but the body is not JSON.');
  }

  if (!supportsV1OnBase(body)) {
    const kinds = (body as { kinds?: unknown }).kinds;
    const listed = Array.isArray(kinds)
      ? kinds
          .map((k) => `v${(k as { x402Version?: unknown })?.x402Version}/${(k as { scheme?: unknown })?.scheme}/${(k as { network?: unknown })?.network}`)
          .join(', ')
      : '(no kinds array)';
    fail(
      1,
      'x402 v1 on network `base` (scheme `exact`) is NOT listed. Our middleware would be rejected on mainnet; ' +
        `a v2 migration is required before deploy. Listed: ${listed}`,
    );
  }

  console.log('\nOK: facilitator lists x402 v1 / exact / base. Our middleware is accepted on Base mainnet.');
}

// Only when run directly, so the test can import supportsV1OnBase without making a request.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
