import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeDossier } from '../../src/dossier/compose.js';
import type { Dossier } from '../../src/dossier/types.js';
import { env } from '../../src/env.js';
import { buildServer } from '../../src/server.js';
import { buildTestPayment } from './buildTestPayment.js';

// Live-chain test: NOT run by default. It talks to the real x402.org facilitator and settles a
// real Base-Sepolia testnet USDC transfer (worthless, but the payer needs some: Circle's faucet at
// https://faucet.circle.com hands out testnet USDC). Run manually:
//
//   X402_LIVE=1 X402_TEST_PAYER_PRIVATE_KEY=0x<funded base-sepolia key> \
//     npx vitest run tests/e2e/payment-live.test.ts
//
// The receiver is the fixture WALLET_ADDRESS from vitest.config.ts, so the 0.03 testnet USDC goes
// to a throwaway address. The vendor layer stays mocked: this checks payment only.
vi.mock('../../src/dossier/compose.js', () => ({ composeDossier: vi.fn() }));

const PAYER_KEY = process.env.X402_TEST_PAYER_PRIVATE_KEY;

const DOSSIER = { phone: '+15165551234', meta: { schema_version: 'v1' } } as unknown as Dossier;

let server: ReturnType<typeof buildServer>;
afterEach(() => server.close());

describe.skipIf(process.env.X402_LIVE !== '1' || !PAYER_KEY)('x402 on Base-Sepolia (live facilitator)', () => {
  it('verifies and settles a real 0.03 USDC payment, then serves the dossier', async () => {
    server = buildServer();
    vi.mocked(composeDossier).mockResolvedValue(DOSSIER);
    const header = await buildTestPayment({
      amount: '0.03',
      network: 'base-sepolia',
      to: env.WALLET_ADDRESS!,
      payerPrivateKey: PAYER_KEY,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/lookup/%2B15165551234',
      headers: { 'x-payment': header },
    });

    expect(res.statusCode).toBe(200);
    const settlement = JSON.parse(Buffer.from(String(res.headers['x-payment-response']), 'base64').toString());
    expect(settlement).toMatchObject({ success: true, network: 'base-sepolia' });
    expect(settlement.transaction).toMatch(/^0x[0-9a-f]{64}$/i);
  }, 60_000);
});
