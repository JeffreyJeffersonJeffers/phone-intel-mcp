import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeDossier } from '../../src/dossier/compose.js';
import type { Dossier } from '../../src/dossier/types.js';
import { env } from '../../src/env.js';
import { hashPhone } from '../../src/lib/phoneHash.js';
import { buildServer } from '../../src/server.js';
import { buildTestPayment } from './buildTestPayment.js';

// What a lookup is allowed to leave in the logs. The facilitator and the vendor layer are stubbed;
// the x402 gate, both routes, the MCP transport and Fastify's own error paths are the real thing.
const facilitator = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn() }));
vi.mock('x402/verify', () => ({ useFacilitator: () => facilitator }));

vi.mock('../../src/dossier/compose.js', () => ({ composeDossier: vi.fn() }));
const compose = vi.mocked(composeDossier);

const PHONE = '+15165551234';
const RAW_DIGITS = '5165551234';
const LOOKUP_URL = '/lookup/%2B15165551234';
const PAYER = '0x2222222222222222222222222222222222222222';
const TX = `0x${'ab'.repeat(32)}`;

const DOSSIER: Dossier = {
  phone: PHONE,
  number_classification: 'business',
  carrier: { name: 'Verizon', type: 'landline' },
  caller_name: null,
  business_match: null,
  reputation: { spam_risk_score: 0, is_known_robocall: false, is_dnc_listed: null, is_voip_risk: false },
  meta: {
    lookup_id: '3f0c7a52-6a52-4b8e-9d3b-0f6f1f6d2a11',
    schema_version: 'v1',
    cached_fields: ['carrier', 'hours'],
    timestamp: '2026-10-27T12:00:00.000Z',
  },
};

type LogLine = Record<string, unknown>;
function captureLogs() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  const text = () => chunks.join('');
  const lines = (): LogLine[] =>
    text()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogLine);
  // The one line a lookup writes about itself, on either transport.
  const lookupLines = () => lines().filter((line) => /^(mcp )?lookup /.test(String(line.msg)));
  return { stream, text, lines, lookupLines };
}

const pay = () => buildTestPayment({ amount: '0.03', network: 'base-sepolia', to: env.WALLET_ADDRESS! });
const payerOf = (header: string): string =>
  JSON.parse(Buffer.from(header, 'base64').toString()).payload.authorization.from;

let server: ReturnType<typeof buildServer>;
let logs: ReturnType<typeof captureLogs>;
afterEach(() => server.close());
// Braces matter: mockReset() returns the mock, and vitest would call a function returned from a hook as teardown.
beforeEach(() => {
  compose.mockReset();
  compose.mockResolvedValue(DOSSIER);
  facilitator.verify.mockReset();
  facilitator.verify.mockResolvedValue({ isValid: true, payer: PAYER });
  facilitator.settle.mockReset();
  facilitator.settle.mockResolvedValue({ success: true, transaction: TX, network: 'base-sepolia', payer: PAYER });
  logs = captureLogs();
  server = buildServer({ logStream: logs.stream });
});

const paidGet = (header: string, url = LOOKUP_URL) =>
  server.inject({ method: 'GET', url, headers: { 'x-payment': header } });

const mcpCall = (phone: string, header: string) =>
  server.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-payment': header,
    },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'phone_intel.lookup', arguments: { phone } },
    }),
  });

// Every way a phone number might be spelled if some layer echoed it.
const PHONE_SPELLINGS = [RAW_DIGITS, '%2B1516', '516) 555', '516-555', '516.555', '555-1234'];
function expectNoPhone(text: string) {
  for (const spelling of PHONE_SPELLINGS) expect(text).not.toContain(spelling);
}

