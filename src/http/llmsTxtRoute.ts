import type { FastifyPluginAsync } from 'fastify';

// Static /llms.txt at the service root — convention from llmstxt.org that several x402 ecosystem
// services (Kaisha, Rug Munch, Octodamus, Agent402) ship so AI agent discovery crawlers can grab a
// concise, high-signal description without parsing HTML. Served as text/plain (markdown by content).
//
// Keep this terse and factual. Update whenever /lookup, /stats, pricing, or the payment-protocol
// shape changes — most of what's here is also in README.md and /openapi.json.
const LLMS_TXT = `# Phone Intel MCP

> Composite US phone-number dossier for AI voice agents in one HTTP call. Carrier + line type, reverse-phone business match (name, category, address, hours, is-open-now, rating), caller name, spam/robocall reputation score, consumer-cell vs business classification. $0.03 USDC on Base mainnet via x402. No API keys, no signup.

## Endpoints

- [GET /lookup/{phone}](https://phone-intel-mcp.fly.dev/lookup/%2B15165551234): paid US phone lookup. Returns the dossier as JSON. $0.03 USDC via x402.
- [POST /mcp](https://phone-intel-mcp.fly.dev/mcp): Streamable HTTP MCP endpoint, tool name \`phone_intel.lookup\`.
- [GET /openapi.json](https://phone-intel-mcp.fly.dev/openapi.json): OpenAPI 3.1 document with \`x-payment-info\` for x402 discovery indexes.
- [GET /stats](https://phone-intel-mcp.fly.dev/stats): aggregate service counters (cache hit rate, p50/p95 latency, uptime).
- [GET /health](https://phone-intel-mcp.fly.dev/health): liveness check.

## Payment

x402 v2, \`exact\` scheme on Base mainnet (CAIP-2 \`eip155:8453\`). An unpaid request returns 402 with a \`payment-required\` response header (base64 JSON) and a JSON body with the same terms. Sign an EIP-3009 \`transferWithAuthorization\` for those terms and resend with the signed payload in the \`PAYMENT-SIGNATURE\` request header. v1 clients using \`X-PAYMENT\` are also accepted. Settlement lands in the \`payment-response\` response header (base64 JSON with the tx hash) on a 200.

## Compliance

US business numbers and public-record data only. No consumer-cell reverse-identity. Respects the stricter state privacy laws (CA, IL, FL, PA, VT). Consumer-mobile responses carry carrier + reputation + classification, never a name match.

## Source and docs

- Source: https://github.com/JeffreyJeffersonJeffers/phone-intel-mcp
- README: https://github.com/JeffreyJeffersonJeffers/phone-intel-mcp/blob/build/v1/README.md
- Listed on: PayAPI Market, mcp.so, x402scan.
`;

export const llmsTxtRoute: FastifyPluginAsync = async (server) => {
  server.get('/llms.txt', async (_request, reply) => {
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .send(LLMS_TXT);
  });
};
