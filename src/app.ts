import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { ApiError } from './lib/errors.js';
import { announcementRoutes } from './routes/announcements.js';
import { authRoutes } from './routes/auth.js';
import { budgetRoutes } from './routes/budget.js';
import { buildingRoutes } from './routes/buildings.js';
import { claimRoutes } from './routes/claims.js';
import { fileRoutes } from './routes/files.js';
import { issueRoutes } from './routes/issues.js';
import { threadRoutes } from './routes/threads.js';

export async function buildApp(opts: { rateLimit?: boolean } = {}) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' && { level: 'warn' }, bodyLimit: 3 * 1024 * 1024 });

  await app.register(helmet, { crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, { origin: config.production ? config.corsOrigins : true, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] });
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, { global: false, max: opts.rateLimit === false ? 1_000_000 : 300, timeWindow: '1 minute' });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ code: err.code, message: err.message });
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.status(400).send({ code: 'validation', message: first?.message ?? 'Neispravni podaci.', field: first?.path.join('.') });
    }
    if (err.statusCode === 429) return reply.status(429).send({ code: 'rate_limited', message: 'Previše pokušaja. Sačekajte minut.' });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ code: 'too_large', message: 'Fajl je veći od 15 MB.' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ code: 'bad_request', message: 'Neispravan zahtev.' });
    app.log.error(err);
    console.error(err);
    return reply.status(500).send({ code: 'server_error', message: 'Greška na serveru. Pokušajte ponovo.' });
  });

  app.get('/health', async () => ({ ok: true }));
  await app.register(fileRoutes);
  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(buildingRoutes);
      await api.register(issueRoutes);
      await api.register(budgetRoutes);
      await api.register(claimRoutes);
      await api.register(announcementRoutes);
      await api.register(threadRoutes);
    },
    { prefix: '/api/v1' },
  );
  return app;
}
