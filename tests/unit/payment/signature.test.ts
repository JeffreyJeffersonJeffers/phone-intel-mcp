import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestPayment, mutateAuthorization } from '../../e2e/buildTestPayment.js';

// The local payer-signature check builds its EIP-712 domain (token name and version, chain id,
// token address) from our own requirements. The e2e tests run on base-sepolia; production is `base`,
// whose domain differs ("USD Coin", chain 8453), and no other test signs for it. buildTestPayment
// carries independent mainnet constants, so a wrong domain here makes this fail.
const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn() }));
vi.mock('x402/verify', () => ({ useFacilitator: () => facilitator }));

const WALLET = '0x1111111111111111111111111111111111111111';
const newKey = () => `0x${randomBytes(32).toString('hex')}`;
const fromOf = (header: string): string => JSON.parse(Buffer.from(header, 'base64').toString()).payload.authorization.from;
const admit = () => () => {};

// getFacilitator('base') needs a CDP key to build; nothing here calls the network (it is mocked).
async function loadWallet() {
  vi.resetModules();
  vi.stubEnv('WALLET_ADDRESS', WALLET);
  vi.stubEnv('CDP_API_KEY', 'key-id');
  vi.stubEnv('CDP_API_SECRET', 'key-secret');
  facilitator.verify.mockReset();
  facilitator.verify.mockResolvedValue({ isValid: true });
  return import('../../../src/payment/wallet.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('payer signature check on Base mainnet', () => {
  it('accepts a payment signed by the payer it names', async () => {
    const { verifyPayment } = await loadWallet();
    const header = await buildTestPayment({ amount: '0.03', network: 'base', to: WALLET, payerPrivateKey: newKey() });

    const result = await verifyPayment(header, '0.03', 'base', 'https://example.test/lookup/:phone', admit);

    expect(result).toMatchObject({ ok: true });
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
  });

  it('rejects a payment that names a payer who did not sign it', async () => {
    const { verifyPayment } = await loadWallet();
    const victim = fromOf(await buildTestPayment({ amount: '0.03', network: 'base', to: WALLET, payerPrivateKey: newKey() }));
    const forged = mutateAuthorization(
      await buildTestPayment({ amount: '0.03', network: 'base', to: WALLET, payerPrivateKey: newKey() }),
      (auth) => {
        auth.from = victim;
      },
    );

    const result = await verifyPayment(forged, '0.03', 'base', 'https://example.test/lookup/:phone', admit);

    expect(result).toMatchObject({ ok: false, reason: 'invalid_exact_evm_payload_signature' });
    expect(facilitator.verify).not.toHaveBeenCalled();
  });
});
