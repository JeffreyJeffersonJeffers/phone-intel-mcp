import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './env.js';
import { healthRoute } from './http/healthRoute.js';

export function buildServer(): FastifyInstance {
  const server = Fastify({
    logger: { level: env.NODE_ENV === 'test' ? 'silent' : 'info' },
  });
  server.register(healthRoute);
  return server;
}
