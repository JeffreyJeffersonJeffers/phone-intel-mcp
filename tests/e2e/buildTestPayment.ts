import { randomBytes } from 'node:crypto';
import { createPaymentHeader } from 'x402/client';
import { createSigner, type PaymentRequirements } from 'x402/types';

// Independent of src/payment on purpose: if the server built its requirements wrongly, a test
// payment built from these constants would stop matching and the suite would catch it.
const USDC = {
  'base-sepolia': { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC' },
  base: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin' },
} as const;

export type TestNetwork = keyof typeof USDC;

export const usdcAddress = (network: TestNetwork) => USDC[network].address;

// "0.03" -> "30000" (USDC has 6 decimals)
export const toAtomicUsdc = (amount: string) => String(Math.round(Number(amount) * 1e6));

// Rewrites fields of the authorization inside an X-PAYMENT header. The signature is NOT redone, so
// the result is only good for checks that run before the facilitator, or for edits that keep the
// signed bytes the same (e.g. the case of the nonce's hex digits).
export function mutateAuthorization(header: string, mutate: (authorization: Record<string, string>) => void): string {
  const payment = JSON.parse(Buffer.from(header, 'base64').toString());
  mutate(payment.payload.authorization);
  return Buffer.from(JSON.stringify(payment)).toString('base64');
}

export interface TestPaymentOptions {
  amount: string;
  network: TestNetwork;
  to: string;
  // Defaults to a fresh random key, i.e. a fresh payer and nonce per payment. Signing is offline
  // (EIP-712 typed data): no RPC call and no funds are needed unless a facilitator settles it.
  payerPrivateKey?: string;
}

// An x402 `X-PAYMENT` header value: a real signed EIP-3009 transferWithAuthorization, base64-encoded.
export async function buildTestPayment({ amount, network, to, payerPrivateKey }: TestPaymentOptions): Promise<string> {
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network,
    maxAmountRequired: toAtomicUsdc(amount),
    resource: 'http://localhost/lookup/:phone',
    description: 'test payment',
    mimeType: 'application/json',
    payTo: to,
    maxTimeoutSeconds: 60,
    asset: USDC[network].address,
    extra: { name: USDC[network].name, version: '2' },
  };
  const signer = await createSigner(network, payerPrivateKey ?? `0x${randomBytes(32).toString('hex')}`);
  return createPaymentHeader(signer, 1, requirements);
}
