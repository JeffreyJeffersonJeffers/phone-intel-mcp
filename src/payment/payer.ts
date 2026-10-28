import type { FastifyRequest } from 'fastify';

// The paying wallet of a request whose payment has been verified, set by the x402 gate and read by
// whatever runs after it (the rate limiter). Absent for unpaid requests and for any request the gate
// rejected, so "no payer" means "nothing to meter". Lowercased: an address is one wallet in any case.
const payers = new WeakMap<FastifyRequest, string>();

export function setPayer(request: FastifyRequest, address: string): void {
  const wallet = address.toLowerCase();
  payers.set(request, wallet);
  // From here on every line the request logs says who is paying, by the last 6 characters only:
  // enough to tell wallets apart in the logs, not an address anyone could look up or paste.
  request.log = request.log.child({ wallet_address_last6: wallet.slice(-6) });
}

export function payerOf(request: FastifyRequest): string | undefined {
  return payers.get(request);
}
