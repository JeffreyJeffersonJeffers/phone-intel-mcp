import { createFacilitatorConfig } from '@coinbase/x402';
import {
  decodePaymentSignatureHeader,
  encodePaymentResponseHeader,
  HTTPFacilitatorClient,
  type FacilitatorConfig,
} from '@x402/core/http';
import {
  FacilitatorTimeoutError,
  SettleError,
  VerifyError,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
} from '@x402/core/types';
import { authorizationTypes } from '@x402/evm';
import { getAddress, verifyTypedData, type Address, type Hex } from 'viem';
import { env } from '../env.js';

// The receiving side of x402 (v2). USDC lands in Jeff's Coinbase CDP server wallet, but this
// process never signs anything: the buyer signs an EIP-3009 authorization and the facilitator
// (Coinbase's reference verifier/settler) submits it on-chain, paying gas. So at runtime we only
// need the wallet *address*; the CDP API key/secret authenticate us to the mainnet facilitator.
// The wallet itself is created once, by hand, with scripts/create-wallet.ts, so the address stays
// stable.

// Internal name kept as 'base' / 'base-sepolia' for config simplicity. The wire format (what goes
// to the facilitator and the client) is CAIP-2 (eip155:<chainId>).
export type PaymentNetwork = 'base' | 'base-sepolia';
export type UsdcAmount = '0.03';

const USDC = {
  base: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', chainId: 8453 },
  'base-sepolia': { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC', chainId: 84532 },
} as const;

export const caip2Of = (network: PaymentNetwork): `eip155:${number}` => `eip155:${USDC[network].chainId}`;
const chainIdOf = (network: PaymentNetwork): number => USDC[network].chainId;

// 0.03 USDC → "30000" (USDC has 6 decimals everywhere we support).
const USDC_DECIMALS = 6;
const toAtomicUsdc = (amount: UsdcAmount): string => String(Math.round(Number(amount) * 10 ** USDC_DECIMALS));

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_TIMEOUT_SECONDS = 60;
// The reference verifier only requires validBefore >= now + 6 s, with no upper bound. Without a cap
// a payer could pin ledger entries (and so server memory) for decades, and a restart would leave
// every old nonce replayable. We advertise 60 s; the extra 10 s is clock-skew room.
const MAX_VALID_BEFORE_SECONDS = MAX_TIMEOUT_SECONDS + 10;
// The facilitator package's zod schema accepts "1e5", "1.0" and "" as integers. Strict digits only,
// so BigInt() below can't throw on payer-controlled input.
const DIGITS = /^\d+$/;
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

const facilitators = new Map<PaymentNetwork, HTTPFacilitatorClient>();

// Base-Sepolia uses the public testnet facilitator (x402.org, no auth). Base mainnet uses Coinbase's
// CDP facilitator, which needs the CDP API key. Resolved eagerly by requirePayment so a missing
// key fails at startup, not on the first paying customer.
export function getFacilitator(network: PaymentNetwork): HTTPFacilitatorClient {
  let facilitator = facilitators.get(network);
  if (!facilitator) {
    let config: FacilitatorConfig | undefined;
    if (network === 'base-sepolia') {
      config = { url: 'https://x402.org/facilitator' };
    } else {
      if (!env.CDP_API_KEY || !env.CDP_API_SECRET) {
        throw new Error('CDP_API_KEY and CDP_API_SECRET are required to verify and settle payments on Base mainnet');
      }
      config = createFacilitatorConfig(env.CDP_API_KEY, env.CDP_API_SECRET);
    }
    facilitator = new HTTPFacilitatorClient(config);
    facilitators.set(network, facilitator);
  }
  return facilitator;
}

// The one PaymentRequirements row the client is offered. v2 PaymentRequirements no longer carries
// resource/description/mimeType: those move to the top-level PaymentRequired object (see
// buildPaymentRequired below).
export function buildRequirements(amount: UsdcAmount, network: PaymentNetwork): PaymentRequirements {
  const token = USDC[network];
  return {
    scheme: 'exact',
    network: caip2Of(network),
    amount: toAtomicUsdc(amount),
    asset: token.address,
    payTo: getWalletAddress(),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    // EIP-712 domain for TransferWithAuthorization: name/version match the USDC contract, so the
    // signature the client makes recovers to the address it names.
    extra: { name: token.name, version: '2' },
  };
}

// Builds the full 402 payload (v2 PaymentRequired), carrying the resource URL and extensions.
export function buildPaymentRequired(
  resourceUrl: string,
  error: string | undefined,
  requirements: PaymentRequirements,
  extensions: Record<string, unknown> | undefined,
): PaymentRequired {
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl },
    accepts: [requirements],
    extensions,
  };
}

