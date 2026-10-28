import type { Writable } from 'node:stream';
import Fastify, {
  LogController,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { env } from './env.js';
import { healthRoute } from './http/healthRoute.js';
import { lookupRoute, REJECTION_MESSAGES } from './http/lookupRoute.js';
import { mcpRoute } from './http/mcpRoute.js';
import { requirePayment, settleOnSuccess } from './payment/x402Middleware.js';

const PRICE_USDC = '0.03';

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
    // Fly terminates TLS in its proxy, so the app only sees http. Trusting X-Forwarded-Proto/Host
    // makes request.protocol say https, and the x402 challenge's `resource` URL with it.
    trustProxy: true,
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
    // Fastify's router rejects some /lookup/:phone values before the handler runs: undecodable
    // percent-encoding (400) and a param over maxParamLength (414). Both are malformed input, so
    // they get the same invalid_phone body as the handler's. Never log err or err.message here:
    // Fastify puts the request path, i.e. the raw phone, in them.
    frameworkErrors: (err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
      if (err.code !== 'FST_ERR_BAD_URL' && err.code !== 'FST_ERR_MAX_PARAM_LENGTH') return reply.send(err);
      req.log.warn({ error_code: 'invalid_phone', framework_code: err.code }, 'framework error mapped to invalid_phone');
      return reply.code(400).send({ error: { code: 'invalid_phone', message: REJECTION_MESSAGES.invalid_phone } });
    },
  });
  // Built here, not inside the plugin below, so a missing WALLET_ADDRESS (or mainnet CDP key)
  // throws from buildServer() at startup instead of surfacing later during plugin loading.
  const requireUsdc = requirePayment(PRICE_USDC, env.NODE_ENV === 'production' ? 'base' : 'base-sepolia');

  server.register(healthRoute);
  // Hooks added in this encapsulated context cover every route registered in it, including the
  // HEAD route Fastify auto-creates for GET /lookup/:phone, so HEAD can't run vendors unpaid.
  // /health is registered outside it and stays free.
  server.register(async (paid) => {
    paid.addHook('preHandler', requireUsdc);
    paid.addHook('onSend', settleOnSuccess);
    paid.register(lookupRoute);
  });
  // Its own context: the gate here is per MCP message, not per route (see mcpRoute).
  server.register(mcpRoute, { requirePayment: requireUsdc, priceUsdc: PRICE_USDC });
  return server;
}
