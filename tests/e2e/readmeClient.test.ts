import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomBytes } from 'node:crypto';
import { createPaymentHeader, selectPaymentRequirements } from 'x402/client';
import { createSigner, PaymentRequirementsSchema } from 'x402/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeDossier } from '../../src/dossier/compose.js';
import type { Dossier } from '../../src/dossier/types.js';
import { buildServer } from '../../src/server.js';

// The client code in README.md ("From an MCP client"), run against the real server so the
// documented example cannot rot. Only the network differs: the README pays on `base`, this test
// server is on `base-sepolia`. If you change the snippet, change it in both places.
const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn() }));
vi.mock('x402/verify', () => ({ useFacilitator: () => facilitator }));

vi.mock('../../src/dossier/compose.js', () => ({ composeDossier: vi.fn() }));
const compose = vi.mocked(composeDossier);

const NETWORK = 'base-sepolia';
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
  facilitator.settle.mockResolvedValue({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: NETWORK, payer: PAYER });
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
    const signer = await createSigner(NETWORK, `0x${randomBytes(32).toString('hex')}`);

    // x402 over fetch: when the server answers 402, sign its challenge and send the request again
    // with the payment attached. Anything that is not a 402 (initialize, tools/list) passes through.
    const payingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (response.status !== 402) return response;
      const { x402Version, accepts } = await response.json();
      const requirements = selectPaymentRequirements(
        accepts.map((r: unknown) => PaymentRequirementsSchema.parse(r)),
        NETWORK,
        'exact',
      );
      const payment = await createPaymentHeader(signer, x402Version, requirements);
      return fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), 'X-PAYMENT': payment } });
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
