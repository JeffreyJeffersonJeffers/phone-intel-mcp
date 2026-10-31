import type { FastifyPluginAsync } from 'fastify';
import { env } from '../env.js';

// A minimal, hand-crafted OpenAPI 3.1 document for discovery indices like x402scan that prefer
// an OpenAPI spec over the 402 header alone. The `x-payment-info` extension on /lookup/{phone}
// mirrors what the x402 PaymentRequired header advertises; the receiving wallet is read from the
// same WALLET_ADDRESS env the gate uses, so a redeploy with a new wallet cannot drift this
// document away from reality.
const PRICE_USDC = '0.03';
const PRICE_ATOMIC = String(Math.round(Number(PRICE_USDC) * 1_000_000));
const USDC_ADDRESS = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
} as const;

function buildOpenapi(host: string, protocol: string) {
  const network = env.NODE_ENV === 'production' ? 'base' : 'base-sepolia';
  const caip2 = network === 'base' ? 'eip155:8453' : 'eip155:84532';
  return {
    openapi: '3.1.0',
    info: {
      title: 'Phone Intel MCP',
      version: '1.0.0',
      description:
        'US phone number intelligence (carrier, business match, spam risk, number classification) returned as a single dossier. One lookup = 0.03 USDC on Base, settled on-chain via x402.',
      contact: { name: 'Phone Intel MCP', url: 'https://phone-intel-mcp.fly.dev' },
      license: { name: 'MIT' },
    },
    servers: [{ url: `${protocol}://${host}`, description: 'Production' }],
    paths: {
      '/lookup/{phone}': {
        get: {
          summary: 'Look up a US phone number',
          description:
            'Pay 0.03 USDC on Base and receive a composite dossier for one US phone number. The server advertises its payment requirements in the `payment-required` response header on 402.',
          operationId: 'lookupPhone',
          parameters: [
            {
              name: 'phone',
              in: 'path',
              required: true,
              description: 'US phone number, URL-encoded E.164 (e.g. `%2B15165551234`).',
              schema: { type: 'string', pattern: '^(\\+1|%2B1)\\d{10}$' },
            },
          ],
          responses: {
            '200': { description: 'Phone dossier', content: { 'application/json': { schema: { $ref: '#/components/schemas/Dossier' } } } },
            '400': { description: 'Phone number malformed or not a US number', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '402': { description: 'Payment required. The `payment-required` header carries the base64-encoded x402 PaymentRequired object.' },
            '429': { description: 'Another request from this wallet is in flight, or the wallet has exceeded its allowance.' },
            '502': { description: 'A vendor service failed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
          'x-payment-info': {
            protocol: 'x402',
            version: 2,
            scheme: 'exact',
            network: caip2,
            amount: PRICE_ATOMIC,
            price: `$${PRICE_USDC}`,
            asset: USDC_ADDRESS[network],
            assetSymbol: 'USDC',
            payTo: env.WALLET_ADDRESS,
            maxTimeoutSeconds: 60,
          },
        },
      },
      '/mcp': {
        post: {
          summary: 'MCP (Streamable HTTP) endpoint for the phone_intel.lookup tool',
          description: 'JSON-RPC 2.0 single-message POSTs. Pay only when calling `tools/call` for `phone_intel.lookup`; `initialize` and `tools/list` are free.',
          operationId: 'mcp',
          responses: {
            '200': { description: 'JSON-RPC response (either a tool result or an error inside a 200 body).' },
            '402': { description: 'Payment required for a `tools/call phone_intel.lookup`.' },
            '400': { description: 'Malformed JSON-RPC request.' },
          },
        },
      },
      '/health': {
        get: {
          summary: 'Health check',
          operationId: 'health',
          responses: { '200': { description: 'Server is up.' } },
        },
      },
    },
    components: {
      schemas: {
        Dossier: {
          type: 'object',
          required: ['phone', 'number_classification', 'carrier', 'reputation', 'meta'],
          properties: {
            phone: { type: 'string', example: '+15165551234' },
            number_classification: { type: 'string', enum: ['business', 'residential', 'mobile', 'unknown'] },
            carrier: {
              type: 'object',
              properties: {
                name: { type: ['string', 'null'] },
                type: { type: 'string', enum: ['landline', 'mobile', 'voip', 'unknown'] },
              },
            },
            caller_name: { type: ['string', 'null'] },
            business_match: { type: ['object', 'null'] },
            reputation: {
              type: 'object',
              properties: {
                spam_risk_score: { type: 'number' },
                is_known_robocall: { type: 'boolean' },
                is_dnc_listed: { type: ['boolean', 'null'] },
                is_voip_risk: { type: 'boolean' },
              },
            },
            meta: {
              type: 'object',
              properties: {
                lookup_id: { type: 'string' },
                schema_version: { type: 'string' },
                cached_fields: { type: 'array', items: { type: 'string' } },
                timestamp: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}

export const openapiRoute: FastifyPluginAsync = async (server) => {
  server.get('/openapi.json', async (request, reply) => {
    const host = request.host;
    const protocol = request.protocol;
    return reply
      .header('cache-control', 'public, max-age=60')
      .send(buildOpenapi(host, protocol));
  });
};