// Note: this stops waiting, it does not cancel the facilitator's fetch. A timed-out call can still
// complete on the facilitator's side.
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
// This in-process ledger lets a payment through once. Check-and-claim is synchronous (no await
// between the two), so concurrent requests with the same header can't both get in. It is released
// only if verification itself fails; once verified, the nonce stays claimed until the authorization
// expires (validBefore), even if the request later fails: a spent payment is simply re-signed.
// Single instance only; with several machines it needs a shared store.
// Entries live at most MAX_VALID_BEFORE_SECONDS (validBefore is capped), so a restart leaves a
// replay window of at most that long too.
const claimedNonces = new Map<string, number>();
let lastSweep = 0;

// Returns a release function, or null if this payment was already claimed.
function claimNonce(from: string, nonce: string, validBefore: number): (() => void) | null {
  const now = Math.floor(Date.now() / 1000);
  // At most one sweep a second, so request cost doesn't grow with the size of the ledger.
  if (now !== lastSweep) {
    lastSweep = now;
    for (const [key, expiry] of claimedNonces) if (expiry < now) claimedNonces.delete(key);
  }
  // Both lowercased: the nonce regex accepts mixed-case hex, and the signature verifies over the
  // bytes, so 0xABCD... and 0xabcd... are the same authorization.
  const key = `${from.toLowerCase()}:${nonce.toLowerCase()}`;
  if (claimedNonces.has(key)) return null;
  claimedNonces.set(key, validBefore);
  return () => void claimedNonces.delete(key);
}

// Takes the payer's single in-flight slot (see x402Middleware), or returns null if it is taken.
export type AdmitPayer = (from: string) => (() => void) | null;

// An ordinary wallet's ECDSA signature: r (32 bytes) + s (32) + v (1).
const ECDSA_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

interface ExactEvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

// Whether `authorization.from` can be trusted as the payer's identity, checked here with no network
// call (it is the same EIP-712 TransferWithAuthorization the facilitator verifies, rebuilt from
// what the client sent and our own requirements). `from` is text anyone can write, and it keys the
// per-payer in-flight cap, so it has to be authenticated before it can hold a slot: otherwise
// requests naming a victim's (public, on-chain) address keep that victim's slot taken.
//
// EOA-only: the one accepted shape is a 65-byte ECDSA signature made by `from`. Anything else is
// rejected, whatever its length. That includes smart-contract wallets (ERC-1271, or ERC-6492 for a
// not yet deployed one; 64-byte EIP-2098 compact signatures too), which could only be checked with
// an on-chain call and so are not supported. It must be a rejection and not a pass-through: a
// forger picks the signature, so any length that skipped this check would be the one they send, and
// would again hold the victim's slot.
async function isSignedByNamedPayer(
  signature: string,
  authorization: ExactEvmAuthorization,
  requirements: PaymentRequirements,
  network: PaymentNetwork,
): Promise<boolean> {
  if (!ECDSA_SIGNATURE.test(signature)) return false;
  const { name, version } = requirements.extra as { name: string; version: string };
  try {
    // getAddress, like the client's signer: viem's EIP-712 encoder rejects a mixed-case address
    // whose case is not its checksum, though the signature is the same for any case.
    const from = getAddress(authorization.from);
    return await verifyTypedData({
      address: from,
      domain: {
        name,
        version,
        chainId: chainIdOf(network),
        verifyingContract: requirements.asset as Address,
      },
      types: authorizationTypes,
      primaryType: 'TransferWithAuthorization',
      message: {
        from,
        to: getAddress(authorization.to),
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as Hex,
      },
      signature: signature as Hex,
    });
  } catch {
    return false; // 65 bytes that don't recover to any address
  }
}

// `facilitatorError` marks a failure of the facilitator call itself (timeout, network, garbled
// reply) as opposed to a verdict about the payment, so the middleware can log the two differently.
// `concurrent` means the payer already has a request in flight: not a verdict on the payment, which
// is left unused (its nonce released) so the same header can be sent again. On success the caller
// holds the payer's slot and must call `releaseSlot` once the request is over.
export type VerifyResult =
  | { ok: true; payload: PaymentPayload; requirements: PaymentRequirements; payer: string; releaseSlot: () => void }
  | { ok: false; reason: string; facilitatorError?: true; concurrent?: true };

