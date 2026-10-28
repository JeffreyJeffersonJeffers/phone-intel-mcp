import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLookupTool, type LookupToolOptions } from './tools/lookupTool.js';

// One server per request: the HTTP route is stateless (no sessions), and a connected McpServer can
// only serve one transport at a time.
export function createMcpServer(options: LookupToolOptions): McpServer {
  const server = new McpServer({ name: 'phone-intel-mcp', version: '0.1.0' });
  registerLookupTool(server, options);
  return server;
}
