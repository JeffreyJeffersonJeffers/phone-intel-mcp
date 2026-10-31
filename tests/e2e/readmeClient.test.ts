import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomBytes } from 'node:crypto';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeDossier } from '../../src/dossier/compose.js';
import type { Dossier } from '../../src/dossier/types.js';
import { buildServer } from '../../src/server.js';

// The client code in README.md ("From an MCP client"), run against the real server so the
// documented example cannot rot. Only the network differs: the README pays on `base` (mainnet),
// this test server is on `base-sepolia`. If you change the snippet, change it in both places.
const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn(), getSupported: vi.fn() }));
vi.mock('@x402/core/http', async () => {
  const actual = await vi.importActual<typeof import('@x402/core/http')>('@x402/core/http');
  return { ...actual, HTTPFacilitatorClient: vi.fn().mockImplementation(() => facilitator) };
});

vi.mock('../../src/dossier/compose.js', () => ({ composeDossier: vi.fn() }));
const compose = vi.mocked(composeDossier);

const PAYER = '0x2222222222222222222222222222222222222222';
const DOSSIER: Dossier = {
  phone: '+15165551234',
  number_classification: 'business',
  carrier: { name: 'Verizon', type: 'landline' },
  caller_name: null,
  business_match: null,
  reputation: { spam_risk_score: 0, is_known_robocall: false, is_dnc_listed: null, is_voip_risk: false },
  meta: { lookup_id: 'id', schema_version: 'v1', cached_fields: [], timestamp: '2026-10-28T12:00:00.000Z' },
};

let server: ReturnType<typeof buildServer>;
let client: Client | undefined;
beforeEach(() => {
  compose.mockReset();
  compose.mockResolvedValue(DOSSIER);
  facilitator.verify.mockReset();
  facilitator.verify.mockResolvedValue({ isValid: true, payer: PAYER });
  facilitator.settle.mockReset();
  facilitator.settle.mockResolvedValue({
    success: true,
    transaction: `0x${'ab'.repeat(32)}`,
    network: 'eip155:84532',
    payer: PAYER,
  });
});
afterEach(async () => {
  await client?.close();
  await server.close();
});

describe('README: calling phone_intel.lookup from an MCP client', () => {
  it('pays the 402 challenge and returns the dossier', async () => {
    server = buildServer();
    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address();
    if (address === null || typeof address === 'string') throw new Error('not listening');
    const url = `http://127.0.0.1:${address.port}/mcp`;

    // ---- begin README snippet ----
    const signer = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
    const scheme = new ExactEvmScheme(signer);

    // x402 v2 over fetch: when the server answers 402, decode the challenge from the
    // `payment-required` response header, sign the first `accepts` entry, and send the request
    // again with the payment attached. Anything that is not a 402 (initialize, tools/list) passes
    // through. The modern header name is PAYMENT-SIGNATURE; X-PAYMENT is a compatibility alias.
    const payingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (response.status !== 402) return response;
      const required = decodePaymentRequiredHeader(response.headers.get('payment-required')!);
      const requirements = required.accepts[0]!;
      const result = await scheme.createPaymentPayload(required.x402Version, requirements);
      const payment = encodePaymentSignatureHeader({ ...result, accepted: requirements });
      return fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), 'PAYMENT-SIGNATURE': payment },
      });
    };

    client = new Client({ name: 'my-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: payingFetch }));
    const result = await client.callTool({ name: 'phone_intel.lookup', arguments: { phone: '+15165551234' } });
    // ---- end README snippet ----

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(DOSSIER);
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });
});
