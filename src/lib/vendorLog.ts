import pino from 'pino';
import { env } from '../env.js';

// For events inside vendor adapters, which run beneath compose and have no request logger to hand.
// It writes JSON lines to stdout like the server's logger (so they land in the same Fly logs), without
// a request_id. Log only a fixed label and a status here: never a phone number, a URL or an error
// object, because nothing in this file redacts.
export const vendorLog = pino({ level: env.NODE_ENV === 'test' ? 'silent' : 'info' });
