import type { FastifyReply, FastifyRequest, onSendAsyncHookHandler, preHandlerAsyncHookHandler } from 'fastify';
import type { PaymentPayload, PaymentRequirements } from 'x402/types';
import {
  buildRequirements,
  getFacilitator,
  getWalletAddress,
  settlePayment,
  verifyPayment,
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

interface VerifiedPayment {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  network: PaymentNetwork;
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

    const result = await verifyPayment(header, amountUsdc, network, facilitatorResource);
    if (!result.ok) {
      // A bad payment and a broken facilitator look the same to the client (402) but not to us:
      // the second one needs someone to look at it. Status only, never the error itself.
      if (result.facilitatorError) request.log.error({ payment: 'facilitator_error' }, 'facilitator error');
      else request.log.info({ payment: 'rejected' }, 'payment rejected');
      return paymentRequired(reply, result.reason, requirements);
    }
    verified.set(request, { payload: result.payload, requirements: result.requirements, network });
    request.log.info({ payment: 'verified' }, 'payment verified');
  };
}

// For a handler that reports failure inside a 2xx, which settleOnSuccess cannot see (an MCP tool
// error is HTTP 200 with isError set). Drops the verified payment so it is not settled. The nonce
// stays claimed, as for any failed call: the client simply signs a new payment.
export function skipSettlement(request: FastifyRequest): void {
  if (!verified.delete(request)) return;
  request.log.info({ payment: 'not_charged' }, 'payment not settled: request failed');
}

export const settleOnSuccess: onSendAsyncHookHandler = async (request, reply, payload) => {
  const payment = verified.get(request);
  if (!payment) return payload; // unpaid or rejected: the 402 was already sent by the preHandler
  verified.delete(request);

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
};
