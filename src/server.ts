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
import { redact, safeErrorMessage } from './lib/logSafe.js';
import { createWalletRateLimiter, walletRateLimit } from './middleware/rateLimit.js';
import { requirePayment, settleOnSuccess } from './payment/x402Middleware.js';

const PRICE_USDC = '0.03';

export interface ServerOptions {
  // Send server logs here (at info level) instead of stdout, so tests can inspect them.
  logStream?: Writable;
}

// Fastify's own log lines are the part of the request log we don't write. Three of its defaults are
// unsafe here: the 404 line echoes the whole request path, which can carry a phone number, and the
// error lines write the whole error object (stack, and for some errors the path or a snippet of the
// body) plus its message. So those say the status, the error code and a redacted message instead.
class PhoneSafeLogController extends LogController {
  constructor() {
    // Logs say request_id, not Fastify's default reqId. (Set here: the top-level option is deprecated.)
    super({ requestIdLogLabel: 'request_id' });
  }

  override routeNotFound(request: FastifyRequest): void {
    if (this.isLogDisabled(request)) return;
    request.log.info('route not found');
  }

  override defaultErrorLog(error: Error, request: FastifyRequest, reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    const fields = {
      status: reply.statusCode,
      error_code: (error as FastifyError).code,
      error_message: safeErrorMessage(error),
    };
    // request.log, not reply.log: it is the one that knows the paying wallet.
    if (reply.statusCode >= 500) request.log.error(fields, 'request error');
    else request.log.info(fields, 'request error');
  }

  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
    metadata?: Record<string, unknown>,
  ): void {
    if (!error) return super.requestCompleted(error, request, reply, metadata);
    if (this.isLogDisabled(request)) return;
    request.log.error(
      { status: reply.statusCode, error_message: safeErrorMessage(error), response_time_ms: Math.round(reply.elapsedTime) },
      'request errored',
    );
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
        // Every `{ err }` the logger is handed, wherever it comes from, is logged as its message
        // only (redacted), never the stack. This is the net under the Fastify paths that bypass the
        // LogController overrides above: a failed writeHead, a serializer or stream error, and a
        // double send (FST_ERR_REP_ALREADY_SENT puts the request URL, i.e. the phone, in its message).
        // (Cast: Fastify types this serializer as returning a stack; leaving it out is the point.)
        err: ((err: unknown) => ({
          type: (err as Error)?.constructor?.name ?? typeof err,
          message: safeErrorMessage(err),
        })) as unknown as (err: FastifyError) => { type: string; message: string; stack: string },
      },
      hooks: {
        // The serializer above is not enough on its own: when `{ err }` is logged with no message,
        // pino uses the raw err.message as the log message before any serializer runs, and a few
        // Fastify warnings are plain strings with the URL in them. So string messages are redacted,
        // and a missing message is filled in from the redacted error.
        logMethod(args, method) {
          const [first, second] = args as [unknown, unknown, ...unknown[]];
          if (typeof first === 'string') args[0] = redact(first);
          else if (typeof second === 'string') args[1] = redact(second);
          else if (typeof first === 'object' && first !== null && 'err' in first) args[1] = safeErrorMessage(first.err);
          method.apply(this, args);
        },
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
  // One allowance per wallet across both paid paths. It must run after requireUsdc, which is what
  // identifies the wallet; requests that never reach a verified payment are not metered.
  const limitWallet = walletRateLimit(createWalletRateLimiter());

  server.register(healthRoute);
  // Hooks added in this encapsulated context cover every route registered in it, including the
  // HEAD route Fastify auto-creates for GET /lookup/:phone, so HEAD can't run vendors unpaid.
  // /health is registered outside it and stays free.
  server.register(async (paid) => {
    paid.addHook('preHandler', requireUsdc);
    paid.addHook('preHandler', limitWallet);
    paid.addHook('onSend', settleOnSuccess);
    paid.register(lookupRoute);
  });
  // Its own context: the gate here is per MCP message, not per route (see mcpRoute).
  server.register(mcpRoute, { requirePayment: requireUsdc, rateLimit: limitWallet, priceUsdc: PRICE_USDC });
  return server;
}
