import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';

// /openapi.json is served unprotected so discovery indices (x402scan) can read it.
describe('GET /openapi.json', () => {
  it('serves a 3.1 document naming the paid route and its payment info', async () => {
    const server = buildServer();

    const res = await server.inject({ method: 'GET', url: '/openapi.json' });

    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.info.title).toBe('Phone Intel MCP');
    expect(doc.paths['/lookup/{phone}'].get).toBeDefined();
    expect(doc.paths['/lookup/{phone}'].get['x-payment-info']).toMatchObject({
      protocol: 'x402',
      version: 2,
      scheme: 'exact',
      network: 'eip155:84532', // NODE_ENV=test → base-sepolia (CAIP-2)
      amount: '30000', // 0.03 USDC
      assetSymbol: 'USDC',
    });
    expect(doc.paths['/mcp'].post).toBeDefined();
    expect(doc.paths['/health'].get).toBeDefined();
    await server.close();
  });

  it('is not gated by the x402 payment middleware', async () => {
    const server = buildServer();
    const res = await server.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers).not.toHaveProperty('payment-required');
    await server.close();
  });
});
