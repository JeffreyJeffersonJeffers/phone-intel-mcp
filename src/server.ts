import type { Writable } from 'node:stream';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import { env } from './env.js';
import { healthRoute } from './http/healthRoute.js';
import { lookupRoute } from './http/lookupRoute.js';

export interface ServerOptions {
  // Send server logs here (at info level) instead of stdout, so tests can inspect them.
  logStream?: Writable;
}

// Fastify's default 404 line echoes the whole request path, which can carry a phone number.
class PhoneSafeLogController extends LogController {
  override routeNotFound(request: FastifyRequest): void {
    if (this.isLogDisabled(request)) return;
    request.log.info('route not found');
  }
}

export function buildServer({ logStream }: ServerOptions = {}): FastifyInstance {
  const server = Fastify({
    logger: {
      level: logStream || env.NODE_ENV !== 'test' ? 'info' : 'silent',
      stream: logStream,
      serializers: {
        // Fastify's default logs request.url, which for /lookup/:phone is the raw phone. Log the
        // matched route pattern instead; an unmatched (404) path is dropped for the same reason.
        // Fastify's accept-version field is omitted: this API has no versioned routes.
        req: (req) => ({
          method: req.method,
          url: req.routeOptions.url ?? '(unmatched)',
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        }),
      },
    },
    logController: new PhoneSafeLogController(),
  });
  server.register(healthRoute);
  server.register(lookupRoute);
  return server;
}