describe('the lookup log line', () => {
  it('carries request_id, phone_hash, status, latency_ms, cache_hits and wallet_address_last6 on a paid GET', async () => {
    const header = await pay();

    await paidGet(header);

    const [line, ...rest] = logs.lookupLines();
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      msg: 'lookup completed',
      request_id: expect.any(String),
      phone_hash: hashPhone(PHONE),
      status: 200,
      latency_ms: expect.any(Number),
      cache_hits: ['carrier', 'hours'],
      wallet_address_last6: payerOf(header).slice(-6).toLowerCase(),
    });
    expect(line!.phone_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(line!.lookup_id).toBe(DOSSIER.meta.lookup_id);
  });

  it('names the request id request_id on every line of the request, and the wallet on every line after payment', async () => {
    const header = await pay();

    await paidGet(header);

    const lines = logs.lines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.request_id).toEqual(expect.any(String));
      expect(line).not.toHaveProperty('reqId');
    }
    const requestId = logs.lookupLines()[0]!.request_id;
    expect(new Set(lines.map((l) => l.request_id))).toEqual(new Set([requestId]));
    const last6 = payerOf(header).slice(-6).toLowerCase();
    for (const msg of ['payment verified', 'lookup completed', 'payment settled']) {
      expect(lines.find((l) => l.msg === msg)).toMatchObject({ wallet_address_last6: last6 });
    }
    // Before the payment is verified nobody is known yet, so nothing claims otherwise.
    expect(lines.find((l) => l.msg === 'incoming request')).not.toHaveProperty('wallet_address_last6');
  });

  it('logs a rejected number with a null phone_hash, the 400, and no vendor spend', async () => {
    await paidGet(await pay(), '/lookup/not-a-phone');

    expect(logs.lookupLines()).toHaveLength(1);
    expect(logs.lookupLines()[0]).toMatchObject({
      msg: 'lookup rejected',
      request_id: expect.any(String),
      phone_hash: null,
      status: 400,
      latency_ms: expect.any(Number),
      cache_hits: [],
      error_code: 'invalid_phone',
      wallet_address_last6: expect.stringMatching(/^[0-9a-f]{6}$/),
    });
  });

  it('reports how long the request really took as latency_ms', async () => {
    compose.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(DOSSIER), 50)));

    await paidGet(await pay());

    const latency = logs.lookupLines()[0]!.latency_ms as number;
    expect(latency).toBeGreaterThanOrEqual(40);
    expect(latency).toBeLessThan(5_000);
  });

  it('logs only the last 6 characters of the wallet, never the address or the payment', async () => {
    const header = await pay();

    await paidGet(header);

    const text = logs.text().toLowerCase();
    expect(text).not.toContain(payerOf(header).toLowerCase());
    expect(text).not.toContain(header.toLowerCase());
    expect(text).not.toContain(PAYER);
    expect(text).not.toContain('x-payment');
    expectNoPhone(logs.text());
  });

  it('logs a failed vendor lookup as 502 with the adapter messages stripped of the phone', async () => {
    compose.mockRejectedValue(
      new AggregateError(
        [
          new Error('Twilio authentication failed (HTTP 401, Twilio code 20003)'),
          new Error('IPQS request GET /api/json/phone/KEY/+15165551234 failed: Invalid key'),
        ],
        `Vendor lookup failed: ${PHONE}`,
      ),
    );

    const res = await paidGet(await pay());

    expect(res.statusCode).toBe(502);
    const [line] = logs.lookupLines();
    expect(line).toMatchObject({
      msg: 'lookup failed: vendor failure',
      status: 502,
      phone_hash: hashPhone(PHONE),
      latency_ms: expect.any(Number),
      cache_hits: [],
      adapter_errors: [
        'Twilio authentication failed (HTTP 401, Twilio code 20003)',
        'IPQS request GET /api/json/phone/KEY/[number] failed: Invalid key',
      ],
    });
    expectNoPhone(logs.text());
  });

  it('logs an unexpected failure as 500 with the message only: no err object, no stack, no phone', async () => {
    compose.mockRejectedValue(new Error(`connect to db for (516) 555-1234 failed (${PHONE}, ${RAW_DIGITS})`));

    const res = await paidGet(await pay());

    expect(res.statusCode).toBe(500);
    const [line] = logs.lookupLines();
    expect(line).toMatchObject({
      msg: 'lookup failed: unexpected error',
      status: 500,
      phone_hash: hashPhone(PHONE),
      latency_ms: expect.any(Number),
      cache_hits: [],
      error_message: 'connect to db for [number] failed ([number], [number])',
    });
    for (const l of logs.lines()) {
      expect(l).not.toHaveProperty('err');
      expect(l).not.toHaveProperty('stack');
    }
    expect(logs.text()).not.toMatch(/\bat .*\.(ts|js):\d+/); // no stack frames
    expectNoPhone(logs.text());
  });

  it('never logs what the facilitator said or what was sent to it', async () => {
    const header = await pay();
    facilitator.settle.mockRejectedValue(new Error(`settle failed for ${header} from ${payerOf(header)}`));

    const res = await paidGet(header);

    expect(res.statusCode).toBe(402);
    expect(logs.text()).not.toContain(header);
    expect(logs.text().toLowerCase()).not.toContain(payerOf(header).toLowerCase());
    expect(logs.text()).not.toContain('settle failed');
  });
});

