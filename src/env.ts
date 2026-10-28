const NODE_ENVS = ['development', 'test', 'production'] as const;
type NodeEnv = (typeof NODE_ENVS)[number];

export interface Env {
  readonly DATABASE_URL: string | undefined;
  readonly TWILIO_SID: string | undefined;
  readonly TWILIO_TOKEN: string | undefined;
  readonly YELP_API_KEY: string | undefined;
  // Optional. Set: Yelp calls go through ScraperAPI (Yelp refuses datacenter IPs such as Fly's).
  // Unset: Yelp is called directly, which is right wherever Yelp does not block the machine.
  readonly SCRAPERAPI_KEY: string | undefined;
  readonly GOOGLE_PLACES_API_KEY: string | undefined;
  readonly IPQS_API_KEY: string | undefined;
  readonly CDP_API_KEY: string | undefined;
  readonly CDP_API_SECRET: string | undefined;
  readonly WALLET_ADDRESS: string | undefined;
  // Key for the HMAC behind phone_hash in the logs; required in production (see lib/phoneHash.ts).
  readonly LOG_PHONE_HMAC_KEY: string | undefined;
  readonly PORT: number;
  readonly NODE_ENV: NodeEnv;
}

// Only PORT and NODE_ENV are needed to boot in Task 1, so only they are validated here.
// Vendor/DB/payment variables stay optional until the tasks that consume them tighten them.
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Readonly<Env> {
  const nodeEnv = source.NODE_ENV || 'development';
  if (!NODE_ENVS.includes(nodeEnv as NodeEnv)) {
    throw new Error(`Invalid NODE_ENV "${nodeEnv}": expected one of ${NODE_ENVS.join(', ')}`);
  }

  const port = Number(source.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${source.PORT}": expected an integer between 1 and 65535`);
  }

  return Object.freeze({
    DATABASE_URL: source.DATABASE_URL || undefined,
    TWILIO_SID: source.TWILIO_SID || undefined,
    TWILIO_TOKEN: source.TWILIO_TOKEN || undefined,
    YELP_API_KEY: source.YELP_API_KEY || undefined,
    SCRAPERAPI_KEY: source.SCRAPERAPI_KEY || undefined,
    GOOGLE_PLACES_API_KEY: source.GOOGLE_PLACES_API_KEY || undefined,
    IPQS_API_KEY: source.IPQS_API_KEY || undefined,
    CDP_API_KEY: source.CDP_API_KEY || undefined,
    CDP_API_SECRET: source.CDP_API_SECRET || undefined,
    WALLET_ADDRESS: source.WALLET_ADDRESS || undefined,
    LOG_PHONE_HMAC_KEY: source.LOG_PHONE_HMAC_KEY || undefined,
    PORT: port,
    NODE_ENV: nodeEnv as NodeEnv,
  });
}

export const env = loadEnv();
