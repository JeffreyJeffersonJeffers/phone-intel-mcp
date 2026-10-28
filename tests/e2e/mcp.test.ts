import { Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeDossier } from '../../src/dossier/compose.js';
import type { Dossier } from '../../src/dossier/types.js';
import { env } from '../../src/env.js';
import { buildServer } from '../../src/server.js';
import { buildTestPayment } from './buildTestPayment.js';

// Same split as payment.test.ts: the facilitator is the only stubbed payment dependency, so the
// real x402 gate runs on /mcp. compose is the whole vendor layer.
const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn() }));
vi.mock('x402/verify', () => ({ useFacilitator: () => facilitator }));

vi.mock('../../src/dossier/compose.js', () => ({ composeDossier: vi.fn() }));
const compose = vi.mocked(composeDossier);

const PHONE = '+15165551234';
const PAYER = '0x2222222222222222222222222222222222222222';
const TX = `0x${'ab'.repeat(32)}`;

const DOSSIER: Dossier = {
  phone: PHONE,
  number_classification: 'business',
  carrier: { name: 'Verizon', type: 'landline' },
  caller_name: null,
  business_match: {
    name: 'Joe’s Pizza',
    category: 'Pizza',
    address: { line1: '1 Main St', city: 'Garden City', state: 'NY', postal: '11530' },
    hours: { mon: [{ open: '11:00', close: '22:00' }] },
    is_open_now: true,
    rating: { stars: 4.5, count: 120 },
    place_id: 'ChIJ-test',
    yelp_id: 'joes-pizza-garden-city',
  },
  reputation: { spam_risk_score: 0, is_known_robocall: false, is_dnc_listed: null, is_voip_risk: false },
  meta: {
    lookup_id: '3f0c7a52-6a52-4b8e-9d3b-0f6f1f6d2a11',
    schema_version: 'v1',
    cached_fields: ['carrier'],
    timestamp: '2026-10-27T12:00:00.000Z',
  },
};

function captureLogs() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream, text: () => chunks.join('') };
}

const pay = () => buildTestPayment({ amount: '0.03', network: 'base-sepolia', to: env.WALLET_ADDRESS! });

const isLookupCall = (body: unknown) => {
  if (typeof body !== 'string') return false;
  const message = JSON.parse(body);
  return message.method === 'tools/call' && message.params?.name === 'phone_intel.lookup';
};

// What an x402-aware MCP client does: attach a fresh X-PAYMENT to the paid call only. (A payment is
// single-use, so it cannot be a static header.) initialize and tools/list go out unpaid.
const payingFetch: typeof fetch = async (input, init) => {
  if (!isLookupCall(init?.body)) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('x-payment', await pay());
  return fetch(input, { ...init, headers });
};

let server: ReturnType<typeof buildServer>;
let logs: ReturnType<typeof captureLogs>;
let mcpUrl: URL;
const clients: Client[] = [];

async function startServer() {
  logs = captureLogs();
  server = buildServer({ logStream: logs.stream });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  if (address === null || typeof address === 'string') throw new Error('server is not listening on a port');
  mcpUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function connect(fetchFn?: typeof fetch) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { fetch: fetchFn }));
  return client;
}

const callLookup = (client: Client, args: Record<string, unknown>) =>
  client.callTool({ name: 'phone_intel.lookup', arguments: args });

const resultText = (result: Awaited<ReturnType<typeof callLookup>>) =>
  (result.content as { type: string; text: string }[]).map((part) => part.text).join('');

const postJsonRpc = (body: unknown, headers: Record<string, string> = {}) =>
  server.inject({
    method: 'POST',
    url: '/mcp',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });

// Braces matter: mockReset() returns the mock, and vitest would call a function returned from a hook as teardown.
beforeEach(async () => {
  compose.mockReset();
  compose.mockResolvedValue(DOSSIER);
  facilitator.verify.mockReset();
  facilitator.verify.mockResolvedValue({ isValid: true, payer: PAYER });
  facilitator.settle.mockReset();
  facilitator.settle.mockResolvedValue({ success: true, transaction: TX, network: 'base-sepolia', payer: PAYER });
  await startServer();
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await server.close();
});

describe('tool listing', () => {
  it('lists phone_intel.lookup, free of charge', async () => {
    const client = await connect();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['phone_intel.lookup']);
    expect(tools[0]?.description).toBe(
      'Return a composite dossier (carrier, business, hours, reputation) for a US phone number. Charges $0.03 USDC via x402.',
    );
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object', required: ['phone'] });
    expect(tools[0]?.outputSchema).toMatchObject({ type: 'object' });
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });
});

