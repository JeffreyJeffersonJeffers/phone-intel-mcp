import type { FastifyReply, FastifyRequest, onSendAsyncHookHandler, preHandlerAsyncHookHandler } from 'fastify';
import type { PaymentPayload, PaymentRequirements } from 'x402/types';
import { setPayer } from './payer.js';
import {
  buildRequirements,
  getFacilitator,
  getWalletAddress,
  settlePayment,
  verifyPayment,
  type AdmitPayer,
  type PaymentNetwork,
  type UsdcAmount,
} from './wallet.js';

// x402 v1 (https://github.com/coinbase/x402) as a Fastify gate. A paid call is two hooks:
//   preHandler  requirePayment()      402 challenge if no valid X-PAYMENT, else verify and continue
//   onSend      settleOnSuccess()     once the handler has answered 2xx/3xx, move the USDC
// The money moves only after a successful lookup, so a malformed phone or a vendor failure is
// never charged, and if settlement fails the dossier is withheld (402), never given away.
//
// Logging: this file logs payment status only. Never the request path (for /lookup/:phone that is
// the phone number), the X-PAYMENT header, or an error object.

const X402_VERSION = 1;

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

// The 402 body is the standard x402 shape so stock clients (x402-fetch, x402-axios) can pay it.
// The same challenge goes in x-payment-requirements, base64 JSON, for clients that read headers.
function challenge(error: string, requirements: PaymentRequirements) {
  const body = { x402Version: X402_VERSION, error, accepts: [requirements] };
  return { body, header: Buffer.from(JSON.stringify(body)).toString('base64') };
}

function paymentRequired(reply: FastifyReply, error: string, requirements: PaymentRequirements) {
  const { body, header } = challenge(error, requirements);
  return reply.code(402).header('x-payment-requirements', header).send(body);
}

export function requirePayment(amountUsdc: UsdcAmount, network: PaymentNetwork): preHandlerAsyncHookHandler {
  // Fail at startup, not on the first customer: no receiving wallet, or no CDP key for mainnet.
  getWalletAddress();
  getFacilitator(network);
  const admitPayer = createPayerSlots();

  return async (request, reply) => {
    const origin = `${request.protocol}://${request.host}`;
    // The client already knows its own URL, so the challenge may name it. What goes to the
    // facilitator (a third party) is the route pattern instead, so no phone number leaves here.
    const requirements = buildRequirements(amountUsdc, network, `${origin}${request.url}`);
    const facilitatorResource = `${origin}${request.routeOptions.url ?? '/'}`;

    const header = request.headers['x-payment'];
    if (typeof header !== 'string' || header === '') {
      request.log.info({ payment: 'missing' }, 'payment required');
      return paymentRequired(reply, 'X-PAYMENT header is required', requirements);
    }

    const result = await verifyPayment(header, amountUsdc, network, facilitatorResource, admitPayer);
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
      return paymentRequired(reply, result.reason, requirements);
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
    // Replace the dossier with the 402. The body is serialized by hand: onSend runs after Fastify's
    // own serialization, so it takes the final payload string.
    const { body, header } = challenge(settlement.reason, payment.requirements);
    reply.code(402).header('x-payment-requirements', header);
    return JSON.stringify(body);
  }
  reply.header('x-payment-response', settlement.header);
  request.log.info({ payment: 'settled' }, 'payment settled');
  return payload;
}
