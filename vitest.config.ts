import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // src/env.ts only reads process.env, so expose .env.local (gitignored) to the test workers.
    // Only DATABASE_URL: vendor API keys must never reach tests, or a test that forgets to mock
    // fetch would hit live Twilio/Yelp/Google/IPQS and spend real money.
    // WALLET_ADDRESS is a fixed public fixture, never the real receiving wallet: buildServer() needs
    // one to build the x402 gate, and tests must not depend on (or ever pay out to) Jeff's address.
    // LOG_PHONE_HMAC_KEY is likewise a fixed fixture (never the real key), so phone_hash values are
    // reproducible in tests; tests/unit/phoneHash.test.ts has known-answer vectors for it.
    env: {
      ...loadEnv(mode, process.cwd(), 'DATABASE_URL'),
      WALLET_ADDRESS: '0x1111111111111111111111111111111111111111',
      LOG_PHONE_HMAC_KEY: 'test-only-phone-hmac-key-0123456789abcdef',
    },
  },
}));
