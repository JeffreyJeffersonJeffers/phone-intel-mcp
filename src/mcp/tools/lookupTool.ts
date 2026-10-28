import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { composeDossier } from '../../dossier/compose.js';
import type { Dossier } from '../../dossier/types.js';
import { safeErrorMessage } from '../../lib/logSafe.js';
import { normalizePhone } from '../../lib/phone.js';
import { hashPhone } from '../../lib/phoneHash.js';
import { lookupLogFields } from '../../middleware/requestLog.js';

export const LOOKUP_TOOL_NAME = 'phone_intel.lookup';

const rating = z.object({ stars: z.number(), count: z.number() });

// The tool's published output schema. `satisfies` makes this fail to compile if it drifts from the
// Dossier type, so an agent is never promised a shape compose does not return.
const dossierSchema = z.object({
  phone: z.string(),
  number_classification: z.enum(['business', 'consumer_mobile', 'consumer_landline', 'voip', 'toll_free', 'unknown']),
  carrier: z.object({
    name: z.string().nullable(),
    type: z.enum(['mobile', 'landline', 'voip', 'tollFree', 'unknown']),
  }),
  caller_name: z.string().nullable(),
  business_match: z
    .object({
      name: z.string(),
      category: z.string(),
      address: z.object({ line1: z.string(), city: z.string(), state: z.string(), postal: z.string() }),
      hours: z.record(z.array(z.object({ open: z.string(), close: z.string() }))).nullable(),
      is_open_now: z.boolean().nullable(),
      rating: rating.nullable(),
      place_id: z.string().nullable(),
      yelp_id: z.string(),
    })
    .nullable(),
  reputation: z.object({
    spam_risk_score: z.number(),
    is_known_robocall: z.boolean(),
    is_dnc_listed: z.boolean().nullable(),
    is_voip_risk: z.boolean(),
  }),
  meta: z.object({
    lookup_id: z.string(),
    schema_version: z.literal('v1'),
    cached_fields: z.array(z.string()),
    timestamp: z.string(),
  }),
}) satisfies z.ZodType<Dossier>;

// A tool error is a normal result with isError set, so one bad lookup does not break the MCP
// session. The text is only ever one of our codes, never an upstream message.
const toolError = (code: 'invalid_phone' | 'not_us_number' | 'vendor_failure' | 'internal_error'): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: code }],
});

export interface LookupToolOptions {
  priceUsdc: string;
  // Request-scoped: it carries the request id (and the paying wallet), and adapter details go here
  // instead of to the client.
  log: FastifyBaseLogger;
  // Milliseconds since the HTTP request arrived, for the log line's latency_ms.
  latencyMs: () => number;
}

// Same order as GET /lookup/:phone: validate first (a rejected number makes no vendor call), then
// compose. Same log line too (lookupLogFields): phone_hash, never the phone, and error text only
// through safeErrorMessage.
export function registerLookupTool(server: McpServer, { priceUsdc, log, latencyMs }: LookupToolOptions): void {
  server.registerTool(
    LOOKUP_TOOL_NAME,
    {
      description:
        'Return a composite dossier (carrier, business, hours, reputation) for a US phone number. ' +
        `Charges $${priceUsdc} USDC via x402.`,
      inputSchema: { phone: z.string().describe('US phone number, ideally E.164 (+15165551234)') },
      outputSchema: dossierSchema,
    },
    async ({ phone }): Promise<CallToolResult> => {
      const normalized = normalizePhone(phone);
      if ('error' in normalized) {
        log.info(
          {
            ...lookupLogFields({ status: 400, latencyMs: latencyMs(), phoneHash: null, cacheHits: [] }),
            error_code: normalized.error,
          },
          'mcp lookup rejected',
        );
        return toolError(normalized.error);
      }

      const phoneHash = hashPhone(normalized.e164);
      try {
        const dossier = await composeDossier(normalized.e164);
        log.info(
          {
            ...lookupLogFields({
              status: 200,
              latencyMs: latencyMs(),
              phoneHash,
              cacheHits: dossier.meta.cached_fields,
            }),
            lookup_id: dossier.meta.lookup_id,
          },
          'mcp lookup completed',
        );
        return { content: [{ type: 'text', text: JSON.stringify(dossier) }], structuredContent: { ...dossier } };
      } catch (err) {
        if (err instanceof AggregateError) {
          log.error(
            {
              ...lookupLogFields({ status: 502, latencyMs: latencyMs(), phoneHash, cacheHits: [] }),
              adapter_errors: err.errors.map(safeErrorMessage),
            },
            'mcp lookup failed: vendor failure',
          );
          return toolError('vendor_failure');
        }
        log.error(
          {
            ...lookupLogFields({ status: 500, latencyMs: latencyMs(), phoneHash, cacheHits: [] }),
            error_message: safeErrorMessage(err),
          },
          'mcp lookup failed: unexpected error',
        );
        return toolError('internal_error');
      }
    },
  );
}
