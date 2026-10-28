import type { FastifyPluginAsync } from 'fastify';
import { composeDossier } from '../dossier/compose.js';
import { normalizePhone } from '../lib/phone.js';
import { hashPhone } from '../lib/phoneHash.js';

export const REJECTION_MESSAGES = {
  invalid_phone: 'Phone number is malformed or missing',
  not_us_number: 'Only US (+1) phone numbers are supported',
} as const;

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Validation runs before composeDossier, so a rejected number makes no vendor call. The vendor
// caches are written inside each adapter before composeDossier returns (Review Focus 5), so by
// the time a response is sent a retry on the same number is already a cache hit.
export const lookupRoute: FastifyPluginAsync = async (server) => {
  server.get<{ Params: { phone: string } }>('/lookup/:phone', async (request, reply) => {
    const latencyMs = () => Math.round(reply.elapsedTime);

    const phone = normalizePhone(request.params.phone);
    if ('error' in phone) {
      request.log.info({ error_code: phone.error, latency_ms: latencyMs() }, 'lookup rejected');
      return reply.code(400).send({ error: { code: phone.error, message: REJECTION_MESSAGES[phone.error] } });
    }

    const phoneHash = hashPhone(phone.e164);
    try {
      const dossier = await composeDossier(phone.e164);
      request.log.info(
        { lookup_id: dossier.meta.lookup_id, phone_hash: phoneHash, latency_ms: latencyMs() },
        'lookup completed',
      );
      return dossier;
    } catch (err) {
      // No lookup_id on failure: compose mints it only once a dossier exists. The request's own
      // reqId (bound on request.log) is the correlation handle instead.
      if (err instanceof AggregateError) {
        // Adapter messages go to the log only; the response body stays generic.
        request.log.error(
          { phone_hash: phoneHash, latency_ms: latencyMs(), adapter_errors: err.errors.map(describeError) },
          'lookup failed: vendor failure',
        );
        return reply
          .code(502)
          .send({ error: { code: 'vendor_failure', message: 'One or more vendor services failed' } });
      }
      request.log.error({ err, phone_hash: phoneHash, latency_ms: latencyMs() }, 'lookup failed: unexpected error');
      return reply.code(500).send({ error: { code: 'internal_error', message: 'Unexpected error' } });
    }
  });
};