// `resource` goes to the facilitator (via buildPaymentRequired), a third party. Pass the route
// pattern, never the request URL: for /lookup/:phone the URL is the phone number.
export async function verifyPayment(
  x402Header: string,
  requiredAmount: UsdcAmount,
  network: PaymentNetwork,
  admitPayer: AdmitPayer,
): Promise<VerifyResult> {
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(x402Header);
  } catch {
    return { ok: false, reason: 'invalid_payment_header' };
  }
  const requirements = buildRequirements(requiredAmount, network);

  // Cheap local checks on what decides whether we get paid, so a wrong payment never costs a
  // facilitator round trip. The facilitator re-checks all of it.
  const accepted = payload.accepted;
  if (!accepted || typeof accepted !== 'object') return { ok: false, reason: 'invalid_payment_header' };
  if (accepted.scheme !== requirements.scheme) return { ok: false, reason: 'unsupported_scheme' };
  if (accepted.network !== requirements.network) return { ok: false, reason: 'invalid_network' };
  const innerPayload = payload.payload as { signature?: unknown; authorization?: unknown };
  if (
    typeof innerPayload?.signature !== 'string' ||
    typeof innerPayload.authorization !== 'object' ||
    innerPayload.authorization === null
  ) {
    return { ok: false, reason: 'invalid_payment_header' };
  }
  const authorization = innerPayload.authorization as ExactEvmAuthorization;
  const signature = innerPayload.signature;
  if (
    typeof authorization.from !== 'string' ||
    typeof authorization.to !== 'string' ||
    typeof authorization.value !== 'string' ||
    typeof authorization.validAfter !== 'string' ||
    typeof authorization.validBefore !== 'string' ||
    typeof authorization.nonce !== 'string'
  ) {
    return { ok: false, reason: 'invalid_payment_header' };
  }
  if (authorization.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return { ok: false, reason: 'invalid_exact_evm_payload_recipient_mismatch' };
  }
  if (
    !DIGITS.test(authorization.value) ||
    !DIGITS.test(authorization.validBefore) ||
    !DIGITS.test(authorization.validAfter)
  ) {
    return { ok: false, reason: 'invalid_payment_header' };
  }
  if (BigInt(authorization.value) < BigInt(requirements.amount)) {
    return { ok: false, reason: 'invalid_exact_evm_payload_authorization_value' };
  }
  const validBefore = Number(authorization.validBefore);
  if (validBefore > Math.floor(Date.now() / 1000) + MAX_VALID_BEFORE_SECONDS) {
    return { ok: false, reason: 'invalid_payment_header' };
  }

  // Before the nonce claim and the slot: a forgery must not hold either (see isSignedByNamedPayer).
  // Same reason the facilitator gives for the same failure.
  if (!(await isSignedByNamedPayer(signature, authorization, requirements, network))) {
    return { ok: false, reason: 'invalid_exact_evm_payload_signature' };
  }

  const release = claimNonce(authorization.from, authorization.nonce, validBefore);
  if (!release) return { ok: false, reason: 'payment_already_used' };

  // After the nonce claim, so a replayed header still reads payment_already_used; before the
  // facilitator call, so this payment's balance check comes after the previous one's settlement.
  const releaseSlot = admitPayer(authorization.from);
  if (!releaseSlot) {
    release(); // never served or settled: the client may send this same header again
    return { ok: false, reason: 'concurrent_request', concurrent: true };
  }

  try {
    const verdict = await withTimeout(getFacilitator(network).verify(payload, requirements), VERIFY_TIMEOUT_MS);
    if (!verdict.isValid) {
      release();
      releaseSlot();
      return { ok: false, reason: reasonOf(verdict.invalidReason, 'verification_failed') };
    }
  } catch (err) {
    release();
    releaseSlot();
    // Never log err: it can carry the payer address and the facilitator's response.
    if (err instanceof VerifyError) return { ok: false, reason: reasonOf(err.invalidReason, 'verification_failed') };
    if (err instanceof FacilitatorTimeoutError) return { ok: false, reason: 'verification_failed', facilitatorError: true };
    return { ok: false, reason: 'verification_failed', facilitatorError: true };
  }
  return { ok: true, payload, requirements, payer: authorization.from, releaseSlot };
}

export type SettleResult = { ok: true; header: string } | { ok: false; reason: string; facilitatorError?: true };

// Moves the USDC. `header` is the value for the payment-response response header.
export async function settlePayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  network: PaymentNetwork,
): Promise<SettleResult> {
  try {
    const settlement = await withTimeout(getFacilitator(network).settle(payload, requirements), SETTLE_TIMEOUT_MS);
    if (!settlement.success) return { ok: false, reason: reasonOf(settlement.errorReason, 'settlement_failed') };
    return { ok: true, header: encodePaymentResponseHeader(settlement) };
  } catch (err) {
    if (err instanceof SettleError) return { ok: false, reason: reasonOf(err.errorReason, 'settlement_failed') };
    return { ok: false, reason: 'settlement_failed', facilitatorError: true };
  }
}
