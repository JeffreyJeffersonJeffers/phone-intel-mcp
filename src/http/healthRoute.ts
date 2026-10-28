import { readFileSync } from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';

// Resolves to the repo root from both src/http (dev/test) and dist/http (built).
const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

export const healthRoute: FastifyPluginAsync = async (server) => {
  server.get('/health', async () => ({ status: 'ok', version }));
};
