import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool } from '../db.js';
import { userId } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { ALLOWED_MIME, saveFile, signedUrl, verifySignature } from '../lib/files.js';

export async function fileRoutes(app: FastifyInstance) {
  app.post('/api/v1/uploads', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const uid = userId(req);
    const file = await req.file();
    if (!file) throw badRequest('no_file', 'Fajl nije poslat.');
    if (!ALLOWED_MIME[file.mimetype]) throw badRequest('bad_file', 'Dozvoljene su slike i PDF.');
    const data = await file.toBuffer();
    const name = await saveFile(pool, { data, mime: file.mimetype, originalName: file.filename, uploadedBy: uid });
    return { path: name, url: signedUrl(name), name: file.filename, sizeBytes: data.length, mime: file.mimetype };
  });

  app.get('/files/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const { exp, sig } = req.query as { exp?: string; sig?: string };
    if (!verifySignature(name, Number(exp), sig ?? '')) throw forbidden('Link je istekao.');
    if (name !== path.basename(name)) throw notFound();
    const row = await one(pool, 'SELECT mime, original_name FROM uploads WHERE path = ?', [name]);
    if (!row) throw notFound();
    const fullPath = path.join(config.storageDir, name);
    const info = await stat(fullPath).catch(() => null);
    if (!info) throw notFound();
    reply.header('Content-Type', row.mime).header('Content-Length', info.size).header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=86400').header('Cross-Origin-Resource-Policy', 'cross-origin')
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
    return reply.send(createReadStream(fullPath));
  });
}