describe('paid lookups', () => {
  it('returns the dossier and settles the payment', async () => {
    const client = await connect(payingFetch);

    const result = await callLookup(client, { phone: PHONE });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(DOSSIER);
    expect((result.structuredContent as Dossier).meta.schema_version).toBe('v1');
    // Clients that ignore structuredContent get the same dossier as JSON text.
    expect(JSON.parse(resultText(result))).toEqual(DOSSIER);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(compose).toHaveBeenCalledWith(PHONE);
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('normalizes the phone before composing', async () => {
    const client = await connect(payingFetch);

    await callLookup(client, { phone: '(516) 555-1234' });

    expect(compose).toHaveBeenCalledWith(PHONE);
  });

  it('withholds the dossier when settlement fails', async () => {
    facilitator.settle.mockResolvedValue({
      success: false,
      errorReason: 'insufficient_funds',
      transaction: '',
      network: 'base-sepolia',
      payer: PAYER,
    });
    const client = await connect(payingFetch);

    const error = await callLookup(client, { phone: PHONE }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StreamableHTTPError);
    expect((error as StreamableHTTPError).code).toBe(402);
    expect((error as StreamableHTTPError).message).not.toContain('Verizon'); // no dossier in the body
  });

  it('charges once per lookup, not for the handshake or the listing', async () => {
    const client = await connect(payingFetch);
    await client.listTools();

    await callLookup(client, { phone: PHONE });
    await callLookup(client, { phone: PHONE });

    expect(facilitator.verify).toHaveBeenCalledTimes(2);
    expect(facilitator.settle).toHaveBeenCalledTimes(2);
  });
});

describe('unpaid lookups', () => {
  it('answers 402 with the x402 challenge and never reaches composeDossier', async () => {
    const client = await connect(); // no payment attached

    const error = await callLookup(client, { phone: PHONE }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StreamableHTTPError);
    expect((error as StreamableHTTPError).code).toBe(402);
    expect(compose).not.toHaveBeenCalled();
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it('puts the challenge on the 402 response', async () => {
    const res = await postJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'phone_intel.lookup', arguments: { phone: PHONE } },
    });

    expect(res.statusCode).toBe(402);
    expect(res.headers).toHaveProperty('x-payment-requirements');
    expect(res.json()).toMatchObject({ x402Version: 1, error: 'X-PAYMENT header is required' });
    expect(compose).not.toHaveBeenCalled();
  });

  it('rejects a JSON-RPC batch instead of letting it skip the gate', async () => {
    const res = await postJsonRpc([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'phone_intel.lookup', arguments: { phone: PHONE } } },
    ]);

    expect(res.statusCode).toBe(400);
    expect(compose).not.toHaveBeenCalled();
    expect(facilitator.verify).not.toHaveBeenCalled();
  });
});

describe('tool errors', () => {
  // A tool error is an HTTP 200 with isError set, so the SDK client returns it instead of
  // throwing. The money moves only for a successful lookup, same as GET /lookup: a verified
  // payment on a failed call is never settled.
  it.each([
    ['not-a-phone', 'invalid_phone'],
    ['', 'invalid_phone'],
    ['+442071234567', 'not_us_number'],
  ])('returns %j as a tool error (%s), makes no vendor call and does not charge', async (phone, code) => {
    const client = await connect(payingFetch);

    const result = await callLookup(client, { phone });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: code }]);
    expect(compose).not.toHaveBeenCalled();
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('returns vendor_failure without the adapter messages, and does not charge', async () => {
    compose.mockRejectedValue(new AggregateError([new Error('Twilio 401: bad auth token 4f9a')], 'Vendor lookup failed'));
    const client = await connect(payingFetch);

    const result = await callLookup(client, { phone: PHONE });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'vendor_failure' }]);
    expect(JSON.stringify(result)).not.toContain('Twilio');
    expect(facilitator.settle).not.toHaveBeenCalled();
    // The details go to the server log, not the client.
    expect(logs.text()).toContain('Twilio 401');
  });

  it('returns internal_error for anything else, without leaking the message', async () => {
    compose.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.7:5432'));
    const client = await connect(payingFetch);

    const result = await callLookup(client, { phone: PHONE });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'internal_error' }]);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('does not charge when the SDK rejects the arguments before the handler runs', async () => {
    const client = await connect(payingFetch);

    const result = await callLookup(client, {}); // phone missing

    expect(result.isError).toBe(true);
    expect(compose).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('does not ask for payment for a tool that does not exist', async () => {
    const client = await connect();

    const result = await client.callTool({ name: 'phone_intel.nope', arguments: {} });

    expect(result.isError).toBe(true);
    expect(facilitator.verify).not.toHaveBeenCalled();
  });
});

describe('transport', () => {
  it.each(['GET', 'DELETE'] as const)('answers %s /mcp with 405: no SSE stream, no sessions', async (method) => {
    const res = await server.inject({ method, url: '/mcp', headers: { accept: 'text/event-stream' } });

    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });
});

describe('logging', () => {
  it('never logs the phone number, in any form', async () => {
    const client = await connect(payingFetch);

    await callLookup(client, { phone: PHONE });
    await callLookup(client, { phone: '(516) 555-1234' });
    await callLookup(client, { phone: 'not-a-phone' });
    compose.mockRejectedValue(new AggregateError([new Error('vendor down')], 'Vendor lookup failed'));
    await callLookup(client, { phone: '516-555-9999' });

    const text = logs.text();
    expect(text).toContain('/mcp'); // the route pattern is what gets logged for the request
    for (const fragment of ['5165551234', '516-555', '516) 555', '%2B1', 'not-a-phone']) {
      expect(text).not.toContain(fragment);
    }
  });

  it('does not log fragments of a malformed body', async () => {
    const res = await postJsonRpc('{"jsonrpc":"2.0","method":"tools/call","params":{"arguments":{"phone":"+15165551234"');

    expect(res.statusCode).toBe(400);
    expect(logs.text()).not.toContain('5165551234');
    expect(res.body).not.toContain('5165551234');
  });
});
