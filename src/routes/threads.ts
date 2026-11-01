import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exec, one, pool, rows, tx, uuid, type Row } from '../db.js';
import { buildingAccess, managerIds, type Access } from '../lib/access.js';
import { userId } from '../lib/auth.js';
import { now } from '../lib/clock.js';
import { addEvent } from '../lib/events.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { assertOwnUpload, fileInfo } from '../lib/files.js';
import { pushLater } from '../lib/push.js';
import { toBuilding, toUsers } from '../lib/realtime.js';

const bodyField = z.string().trim().min(1, 'Napišite poruku.').max(5000);

/** Nit vidi samo njen autor i upravnici te zgrade. */
async function threadAccess(uid: string, threadId: string): Promise<{ thread: Row; access: Access }> {
  const thread = await one(pool, 'SELECT * FROM private_threads WHERE id = ?', [threadId]);
  if (!thread) throw notFound('Poruka nije pronađena.');
  const access = await buildingAccess(uid, thread.building_id);
  if (access.role !== 'manager' && thread.resident_user_id !== uid) throw notFound('Poruka nije pronađena.');
  return { thread, access };
}

function notifyOther(thread: Row, access: Access, title: string, body: string) {
  if (access.role === 'manager') {
    toUsers([thread.resident_user_id], 'threads', thread.id);
    pushLater([thread.resident_user_id], { title, body, data: { screen: 'thread', id: thread.id } });
  } else {
    managerIds(thread.building_id).then((ids) => {
      toUsers(ids, 'threads', thread.id);
      pushLater(ids, { title, body, data: { screen: 'thread', id: thread.id } });
    });
  }
}

