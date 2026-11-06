import type { FastifyPluginAsync } from 'fastify';
import { composeDossier } from '../dossier/compose.js';
import { safeErrorMessage } from '../lib/logSafe.js';
import { normalizePhone } from '../lib/phone.js';
import { hashPhone } from '../lib/phoneHash.js';
import { lookupLogFields } from '../middleware/requestLog.js';
import { recordLookup } from '../stats/counters.js';

export const REJECTION_MESSAGES = {
  invalid_phone: 'Phone number is malformed or missing',
  not_us_number: 'Only US (+1) phone numbers are supported',
} as const;

// Validation runs before composeDossier, so a rejected number makes no vendor call. The vendor
// caches are written inside each adapter before composeDossier returns (Review Focus 5), so by
// the time a response is sent a retry on the same number is already a cache hit.
//
// Logging: one line per lookup, with the fields from lookupLogFields. Never the phone (phone_hash
// instead) and never an error object: error text goes through safeErrorMessage, because vendor and
// database messages can quote the URL they fetched.
export const lookupRoute: FastifyPluginAsync = async (server) => {
  server.get<{ Params: { phone: string } }>('/lookup/:phone', async (request, reply) => {
    const latencyMs = () => Math.round(reply.elapsedTime);

    const phone = normalizePhone(request.params.phone);
    if ('error' in phone) {
      const ms = latencyMs();
      recordLookup({ status: 400, latencyMs: ms, cacheHits: [] });
      request.log.info(
        {
          ...lookupLogFields({ status: 400, latencyMs: ms, phoneHash: null, cacheHits: [] }),
          error_code: phone.error,
        },
        'lookup rejected',
      );
      return reply.code(400).send({ error: { code: phone.error, message: REJECTION_MESSAGES[phone.error] } });
    }

    const phoneHash = hashPhone(phone.e164);
    try {
      const dossier = await composeDossier(phone.e164);
      const ms = latencyMs();
      recordLookup({ status: 200, latencyMs: ms, cacheHits: dossier.meta.cached_fields });
      request.log.info(
        {
          ...lookupLogFields({
            status: 200,
            latencyMs: ms,
            phoneHash,
            cacheHits: dossier.meta.cached_fields,
          }),
          lookup_id: dossier.meta.lookup_id,
        },
        'lookup completed',
      );
      return dossier;
    } catch (err) {
      // No lookup_id on failure: compose mints it only once a dossier exists. The request's own
      // request_id (bound on request.log) is the correlation handle instead.
      if (err instanceof AggregateError) {
        // Adapter messages go to the log only (redacted); the response body stays generic.
        const ms = latencyMs();
        recordLookup({ status: 502, latencyMs: ms, cacheHits: [] });
        request.log.error(
          {
            ...lookupLogFields({ status: 502, latencyMs: ms, phoneHash, cacheHits: [] }),
            adapter_errors: err.errors.map(safeErrorMessage),
          },
          'lookup failed: vendor failure',
        );
        return reply
          .code(502)
          .send({ error: { code: 'vendor_failure', message: 'One or more vendor services failed' } });
      }
      const ms = latencyMs();
      recordLookup({ status: 500, latencyMs: ms, cacheHits: [] });
      request.log.error(
        {
          ...lookupLogFields({ status: 500, latencyMs: ms, phoneHash, cacheHits: [] }),
          error_message: safeErrorMessage(err),
        },
        'lookup failed: unexpected error',
      );
      return reply.code(500).send({ error: { code: 'internal_error', message: 'Unexpected error' } });
    }
  });
};
