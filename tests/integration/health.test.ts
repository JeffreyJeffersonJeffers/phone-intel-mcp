import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';

describe('GET /health', () => {
  it('GET /health returns 200 ok', async () => {
    const server = buildServer();
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });
});
