import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exec, one, pool, rows, uuid } from '../db.js';
import { buildingAccess, requireManager, residentIds, type Access } from '../lib/access.js';
import { userId } from '../lib/auth.js';
import { localDate, now } from '../lib/clock.js';
import { notFound } from '../lib/errors.js';
import { assertOwnUpload, fileInfo } from '../lib/files.js';
import { pushLater } from '../lib/push.js';
import { toBuilding } from '../lib/realtime.js';

export async function listAnnouncements(access: Access, archived = false) {
  const b = await one(pool, 'SELECT apartments_count FROM buildings WHERE id = ?', [access.buildingId]);
  const list = await rows(
    pool,
    `SELECT n.*, (SELECT COUNT(*) FROM announcement_reads r WHERE r.announcement_id = n.id) AS reads_count,
       ${access.apartmentId ? 'EXISTS(SELECT 1 FROM announcement_reads r WHERE r.announcement_id = n.id AND r.apartment_id = ?)' : '1'} AS is_read
     FROM announcements n WHERE n.building_id = ? AND (n.expires_at IS NULL OR n.expires_at ${archived ? '<' : '>='} ?) ${archived ? 'AND n.expires_at IS NOT NULL' : ''}
     ORDER BY n.pinned DESC, n.created_at DESC`,
    [...(access.apartmentId ? [access.apartmentId] : []), access.buildingId, localDate()],
  );
  return list.map((n) => ({
    id: n.id, type: n.type, title: n.title, summary: n.summary ?? n.body.slice(0, 120), pinned: !!n.pinned, createdAt: n.created_at, expiresAt: n.expires_at,
    eventAt: n.event_at, eventPlace: n.event_place, isRead: !!n.is_read, reads: Number(n.reads_count), apartmentsCount: b!.apartments_count,
    hasAttachment: !!n.attachment_path,
  }));
}

export async function announcementRoutes(app: FastifyInstance) {
  app.get('/buildings/:id/announcements', async (req) => {
    const { id } = req.params as { id: string };
    const access = await buildingAccess(userId(req), id);
    const { archived } = z.object({ archived: z.coerce.boolean().default(false) }).parse(req.query);
    return listAnnouncements(access, archived);
  });

  app.post('/buildings/:id/announcements', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    await requireManager(uid, id);
    const body = z.object({
      type: z.enum(['info', 'urgent', 'meeting', 'payment_reminder']),
      title: z.string().trim().min(3, 'Unesite naslov.').max(190),
      body: z.string().trim().min(3, 'Unesite tekst.').max(5000),
      attachmentPath: z.string().nullable().optional(),
      pinned: z.boolean().default(false),
      expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      eventAt: z.coerce.date().nullable().optional(),
      eventPlace: z.string().trim().max(190).nullable().optional(),
    }).parse(req.body);
    await assertOwnUpload(pool, uid, body.attachmentPath);
    const announcementId = uuid();
    await exec(
      pool,
      'INSERT INTO announcements (id, building_id, type, title, body, attachment_path, pinned, expires_at, event_at, event_place, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [announcementId, id, body.type, body.title, body.body, body.attachmentPath ?? null, body.pinned ? 1 : 0, body.expiresAt ?? null, body.eventAt ?? null, body.eventPlace ?? null, uid, now()],
    );
    toBuilding(id, 'announcements');
    pushLater(await residentIds(id), {
      title: body.type === 'urgent' ? `Hitno: ${body.title}` : body.title, body: body.body.slice(0, 120),
      urgent: body.type === 'urgent' || body.type === 'payment_reminder', data: { screen: 'announcement', id: announcementId },
    });
    return { id: announcementId };
  });

  app.get('/announcements/:id', async (req) => {
    const uid = userId(req);
    const n = await one(pool, 'SELECT n.*, u.full_name AS author FROM announcements n LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?', [(req.params as { id: string }).id]);
    if (!n) throw notFound('Objava nije pronađena.');
    const access = await buildingAccess(uid, n.building_id);
    const b = await one(pool, 'SELECT apartments_count FROM buildings WHERE id = ?', [n.building_id]);
    const reads = await one(pool, 'SELECT COUNT(*) AS n FROM announcement_reads WHERE announcement_id = ?', [n.id]);
    return {
      id: n.id, type: n.type, title: n.title, body: n.body, pinned: !!n.pinned, createdAt: n.created_at, expiresAt: n.expires_at,
      eventAt: n.event_at, eventPlace: n.event_place, author: n.author, attachment: await fileInfo(pool, n.attachment_path),
      reads: Number(reads?.n ?? 0), apartmentsCount: b!.apartments_count, viewerRole: access.role,
    };
  });

  // Čitanje se broji po stanu.
  app.post('/announcements/:id/read', async (req) => {
    const uid = userId(req);
    const n = await one(pool, 'SELECT id, building_id FROM announcements WHERE id = ?', [(req.params as { id: string }).id]);
    if (!n) throw notFound();
    const access = await buildingAccess(uid, n.building_id);
    if (access.apartmentId) {
      await exec(pool, 'INSERT IGNORE INTO announcement_reads (announcement_id, apartment_id, read_at) VALUES (?, ?, ?)', [n.id, access.apartmentId, now()]);
      toBuilding(n.building_id, 'announcements');
    }
    return { ok: true };
  });
}