describe('the MCP lookup log line', () => {
  it('carries the same fields as GET /lookup, wallet included', async () => {
    const header = await pay();

    const res = await mcpCall(PHONE, header);

    expect(res.statusCode).toBe(200);
    expect(logs.lookupLines()).toHaveLength(1);
    expect(logs.lookupLines()[0]).toMatchObject({
      msg: 'mcp lookup completed',
      request_id: expect.any(String),
      phone_hash: hashPhone(PHONE),
      status: 200,
      latency_ms: expect.any(Number),
      cache_hits: ['carrier', 'hours'],
      wallet_address_last6: payerOf(header).slice(-6).toLowerCase(),
      lookup_id: DOSSIER.meta.lookup_id,
    });
    expect(new Set(logs.lines().map((l) => l.request_id)).size).toBe(1);
    expectNoPhone(logs.text());
  });

  it('reports how long the request really took as latency_ms', async () => {
    compose.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(DOSSIER), 50)));

    await mcpCall(PHONE, await pay());

    const latency = logs.lookupLines()[0]!.latency_ms as number;
    expect(latency).toBeGreaterThanOrEqual(40);
    expect(latency).toBeLessThan(5_000);
  });

  it('logs a rejected number with a null phone_hash', async () => {
    await mcpCall('not-a-phone', await pay());

    expect(logs.lookupLines()[0]).toMatchObject({
      msg: 'mcp lookup rejected',
      phone_hash: null,
      status: 400,
      latency_ms: expect.any(Number),
      cache_hits: [],
      error_code: 'invalid_phone',
      wallet_address_last6: expect.stringMatching(/^[0-9a-f]{6}$/),
    });
  });

  it('logs a vendor failure as 502 with the phone stripped from the adapter messages', async () => {
    compose.mockRejectedValue(
      new AggregateError([new Error(`Yelp GET /phone_search?phone=%2B15165551234 -> 500`)], 'Vendor lookup failed'),
    );

    await mcpCall(PHONE, await pay());

    expect(logs.lookupLines()[0]).toMatchObject({
      msg: 'mcp lookup failed: vendor failure',
      status: 502,
      phone_hash: hashPhone(PHONE),
      cache_hits: [],
      adapter_errors: ['Yelp GET /phone_search?phone=%2B[number] -> 500'],
    });
    expectNoPhone(logs.text());
  });

  it('logs an unexpected failure as 500 with the message only', async () => {
    compose.mockRejectedValue(new Error(`boom for ${PHONE}`));

    await mcpCall(PHONE, await pay());

    expect(logs.lookupLines()[0]).toMatchObject({
      msg: 'mcp lookup failed: unexpected error',
      status: 500,
      phone_hash: hashPhone(PHONE),
      error_message: 'boom for [number]',
    });
    for (const l of logs.lines()) expect(l).not.toHaveProperty('err');
    expectNoPhone(logs.text());
  });
});

// Anything that fails before our handlers (or in one we did not anticipate) lands in Fastify's own
// error logging, which writes the error message and the whole error object.
describe('framework errors', () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
      payload: body,
    });

  it.each([
    ['a trailing comma', `{"jsonrpc":"2.0","params":{"arguments":{"phone":"${PHONE}",}}}`],
    ['an unquoted value', `{"jsonrpc":"2.0","params":{"arguments":{"phone":${PHONE}}}}`],
    ['a bare number', PHONE],
    ['trailing garbage', `{"phone":"${PHONE}"} ${PHONE}`],
  ])('does not log the phone number from an unparseable JSON body (%s)', async (_label, body) => {
    const res = await post(body);

    expect(res.statusCode).toBe(400);
    expectNoPhone(logs.text());
    for (const l of logs.lines()) expect(l).not.toHaveProperty('err');
  });

  it('does not log the phone number from an unsupported media type', async () => {
    const res = await post('{}', { 'content-type': `application/x-${RAW_DIGITS}` });

    expect(res.statusCode).toBe(415);
    expectNoPhone(logs.text());
  });

  it('still records that a framework error happened, with its status and code', async () => {
    await post('{"a":}');

    const line = logs.lines().find((l) => l.msg === 'request error');
    expect(line).toMatchObject({ status: 400, request_id: expect.any(String) });
  });

  // Fastify logs a few errors straight to the logger as { err } (a failed writeHead, a serializer
  // failure, a stream error, a double send), outside the LogController overrides above. The
  // logger's own err serializer is the net under all of them.
  it('redacts an err object logged directly to the logger: message only, no stack, no phone', () => {
    server.log.error({ err: new TypeError('fail /lookup/5165551234') }, 'synthetic');

    const line = logs.lines().find((l) => l.msg === 'synthetic');
    expect(line!.err).toEqual({ type: 'TypeError', message: 'fail /lookup/[number]' });
    expect(logs.text()).not.toContain('5165551234');
    expect(logs.text()).not.toContain('stack');
  });

  // Fastify's "Reply was already sent" warnings carry the request URL, i.e. the phone, in the error
  // message and in the log message (pino copies err.message into msg before any serializer runs).
  it.each([
    [
      'sends twice',
      async (_request: unknown, reply: { send: (payload: string) => unknown }) => {
        reply.send('first');
        reply.send('second');
      },
    ],
    [
      'sends and then also returns a value',
      async (_request: unknown, reply: { send: (payload: string) => unknown }) => {
        reply.send('first');
        return 'second';
      },
    ],
    [
      'writes the raw response and then also sends (a plain-string warning, not an err)',
      async (_request: unknown, reply: { raw: { writeHead: (code: number) => void; end: (body: string) => void } }) => {
        reply.raw.writeHead(200);
        reply.raw.end('raw');
        return (reply as unknown as { send: (payload: string) => unknown }).send('second');
      },
    ],
  ])('does not log the phone when a handler %s', async (_label, handler) => {
    server.get('/double/:phone', handler);

    await server.inject({ method: 'GET', url: `/double/${RAW_DIGITS}` });

    expect(logs.text()).toContain('already sent'); // the warning itself is still logged
    expectNoPhone(logs.text());
    for (const l of logs.lines()) expect(l).not.toHaveProperty('err.stack');
  });
});
