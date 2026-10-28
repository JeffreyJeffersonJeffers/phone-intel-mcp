import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { FastifyPluginAsync, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { createMcpServer } from '../mcp/mcpServer.js';
import { LOOKUP_TOOL_NAME } from '../mcp/tools/lookupTool.js';
import { settleOnSuccess, skipSettlement } from '../payment/x402Middleware.js';

export interface McpRouteOptions {
  requirePayment: preHandlerAsyncHookHandler;
  // Runs right after requirePayment. It meters only a verified payer, so it never touches the free
  // messages (initialize, tools/list) or a call the gate turned away.
  rateLimit: preHandlerAsyncHookHandler;
  priceUsdc: string;
}

// Every MCP message is a POST to the same URL, so the x402 gate cannot sit on the route like it
// does on /lookup: initialize and tools/list would each cost a payment. Only the call that runs a
// lookup is paid. Everything else cannot reach composeDossier, so it stays free.
//
// The same parsed body is checked here and handed to the transport, so the gate and the dispatcher
// can never see different messages.
function isLookupCall(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const { method, params } = body as { method?: unknown; params?: { name?: unknown } | null };
  return method === 'tools/call' && params?.name === LOOKUP_TOOL_NAME;
}

// An MCP tool error is HTTP 200 with isError set, which settleOnSuccess would charge for. GET
// /lookup never charges a failed lookup, so neither does this: only a JSON-RPC result that is not
// a tool error counts. This also covers the SDK rejecting the arguments before the tool runs.
function isSuccessfulToolResult(responseBody: string): boolean {
  try {
    const message = JSON.parse(responseBody) as { result?: { isError?: unknown } | null };
    return message.result != null && message.result.isError !== true;
  } catch {
    return false;
  }
}

// The transport only reads these. Building a Request from the rest (host, content-length, ...) buys
// nothing and can throw on odd values.
const FORWARDED_HEADERS = ['accept', 'content-type', 'mcp-protocol-version'] as const;

function toWebRequest(request: FastifyRequest): Request {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  // The body was already parsed by Fastify and goes to the transport as parsedBody; the URL is only
  // echoed back to tool handlers, which do not read it.
  return new Request('http://localhost/mcp', { method: 'POST', headers });
}

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

// Streamable HTTP in stateless JSON mode: a POST in, one JSON-RPC response out, no sessions and no
// SSE. That keeps the response a plain Fastify reply, so the x402 onSend hook can settle it. (The
// SDK's Node transport writes straight to the socket and would bypass onSend.) Logging: the route
// pattern only, and tool code logs phone_hash. The phone travels in the body, never the URL.
export const mcpRoute: FastifyPluginAsync<McpRouteOptions> = async (
  server,
  { requirePayment, rateLimit, priceUsdc },
) => {
  server.addHook('preHandler', async function (request, reply) {
    if (isLookupCall(request.body)) return requirePayment.call(this, request, reply);
  });
  server.addHook('preHandler', rateLimit);
  server.addHook('onSend', settleOnSuccess);

  server.post('/mcp', async (request, reply) => {
    // A batch could carry a lookup past the gate above, which only inspects a single message.
    // JSON-RPC batching was removed from the MCP spec in 2025-06-18.
    if (Array.isArray(request.body)) {
      return reply.code(400).send(jsonRpcError(-32600, 'Invalid Request: batch requests are not supported'));
    }

    const mcp = createMcpServer({ priceUsdc, log: request.log });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await mcp.connect(transport);
      const response = await transport.handleRequest(toWebRequest(request), { parsedBody: request.body });
      const body = await response.text();
      if (isLookupCall(request.body) && !isSuccessfulToolResult(body)) skipSettlement(request);
      return reply.code(response.status).headers(Object.fromEntries(response.headers)).send(body);
    } finally {
      await mcp.close();
    }
  });

  // The spec allows GET (an SSE stream for server-initiated messages) or 405. There is nothing to
  // push and no sessions to end, so say so.
  server.route({
    method: ['GET', 'DELETE'],
    url: '/mcp',
    handler: async (_request, reply) =>
      reply.code(405).header('allow', 'POST').send(jsonRpcError(-32000, 'Method not allowed.')),
  });
};
