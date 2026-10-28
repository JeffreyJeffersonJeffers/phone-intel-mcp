import type { FastifyRequest } from 'fastify';

// The paying wallet of a request whose payment has been verified, set by the x402 gate and read by
// whatever runs after it (the rate limiter). Absent for unpaid requests and for any request the gate
// rejected, so "no payer" means "nothing to meter". Lowercased: an address is one wallet in any case.
const payers = new WeakMap<FastifyRequest, string>();

export function setPayer(request: FastifyRequest, address: string): void {
  payers.set(request, address.toLowerCase());
}

export function payerOf(request: FastifyRequest): string | undefined {
  return payers.get(request);
}
