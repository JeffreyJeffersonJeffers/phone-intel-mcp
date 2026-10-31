import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import type { FastifyReply, FastifyRequest, onSendAsyncHookHandler, preHandlerAsyncHookHandler } from 'fastify';
import { bazaarDiscovery } from './discovery.js';
import { setPayer } from './payer.js';
import {
  buildPaymentRequired,
  buildRequirements,
  getFacilitator,
  getWalletAddress,
  settlePayment,
  verifyPayment,
  type AdmitPayer,
  type PaymentNetwork,
  type UsdcAmount,
} from './wallet.js';

// x402 v2 (https://github.com/x402-foundation/x402) as a Fastify gate. A paid call is two hooks:
//   preHandler  requirePayment()      402 challenge if no valid PAYMENT-SIGNATURE/X-PAYMENT, else
//                                     verify and continue
//   onSend      settleOnSuccess()     once the handler has answered 2xx/3xx, move the USDC
// The money moves only after a successful lookup, so a malformed phone or a vendor failure is
// never charged, and if settlement fails the dossier is withheld (402), never given away.
//
// Logging: this file logs payment status only. Never the request path (for /lookup/:phone that is
// the phone number), the payment header, or an error object.

// One request per paying wallet at a time. The facilitator checks a payer's balance per call, not
// cumulatively, so a payer with 0.03 USDC could sign N authorizations with different nonces, send
// them together, and have every one pass /verify and run the vendors while only the first can
// settle. The replay ledger can't catch that (the nonces differ). The slot is taken before /verify
// and held through serving and settlement, so the next authorization's /verify happens after the
// previous one's settlement has moved the money. A second concurrent request gets a 429 and is
// never verified or served.
//
// In memory, so single instance only; with several machines it needs a shared store.
// A slot older than SLOT_MAX_AGE_MS is treated as free: every normal path releases its slot (in
// settleOnSuccess' finally, or skipSettlement), so one that is still held after this long belongs
// to a request that hung, and must not lock the payer out until the next restart.
const SLOT_MAX_AGE_MS = 60_000;
const CONCURRENT_RETRY_AFTER_SECONDS = 2;

function createPayerSlots(): AdmitPayer {
  const held = new Map<string, { since: number }>();
  return (from) => {
    // Lowercased like the replay ledger's keys: an address is the same wallet in any hex case.
    const key = from.toLowerCase();
    const now = Date.now();
    const current = held.get(key);
    if (current && now - current.since < SLOT_MAX_AGE_MS) return null;
    const slot = { since: now };
    held.set(key, slot);
    // Idempotent, and a no-op if the slot has since expired and been given to someone else.
    return () => {
      if (held.get(key) === slot) held.delete(key);
    };
  };
}

interface VerifiedPayment {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  network: PaymentNetwork;
  releaseSlot: () => void;
}
const verified = new WeakMap<FastifyRequest, VerifiedPayment>();

// v2 clients read the base64 PaymentRequired from the `payment-required` response header.
// We also send the same object as the JSON body so simple clients (and inspection tools) can see
// what is being asked without base64-decoding a header. The Coinbase CDP facilitator reads
// `extensions.bazaar` (src/payment/discovery.ts) during verify/settle and catalogs the service in
// the Bazaar, which is what x402.new indexes from.
function challenge(
  resourceUrl: string,
  error: string | undefined,
  requirements: PaymentRequirements,
): { body: PaymentRequired; header: string } {
  const body = buildPaymentRequired(resourceUrl, error, requirements, { bazaar: bazaarDiscovery() });
  return { body, header: encodePaymentRequiredHeader(body) };
}

function paymentRequired(
  reply: FastifyReply,
  resourceUrl: string,
  error: string,
  requirements: PaymentRequirements,
) {
  const { body, header } = challenge(resourceUrl, error, requirements);
  return reply.code(402).header('payment-required', header).send(body);
}

