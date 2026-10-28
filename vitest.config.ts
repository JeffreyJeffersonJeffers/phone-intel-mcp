import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // src/env.ts only reads process.env, so expose .env.local (gitignored) to the test workers.
    // Only DATABASE_URL: vendor API keys must never reach tests, or a test that forgets to mock
    // fetch would hit live Twilio/Yelp/Google/IPQS and spend real money.
    env: loadEnv(mode, process.cwd(), 'DATABASE_URL'),
  },
}));