export async function threadRoutes(app: FastifyInstance) {
  app.get('/buildings/:id/threads', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    const access = await buildingAccess(uid, id);
    const list = await rows(
      pool,
      `SELECT t.*, u.full_name AS resident_name,
        (SELECT a.number FROM memberships m JOIN apartments a ON a.id = m.apartment_id WHERE m.building_id = t.building_id AND m.user_id = t.resident_user_id AND m.status = 'approved' ORDER BY a.number LIMIT 1) AS apartment_number,
        lm.body AS last_body, lm.created_at AS last_at, lm.sender_user_id AS last_sender,
        lr.body AS resident_body, lr.created_at AS resident_at
       FROM private_threads t JOIN users u ON u.id = t.resident_user_id
       LEFT JOIN private_messages lm ON lm.id = (SELECT p.id FROM private_messages p WHERE p.thread_id = t.id ORDER BY p.created_at DESC LIMIT 1)
       LEFT JOIN private_messages lr ON lr.id = (SELECT p.id FROM private_messages p WHERE p.thread_id = t.id AND p.sender_user_id = t.resident_user_id ORDER BY p.created_at DESC LIMIT 1)
       WHERE t.building_id = ? ${access.role === 'manager' ? '' : 'AND t.resident_user_id = ?'}
       ORDER BY t.status = 'closed', lm.created_at DESC`,
      access.role === 'manager' ? [id] : [id, uid],
    );
    const managerName = (await one(pool, 'SELECT u.full_name FROM building_managers m JOIN users u ON u.id = m.user_id WHERE m.building_id = ? LIMIT 1', [id]))?.full_name ?? null;
    return {
      managerName,
      items: list.map((t) => {
        const isManager = access.role === 'manager';
        const unread = isManager
          ? !!t.resident_at && (!t.manager_read_at || t.resident_at > t.manager_read_at)
          : t.last_sender !== uid && (!t.resident_read_at || t.last_at > t.resident_read_at);
        return {
          id: t.id, subject: t.subject, status: t.status, residentName: t.resident_name, apartmentNumber: t.apartment_number,
          lastBody: isManager ? t.resident_body : t.last_body, lastAt: t.last_at, lastFromMe: t.last_sender === uid, unread,
          conversionPending: !!t.conversion_requested_at && !t.conversion_consented_at && !t.conversion_declined_at,
        };
      }),
    };
  });

  app.post('/buildings/:id/threads', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    const access = await buildingAccess(uid, id);
    if (access.role !== 'resident') throw forbidden('Poruku upravniku šalje stanar.');
    const body = z.object({
      subject: z.string().trim().min(3, 'Unesite naslov.').max(190), body: bodyField, attachmentPath: z.string().nullable().optional(),
    }).parse(req.body);
    await assertOwnUpload(pool, uid, body.attachmentPath);
    const threadId = uuid();
    await tx(async (db) => {
      await exec(db, 'INSERT INTO private_threads (id, building_id, resident_user_id, subject, resident_read_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [threadId, id, uid, body.subject, now(), now()]);
      await exec(db, 'INSERT INTO private_messages (id, thread_id, sender_user_id, body, attachment_path, created_at) VALUES (?, ?, ?, ?, ?, ?)', [uuid(), threadId, uid, body.body, body.attachmentPath ?? null, now()]);
    });
    notifyOther({ id: threadId, building_id: id, resident_user_id: uid } as Row, access, 'Nova privatna poruka', body.subject);
    return { id: threadId };
  });

  app.get('/threads/:id', async (req) => {
    const uid = userId(req);
    const { thread, access } = await threadAccess(uid, (req.params as { id: string }).id);
    await exec(pool, `UPDATE private_threads SET ${access.role === 'manager' ? 'manager_read_at' : 'resident_read_at'} = ? WHERE id = ?`, [now(), thread.id]);
    const messages = await rows(pool, 'SELECT m.*, u.full_name FROM private_messages m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.thread_id = ? ORDER BY m.created_at', [thread.id]);
    const resident = await one(pool, 'SELECT full_name FROM users WHERE id = ?', [thread.resident_user_id]);
    return {
      id: thread.id, buildingId: thread.building_id, subject: thread.subject, status: thread.status, residentName: resident?.full_name ?? null,
      convertedIssueId: thread.converted_issue_id, conversionRequestedAt: thread.conversion_requested_at,
      conversionConsentedAt: thread.conversion_consented_at, conversionDeclinedAt: thread.conversion_declined_at, viewerRole: access.role,
      messages: await Promise.all(messages.map(async (m) => ({
        id: m.id, body: m.body, createdAt: m.created_at, senderName: m.full_name, mine: m.sender_user_id === uid, attachment: await fileInfo(pool, m.attachment_path),
      }))),
    };
  });

  app.post('/threads/:id/messages', async (req) => {
    const uid = userId(req);
    const { thread, access } = await threadAccess(uid, (req.params as { id: string }).id);
    const body = z.object({ body: bodyField, attachmentPath: z.string().nullable().optional() }).parse(req.body);
    await assertOwnUpload(pool, uid, body.attachmentPath);
    if (thread.status === 'closed') throw conflict('closed', 'Razgovor je zatvoren.');
    const id = uuid();
    await exec(pool, 'INSERT INTO private_messages (id, thread_id, sender_user_id, body, attachment_path, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, thread.id, uid, body.body, body.attachmentPath ?? null, now()]);
    notifyOther(thread, access, thread.subject, body.body.slice(0, 120));
    return { id };
  });

  app.post('/threads/:id/close', async (req) => {
    const uid = userId(req);
    const { thread, access } = await threadAccess(uid, (req.params as { id: string }).id);
    await exec(pool, "UPDATE private_threads SET status = 'closed' WHERE id = ?", [thread.id]);
    notifyOther(thread, access, thread.subject, 'Razgovor je zatvoren.');
    return { ok: true };
  });

  // Javni problem nastaje tek posle pristanka stanara.
  app.post('/threads/:id/request-conversion', async (req) => {
    const uid = userId(req);
    const { thread, access } = await threadAccess(uid, (req.params as { id: string }).id);
    if (access.role !== 'manager') throw forbidden('Ovo može samo upravnik.');
    if (thread.converted_issue_id) throw conflict('converted', 'Već je pretvoreno u javni problem.');
    await exec(pool, 'UPDATE private_threads SET conversion_requested_at = ?, conversion_declined_at = NULL WHERE id = ?', [now(), thread.id]);
    notifyOther(thread, access, 'Zahtev za javni problem', thread.subject);
    return { ok: true };
  });

  app.post('/threads/:id/respond-conversion', async (req) => {
    const uid = userId(req);
    const { thread, access } = await threadAccess(uid, (req.params as { id: string }).id);
    if (thread.resident_user_id !== uid) throw forbidden('Odluku donosi autor poruke.');
    const body = z.object({
      accept: z.boolean(), isAnonymous: z.boolean().default(false),
      location: z.enum(['ulaz', 'lift', 'stepeniste', 'krov', 'podrum', 'fasada', 'parking', 'ostalo']).default('ostalo'),
      urgency: z.enum(['low', 'medium', 'high']).default('medium'),
    }).parse(req.body);
    if (!thread.conversion_requested_at || thread.conversion_consented_at || thread.conversion_declined_at) throw badRequest('no_request', 'Nema zahteva na čekanju.');
    if (!body.accept) {
      await exec(pool, 'UPDATE private_threads SET conversion_declined_at = ? WHERE id = ?', [now(), thread.id]);
      notifyOther(thread, access, thread.subject, 'Stanar nije prihvatio objavljivanje.');
      return { ok: true };
    }
    const first = await one(pool, 'SELECT body FROM private_messages WHERE thread_id = ? ORDER BY created_at LIMIT 1', [thread.id]);
    const issueId = uuid();
    await tx(async (db) => {
      await exec(
        db,
        'INSERT INTO issues (id, building_id, title, description, location, urgency, reporter_user_id, reporter_apartment_id, is_anonymous, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [issueId, thread.building_id, thread.subject, first?.body ?? thread.subject, body.location, body.urgency, uid, access.apartmentId, body.isAnonymous ? 1 : 0, now()],
      );
      await addEvent(db, issueId, 'reported', uid, { photos: 0 });
      await exec(db, 'UPDATE private_threads SET conversion_consented_at = ?, converted_issue_id = ? WHERE id = ?', [now(), issueId, thread.id]);
    });
    toBuilding(thread.building_id, 'issues');
    notifyOther(thread, access, thread.subject, 'Stanar je prihvatio: problem je objavljen.');
    return { issueId };
  });
}
