import { env } from './env.js';
import { buildServer } from './server.js';

const server = buildServer();

try {
  await server.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
