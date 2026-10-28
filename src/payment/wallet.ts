import { createFacilitatorConfig } from '@coinbase/x402';
import { decodePayment } from 'x402/schemes';
import { processPriceToAtomicAmount } from 'x402/shared';
import {
  SettleError,
  VerifyError,
  settleResponseHeader,
  type PaymentPayload,
  type PaymentRequirements,
} from 'x402/types';
import { useFacilitator } from 'x402/verify';
import { env } from '../env.js';

// The receiving side of x402. USDC lands in Jeff's Coinbase CDP server wallet, but this process
// never signs anything: the buyer signs an EIP-3009 authorization and the facilitator (Coinbase's
// reference verifier/settler) submits it on-chain, paying gas. So at runtime we only need the
// wallet *address*; the CDP API key/secret authenticate us to the mainnet facilitator. The wallet
// itself is created once, by hand, with scripts/create-wallet.ts, so the address stays stable.

export type PaymentNetwork = 'base' | 'base-sepolia';
export type UsdcAmount = '0.03';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_TIMEOUT_SECONDS = 60;
const VERIFY_TIMEOUT_MS = 5_000;
const SETTLE_TIMEOUT_MS = 15_000;

export function getWalletAddress(): string {
  const address = env.WALLET_ADDRESS;
  if (!address) {
    throw new Error(
      'WALLET_ADDRESS is not set. Create the receiving wallet once with ' +
        '`npx tsx --env-file=.env.local scripts/create-wallet.ts`, then set the address it prints as WALLET_ADDRESS.',
    );
  }
  if (!EVM_ADDRESS.test(address)) throw new Error('WALLET_ADDRESS is not a valid 0x-prefixed EVM address');
  return address;
}

type Facilitator = ReturnType<typeof useFacilitator>;
const facilitators = new Map<PaymentNetwork, Facilitator>();

// Base-Sepolia uses the public testnet facilitator (x402.org, no auth). Base mainnet uses Coinbase's
// CDP facilitator, which needs the CDP API key. Resolved eagerly by requirePayment so a missing
// key fails at startup, not on the first paying customer.
export function getFacilitator(network: PaymentNetwork): Facilitator {
  let facilitator = facilitators.get(network);
  if (!facilitator) {
    if (network === 'base-sepolia') {
      facilitator = useFacilitator();
    } else {
      if (!env.CDP_API_KEY || !env.CDP_API_SECRET) {
        throw new Error('CDP_API_KEY and CDP_API_SECRET are required to verify and settle payments on Base mainnet');
      }
      // @coinbase/x402 types its config against @x402/core (v2); the v1 client takes the same
      // { url, createAuthHeaders } shape.
      facilitator = useFacilitator(
        createFacilitatorConfig(env.CDP_API_KEY, env.CDP_API_SECRET) as Parameters<typeof useFacilitator>[0],
      );
    }
    facilitators.set(network, facilitator);
  }
  return facilitator;
}

export function buildRequirements(amount: UsdcAmount, network: PaymentNetwork, resource: string): PaymentRequirements {
  const price = processPriceToAtomicAmount(amount, network);
  if ('error' in price) throw new Error(price.error);
  return {
    scheme: 'exact',
    network,
    maxAmountRequired: price.maxAmountRequired,
    resource,
    description: 'Phone number intelligence lookup',
    mimeType: 'application/json',
    payTo: getWalletAddress(),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    asset: price.asset.address,
    extra: 'eip712' in price.asset ? price.asset.eip712 : undefined,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('facilitator timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const reasonOf = (reason: unknown, fallback: string): string => (typeof reason === 'string' && reason ? reason : fallback);

// The reference verifier does not check whether an authorization nonce was already used, so a
// replayed header passes /verify, runs the vendors, and only then fails at /settle: free lookups.
// This in-process ledger lets a payment through once. The claim is taken synchronously before the
// first await, so concurrent requests with the same header can't both get in. It is released only
// if verification itself fails; once verified, the nonce stays claimed until the authorization
// expires (validBefore), even if the request later fails: a spent payment is simply re-signed.
// Single instance only; with several machines it needs a shared store.
const claimedNonces = new Map<string, number>();

// Returns a release function, or null if this payment was already claimed.
function claimNonce(from: string, nonce: string, validBefore: number): (() => void) | null {
  const now = Math.floor(Date.now() / 1000);
  for (const [key, expiry] of claimedNonces) if (expiry < now) claimedNonces.delete(key);
  const key = `${from.toLowerCase()}:${nonce}`;
  if (claimedNonces.has(key)) return null;
  claimedNonces.set(key, validBefore);
  return () => void claimedNonces.delete(key);
}

export type VerifyResult =
  | { ok: true; payload: PaymentPayload; requirements: PaymentRequirements }
  | { ok: false; reason: string };

// `resource` goes to the facilitator, a third party. Pass the route pattern, never the request
// URL: for /lookup/:phone the URL is the phone number.
export async function verifyPayment(
  x402Header: string,
  requiredAmount: UsdcAmount,
  network: PaymentNetwork,
  resource: string,
): Promise<VerifyResult> {
  let payload: PaymentPayload;
  try {
    payload = decodePayment(x402Header);
  } catch {
    return { ok: false, reason: 'invalid_payment_header' };
  }
  const requirements = buildRequirements(requiredAmount, network, resource);

  // Cheap local checks on what decides whether we get paid, so a wrong payment never costs a
  // facilitator round trip. The facilitator re-checks all of it.
  if (payload.scheme !== requirements.scheme) return { ok: false, reason: 'unsupported_scheme' };
  if (payload.network !== requirements.network) return { ok: false, reason: 'invalid_network' };
  if (!('authorization' in payload.payload)) return { ok: false, reason: 'invalid_payment_header' };
  const { authorization } = payload.payload;
  if (authorization.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return { ok: false, reason: 'invalid_exact_evm_payload_recipient_mismatch' };
  }
  if (BigInt(authorization.value) < BigInt(requirements.maxAmountRequired)) {
    return { ok: false, reason: 'invalid_exact_evm_payload_authorization_value' };
  }

  const release = claimNonce(authorization.from, authorization.nonce, Number(authorization.validBefore));
  if (!release) return { ok: false, reason: 'payment_already_used' };

  try {
    const verdict = await withTimeout(getFacilitator(network).verify(payload, requirements), VERIFY_TIMEOUT_MS);
    if (!verdict.isValid) {
      release();
      return { ok: false, reason: reasonOf(verdict.invalidReason, 'verification_failed') };
    }
  } catch (err) {
    release();
    // Never log err: it can carry the payer address and the facilitator's response.
    return {
      ok: false,
      reason: reasonOf(err instanceof VerifyError ? err.invalidReason : undefined, 'verification_failed'),
    };
  }
  return { ok: true, payload, requirements };
}

export type SettleResult = { ok: true; header: string } | { ok: false; reason: string };

// Moves the USDC. `header` is the value for the X-PAYMENT-RESPONSE response header.
export async function settlePayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  network: PaymentNetwork,
): Promise<SettleResult> {
  try {
    const settlement = await withTimeout(getFacilitator(network).settle(payload, requirements), SETTLE_TIMEOUT_MS);
    if (!settlement.success) return { ok: false, reason: reasonOf(settlement.errorReason, 'settlement_failed') };
    return { ok: true, header: settleResponseHeader(settlement) };
  } catch (err) {
    return { ok: false, reason: reasonOf(err instanceof SettleError ? err.errorReason : undefined, 'settlement_failed') };
  }
}
