import { readFileSync } from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import { getSnapshot } from '../stats/counters.js';

// Package version is read once at load time; same approach as healthRoute.
const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

// Service-wide stats. Free, unauthenticated, no rate limit (same tier as /health and /openapi.json).
// Discloses only aggregate counts and percentiles — no per-caller data, no per-number data.
export const statsRoute: FastifyPluginAsync = async (server) => {
  server.get('/stats', async () => getSnapshot(version));
};
