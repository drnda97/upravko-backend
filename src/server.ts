import { buildApp } from './app.js';
import { config } from './config.js';
import { startJobs } from './jobs/index.js';
import { attachRealtime } from './lib/realtime.js';

const app = await buildApp();
await app.ready();
attachRealtime(app.server);
startJobs();
await app.listen({ port: config.port, host: config.host });
console.log(`Upravko API radi na ${config.publicUrl}/api/v1`);
