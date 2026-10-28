import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // src/env.ts only reads process.env, so expose .env.local (gitignored) to the test workers.
    env: loadEnv(mode, process.cwd(), ''),
  },
}));
