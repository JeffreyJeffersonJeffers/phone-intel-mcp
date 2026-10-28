import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeDossier } from '../../src/dossier/compose.js';
import type { Dossier } from '../../src/dossier/types.js';
import { hashPhone } from '../../src/lib/phoneHash.js';
import { buildServer } from '../../src/server.js';

// compose is the whole vendor layer, so mocking it makes "composeDossier not called" the proof
// that no vendor call happens. Caching lives inside the adapters (tested in Tasks 4-8).
vi.mock('../../src/dossier/compose.js', () => ({ composeDossier: vi.fn() }));
const compose = vi.mocked(composeDossier);

const PHONE = '+15165551234';

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
    cached_fields: ['carrier'],
    timestamp: '2026-10-27T12:00:00.000Z',
  },
};

// Server logs go to an in-memory stream so tests can assert on what is (and is not) logged.
function captureLogs() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  const text = () => chunks.join('');
  const lines = () =>
    text()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { stream, text, lines };
}

let server: ReturnType<typeof buildServer>;
afterEach(() => server.close());
// Braces matter: mockReset() returns the mock, and vitest would call a function returned from a hook as teardown.
beforeEach(() => {
  compose.mockReset();
});

describe('GET /lookup/:phone', () => {
  it('returns the dossier for a valid US number', async () => {
    server = buildServer();
    compose.mockResolvedValue(DOSSIER);

    const res = await server.inject({ method: 'GET', url: '/lookup/%2B15165551234' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DOSSIER);
    expect(res.json().meta.schema_version).toBe('v1');
    expect(compose).toHaveBeenCalledTimes(1);
    expect(compose).toHaveBeenCalledWith(PHONE);
  });

  it('composes with the normalized E.164 number, not the raw path value', async () => {
    server = buildServer();
    compose.mockResolvedValue(DOSSIER);

    const res = await server.inject({ method: 'GET', url: '/lookup/(516)%20555-1234' });

    expect(res.statusCode).toBe(200);
    expect(compose).toHaveBeenCalledWith(PHONE);
  });

  // Review Focus 1
  it('returns 400 not_us_number for a +44 number and calls no vendor', async () => {
    server = buildServer();

    const res = await server.inject({ method: 'GET', url: '/lookup/%2B447911123456' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'not_us_number', message: 'Only US (+1) phone numbers are supported' },
    });
    expect(compose).not.toHaveBeenCalled();
  });

  // Review Focus 2
  it.each([
    ['a SQL fragment', "abc'OR1%3D1"],
    ['letters', 'not-a-phone'],
    ['path traversal', '..%2F..%2Fetc%2Fpasswd'],
    ['over-long input', `%2B1${'5'.repeat(40)}`],
    ['an empty value', ''],
  ])('returns 400 invalid_phone for %s and calls no vendor', async (_label, param) => {
    server = buildServer();

    const res = await server.inject({ method: 'GET', url: `/lookup/${param}` });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'invalid_phone', message: 'Phone number is malformed or missing' },
    });
    expect(compose).not.toHaveBeenCalled();
  });

  it('returns 502 vendor_failure without leaking adapter messages, and logs them instead', async () => {
    const logs = captureLogs();
    server = buildServer({ logStream: logs.stream });
    const adapterMessages = ['Twilio authentication failed (HTTP 401, Twilio code 20003)', 'IPQS_API_KEY is not set'];
    compose.mockRejectedValue(new AggregateError(adapterMessages.map((m) => new Error(m)), 'Vendor lookup failed'));

    const res = await server.inject({ method: 'GET', url: '/lookup/%2B15165551234' });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: { code: 'vendor_failure', message: 'One or more vendor services failed' },
    });
    for (const message of adapterMessages) expect(res.body).not.toContain(message);

    const failure = logs.lines().find((line) => line.level === 50 /* pino error */);
    expect(failure).toMatchObject({ adapter_errors: adapterMessages, phone_hash: hashPhone(PHONE) });
  });

  it('returns 500 internal_error for any other failure without leaking its message', async () => {
    const logs = captureLogs();
    server = buildServer({ logStream: logs.stream });
    compose.mockRejectedValue(new TypeError('secret internal detail'));

    const res = await server.inject({ method: 'GET', url: '/lookup/%2B15165551234' });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal_error', message: 'Unexpected error' } });
    expect(res.body).not.toContain('secret internal detail');
    expect(logs.text()).toContain('secret internal detail');
  });
});

describe('lookup logging', () => {
  it('logs one completion line with lookup_id, phone_hash and latency_ms', async () => {
    const logs = captureLogs();
    server = buildServer({ logStream: logs.stream });
    compose.mockResolvedValue(DOSSIER);

    await server.inject({ method: 'GET', url: '/lookup/%2B15165551234' });

    const completed = logs.lines().filter((line) => line.lookup_id !== undefined);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      lookup_id: DOSSIER.meta.lookup_id,
      phone_hash: hashPhone(PHONE),
      latency_ms: expect.any(Number),
    });
  });

  it('never writes the raw phone to the logs, on success, rejection, vendor failure or 404', async () => {
    const logs = captureLogs();
    server = buildServer({ logStream: logs.stream });

    compose.mockResolvedValueOnce(DOSSIER);
    await server.inject({ method: 'GET', url: '/lookup/%2B15165551234' });
    await server.inject({ method: 'GET', url: '/lookup/%2B447911123456' });
    compose.mockRejectedValueOnce(new AggregateError([new Error('boom')], 'Vendor lookup failed'));
    await server.inject({ method: 'GET', url: '/lookup/%2B15165551234' });
    await server.inject({ method: 'GET', url: '/nope/%2B15165551234' });

    expect(logs.lines().length).toBeGreaterThan(0);
    const text = logs.text();
    expect(text).not.toContain('5165551234');
    expect(text).not.toContain('447911123456');
  });
});
