import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLabApplication } from './application.js';

let app: NestFastifyApplication | undefined;
try {
  app = await createLabApplication();
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  await app.listen(8080, '0.0.0.0');
} catch {
  if (app) await app.close().catch(() => {});
  console.error('F01 NestJS/Fastify could not start');
  process.exitCode = 1;
}
