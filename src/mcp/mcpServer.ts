import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListPromptsRequestSchema, ListResourcesRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerLookupTool, type LookupToolOptions } from './tools/lookupTool.js';

// One server per request: the HTTP route is stateless (no sessions), and a connected McpServer can
// only serve one transport at a time.
export function createMcpServer(options: LookupToolOptions): McpServer {
  const server = new McpServer({ name: 'phone-intel-mcp', version: '0.1.0' });
  registerLookupTool(server, options);
  // Smithery (and any other registry that scans an MCP's full surface) expects resources/list and
  // prompts/list to answer with empty lists, not "Method not found". We expose neither resource
  // nor prompt, so advertise both as empty capabilities and return [] to the probes.
  server.server.registerCapabilities({ resources: {}, prompts: {} });
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  return server;
}