export function requirePayment(amountUsdc: UsdcAmount, network: PaymentNetwork): preHandlerAsyncHookHandler {
  // Fail at startup, not on the first customer: no receiving wallet, or no CDP key for mainnet.
  getWalletAddress();
  getFacilitator(network);
  const admitPayer = createPayerSlots();

  return async (request, reply) => {
    const origin = `${request.protocol}://${request.host}`;
    // The client already knows its own URL, so the challenge may name it.
    const resourceUrl = `${origin}${request.url}`;
    const requirements = buildRequirements(amountUsdc, network);

    // Accept both header names: PAYMENT-SIGNATURE is the v2 canonical name; X-PAYMENT is the v1
    // name that most existing clients still send.
    const header = request.headers['payment-signature'] ?? request.headers['x-payment'];
    if (typeof header !== 'string' || header === '') {
      request.log.info({ payment: 'missing' }, 'payment required');
      return paymentRequired(reply, resourceUrl, 'X-PAYMENT header is required', requirements);
    }

    const result = await verifyPayment(header, amountUsdc, network, admitPayer);
    if (!result.ok) {
      if (result.concurrent) {
        request.log.info({ payment: 'concurrent_request' }, 'payer already has a request in flight');
        return reply
          .code(429)
          .header('retry-after', String(CONCURRENT_RETRY_AFTER_SECONDS))
          .send({ error: { code: 'concurrent_request', retry_after_seconds: CONCURRENT_RETRY_AFTER_SECONDS } });
      }
      // A bad payment and a broken facilitator look the same to the client (402) but not to us:
      // the second one needs someone to look at it. Status only, never the error itself.
      if (result.facilitatorError) request.log.error({ payment: 'facilitator_error' }, 'facilitator error');
      else request.log.info({ payment: 'rejected' }, 'payment rejected');
      return paymentRequired(reply, resourceUrl, result.reason, requirements);
    }
    verified.set(request, {
      payload: result.payload,
      requirements: result.requirements,
      network,
      releaseSlot: result.releaseSlot,
    });
    setPayer(request, result.payer);
    request.log.info({ payment: 'verified' }, 'payment verified');
  };
}

// For a handler that reports failure inside a 2xx, which settleOnSuccess cannot see (an MCP tool
// error is HTTP 200 with isError set). Drops the verified payment so it is not settled. The nonce
// stays claimed, as for any failed call: the client simply signs a new payment.
export function skipSettlement(request: FastifyRequest): void {
  const payment = verified.get(request);
  if (!payment) return;
  verified.delete(request);
  payment.releaseSlot();
  request.log.info({ payment: 'not_charged' }, 'payment not settled: request failed');
}

export const settleOnSuccess: onSendAsyncHookHandler = async (request, reply, payload) => {
  const payment = verified.get(request);
  if (!payment) return payload; // unpaid or rejected: the 402 was already sent by the preHandler
  verified.delete(request);
  // The payer's slot is held until settlement has resolved or failed, however this ends.
  try {
    return await settleVerified(request, reply, payload, payment);
  } finally {
    payment.releaseSlot();
  }
};

async function settleVerified(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  payment: VerifiedPayment,
): Promise<unknown> {
  if (reply.statusCode >= 400) {
    request.log.info({ payment: 'not_charged' }, 'payment not settled: request failed');
    return payload;
  }

  const settlement = await settlePayment(payment.payload, payment.requirements, payment.network);
  if (!settlement.ok) {
    if (settlement.facilitatorError) request.log.error({ payment: 'facilitator_error' }, 'facilitator error');
    else request.log.warn({ payment: 'settlement_failed' }, 'payment settlement failed');
    // Replace the dossier with the 402. The body is serialized by hand: onSend runs after
    // Fastify's own serialization, so it takes the final payload string.
    const origin = `${request.protocol}://${request.host}`;
    const resourceUrl = `${origin}${request.url}`;
    const { body, header } = challenge(resourceUrl, settlement.reason, payment.requirements);
    reply.code(402).header('payment-required', header);
    return JSON.stringify(body);
  }
  // Modern (v2) and compat (v1) response header names so both generations of clients can read it.
  reply.header('payment-response', settlement.header);
  reply.header('x-payment-response', settlement.header);
  request.log.info({ payment: 'settled' }, 'payment settled');
  return payload;
}
