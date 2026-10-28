import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// src/env.ts reads process.env once at import, so each case stubs the environment and imports a
// fresh copy of the server. Nothing here makes a network call: building the gate only resolves
// the wallet address and the facilitator client.
async function build(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { buildServer } = await import('../../../src/server.js');
  return buildServer();
}

const WALLET = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  vi.stubEnv('WALLET_ADDRESS', WALLET);
  vi.stubEnv('CDP_API_KEY', '');
  vi.stubEnv('CDP_API_SECRET', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('payment startup checks', () => {
  it('refuses to start without WALLET_ADDRESS and points at scripts/create-wallet.ts', async () => {
    await expect(build({ WALLET_ADDRESS: '' })).rejects.toThrow(/WALLET_ADDRESS is not set.*scripts\/create-wallet\.ts/s);
  });

  it('refuses to start with a malformed WALLET_ADDRESS', async () => {
    await expect(build({ WALLET_ADDRESS: '0x1234' })).rejects.toThrow(/not a valid/);
  });

  it('starts on base-sepolia outside production without CDP credentials', async () => {
    const server = await build({ NODE_ENV: 'development' });
    await server.close();
  });

  it('refuses to start in production without CDP credentials (mainnet facilitator needs them)', async () => {
    await expect(build({ NODE_ENV: 'production' })).rejects.toThrow(/CDP_API_KEY and CDP_API_SECRET/);
  });

  it('starts in production once CDP credentials are set', async () => {
    const server = await build({ NODE_ENV: 'production', CDP_API_KEY: 'key-id', CDP_API_SECRET: 'key-secret' });
    await server.close();
  });
});
