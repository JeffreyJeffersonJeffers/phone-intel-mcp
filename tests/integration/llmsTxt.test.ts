import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';

describe('GET /llms.txt', () => {
  it('serves a text/plain markdown summary naming the service and key endpoints', async () => {
    const server = buildServer();
    const res = await server.inject({ method: 'GET', url: '/llms.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toMatch(/^# Phone Intel MCP/);
    expect(res.body).toContain('/lookup/');
    expect(res.body).toContain('/mcp');
    expect(res.body).toContain('/openapi.json');
    expect(res.body).toContain('x402');
    await server.close();
  });

  it('is not gated by the x402 payment middleware', async () => {
    const server = buildServer();
    const res = await server.inject({ method: 'GET', url: '/llms.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.headers).not.toHaveProperty('payment-required');
    await server.close();
  });
});
