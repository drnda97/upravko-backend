import 'dotenv/config';
import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  host: env.HOST ?? '0.0.0.0',
  db: {
    host: env.DB_HOST ?? '127.0.0.1',
    port: Number(env.DB_PORT ?? 8889),
    user: env.DB_USER ?? 'root',
    password: env.DB_PASSWORD ?? 'root',
    database: env.DB_NAME ?? 'upravko',
  },
  jwtSecret: env.JWT_SECRET ?? '',
  publicUrl: (env.PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, ''),
  corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  storageDir: path.resolve(env.STORAGE_DIR ?? './storage'),
  smtpUrl: env.SMTP_URL ?? '',
  mailFrom: env.MAIL_FROM ?? 'Upravko <no-reply@upravko.rs>',
  appLink: env.APP_LINK ?? 'upravko://',
  demoNow: env.DEMO_NOW ?? '',
  // Adrese proksija kojima se veruje X-Forwarded-For (lista IP/CIDR ili loopback, linklocal, uniquelocal).
  trustProxy: env.TRUST_PROXY ?? 'loopback,linklocal,uniquelocal',
  production: env.NODE_ENV === 'production',
};

if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET mora da ima najmanje 32 karaktera');
// Podrazumevana vrednost iz .env.example ima 32+ karaktera, pa prođe proveru dužine; u produkciji je javno
// poznata (falsifikovanje tokena), zato se izričito odbija.
if (config.production && config.jwtSecret === 'dev-only-secret-change-me-please-32chars') {
  throw new Error('JWT_SECRET je podrazumevana vrednost iz .env.example; postavi svoju tajnu u produkciji');
}
if (config.production && config.demoNow) throw new Error('DEMO_NOW nije dozvoljen u produkciji');
