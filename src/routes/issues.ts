import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exec, one, pool, rows, tx, uuid, type Db, type Row } from '../db.js';
import { buildingAccess, issueOr404, managerIds, requireManager, requireResident, residentIds, type Access } from '../lib/access.js';
import { userId } from '../lib/auth.js';
import { addEntry, balance, leadingOffer } from '../lib/budget.js';
import { localDate, now } from '../lib/clock.js';
import { addEvent } from '../lib/events.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { assertOwnUpload, fileInfo, signedUrl } from '../lib/files.js';
import { pushLater } from '../lib/push.js';
import { toBuilding } from '../lib/realtime.js';

const OPEN = "('reported','received','offers','voting','planned','in_progress')";
const STATUS_LABEL: Record<string, string> = {
  reported: 'Prijavljen', received: 'Primljen', offers: 'Ponude', voting: 'Glasanje', planned: 'U planu',
  in_progress: 'U radu', resolved: 'Rešen', rejected: 'Odbijen',
};

const url = (photos: Row[]) => photos.map((p) => signedUrl(p.path));

/** Anonimnost: stanari nikad ne dobijaju podatke prijavioca, ni u sirovom odgovoru. */
function reporterFor(i: Row, access: Access) {
  const hidden = i.is_anonymous && access.role !== 'manager' && i.reporter_user_id !== access.userId;
  if (hidden) return { name: null, apartmentNumber: null, anonymous: true };
  return { name: i.reporter_name ?? null, apartmentNumber: i.reporter_number ?? null, anonymous: !!i.is_anonymous };
}

export async function listIssues(access: Access, filter: 'open' | 'resolved' | 'all') {
  const where = filter === 'open' ? `AND i.status IN ${OPEN}` : filter === 'resolved' ? "AND i.status IN ('resolved', 'rejected')" : '';
  const list = await rows(
    pool,
    `SELECT i.*, u.full_name AS reporter_name, a.number AS reporter_number,
      (SELECT COUNT(*) FROM issue_hurries h WHERE h.issue_id = i.id) AS hurries,
      (SELECT path FROM issue_photos p WHERE p.issue_id = i.id AND p.kind = 'report' ORDER BY p.sort LIMIT 1) AS photo
     FROM issues i LEFT JOIN users u ON u.id = i.reporter_user_id LEFT JOIN apartments a ON a.id = i.reporter_apartment_id
     WHERE i.building_id = ? ${where}
     ORDER BY i.status IN ('resolved', 'rejected'), FIELD(i.urgency, 'high', 'medium', 'low'), hurries DESC, i.created_at DESC`,
    [access.buildingId],
  );
  const mine = access.apartmentId
    ? new Set((await rows(pool, 'SELECT issue_id FROM issue_hurries WHERE apartment_id = ?', [access.apartmentId])).map((r) => r.issue_id))
    : new Set();
  return list.map((i) => ({
    id: i.id, title: i.title, location: i.location, urgency: i.urgency, status: i.status, createdAt: i.created_at,
    photoUrl: signedUrl(i.photo), hurries: Number(i.hurries), hurriedByMe: mine.has(i.id), reporter: reporterFor(i, access),
  }));
}

/** Rezultati su uvek vidljivi svima u zgradi. */
export async function voteSummary(sessionId: string, access: Access) {
  const s = await one(pool, 'SELECT s.*, COALESCE(i.short_title, i.title) AS issue_title, i.building_id FROM votes_sessions s JOIN issues i ON i.id = s.issue_id WHERE s.id = ?', [sessionId]);
  if (!s) return null;
  const building = await one(pool, 'SELECT apartments_count FROM buildings WHERE id = ?', [s.building_id]);
  const results = await rows(
    pool,
    `SELECT o.id, o.contractor, o.price, o.duration_days, o.pdf_path, o.note, COUNT(v.apartment_id) AS votes
     FROM offers o LEFT JOIN votes v ON v.offer_id = o.id AND v.session_id = ?
     WHERE o.issue_id = ? AND o.withdrawn_at IS NULL GROUP BY o.id ORDER BY o.created_at`,
    [sessionId, s.issue_id],
  );
  const myVote = access.apartmentId ? await one(pool, 'SELECT offer_id FROM votes WHERE session_id = ? AND apartment_id = ?', [sessionId, access.apartmentId]) : null;
  const total = results.reduce((sum, r) => sum + Number(r.votes), 0);
  const lead = [...results].sort((a, b) => Number(b.votes) - Number(a.votes) || a.price - b.price)[0];
  return {
    id: s.id, issueId: s.issue_id, issueTitle: s.issue_title, deadline: s.deadline, majorityRule: s.majority_rule,
    closedAt: s.closed_at, winnerOfferId: s.winner_offer_id, apartmentsCount: building!.apartments_count, totalVotes: total,
    leaderOfferId: lead?.id ?? null, leaderName: lead?.contractor ?? null, leaderVotes: Number(lead?.votes ?? 0),
    myOfferId: myVote?.offer_id ?? null,
    offers: results.map((r) => ({
      id: r.id, contractor: r.contractor, price: r.price, durationDays: r.duration_days, note: r.note,
      pdfUrl: signedUrl(r.pdf_path), votes: Number(r.votes),
    })),
  };
}

async function timeline(issue: Row, access: Access) {
  const events = await rows(
    pool,
    `SELECT e.*, u.full_name AS actor_name,
       EXISTS(SELECT 1 FROM building_managers bm WHERE bm.building_id = ? AND bm.user_id = e.actor_user_id) AS actor_manager,
       (SELECT a.number FROM memberships m JOIN apartments a ON a.id = m.apartment_id WHERE m.building_id = ? AND m.user_id = e.actor_user_id AND m.status = 'approved' ORDER BY a.number LIMIT 1) AS actor_number
     FROM issue_events e LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE e.issue_id = ? ORDER BY e.created_at DESC, e.id`,
    [issue.building_id, issue.building_id, issue.id],
  );
  const comments = new Map((await rows(pool, 'SELECT id, body FROM issue_comments WHERE issue_id = ?', [issue.id])).map((c) => [c.id, c.body]));
  return events.map((e) => {
    const payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload ?? {});
    // Događaj prijave kod anonimnog problema ne sme da otkrije ko je prijavio.
    const hideActor = e.type === 'reported' && issue.is_anonymous && access.role !== 'manager' && issue.reporter_user_id !== access.userId;
    return {
      id: e.id, type: e.type, createdAt: e.created_at, payload,
      body: e.type === 'comment' ? (comments.get(payload.commentId) ?? null) : null,
      actor: hideActor ? null : { name: e.actor_name, isManager: !!e.actor_manager, apartmentNumber: e.actor_number ?? null },
    };
  });
}

async function issueDetail(issue: Row, access: Access) {
  const reporter = await one(
    pool,
    'SELECT u.full_name AS reporter_name, a.number AS reporter_number FROM issues i LEFT JOIN users u ON u.id = i.reporter_user_id LEFT JOIN apartments a ON a.id = i.reporter_apartment_id WHERE i.id = ?',
    [issue.id],
  );
  const photos = await rows(pool, 'SELECT path, kind FROM issue_photos WHERE issue_id = ? ORDER BY sort', [issue.id]);
  const hurries = await one(pool, 'SELECT COUNT(*) AS n FROM issue_hurries WHERE issue_id = ?', [issue.id]);
  const hurried = access.apartmentId ? await one(pool, 'SELECT 1 AS ok FROM issue_hurries WHERE issue_id = ? AND apartment_id = ?', [issue.id, access.apartmentId]) : null;
  const offers = await rows(pool, 'SELECT * FROM offers WHERE issue_id = ? ORDER BY created_at', [issue.id]);
  const session = await one(pool, 'SELECT id FROM votes_sessions WHERE issue_id = ? ORDER BY opened_at DESC LIMIT 1', [issue.id]);
  const expense = await one(pool, "SELECT * FROM ledger_entries WHERE issue_id = ? AND type = 'expense' ORDER BY created_at DESC LIMIT 1", [issue.id]);
  const chosen = offers.find((o) => o.id === issue.chosen_offer_id);
  let resolution = null;
  if (expense) {
    const after = await one(pool, 'SELECT COALESCE(SUM(sign * amount), 0) AS total FROM ledger_entries WHERE building_id = ? AND created_at <= ?', [issue.building_id, expense.created_at]);
    resolution = {
      amount: expense.amount, balanceAfter: Number(after?.total ?? 0), invoice: await fileInfo(pool, expense.invoice_path),
      votes: null as null | { winner: number; total: number },
    };
    if (session && issue.chosen_offer_id) {
      const v = await one(pool, 'SELECT COUNT(*) AS total, SUM(offer_id = ?) AS winner FROM votes WHERE session_id = ?', [issue.chosen_offer_id, session.id]);
      if (Number(v?.total)) resolution.votes = { winner: Number(v?.winner), total: Number(v?.total) };
    }
  }
  return {
    id: issue.id, buildingId: issue.building_id, title: issue.title, description: issue.description, location: issue.location,
    urgency: issue.urgency, status: issue.status, createdAt: issue.created_at, resolvedAt: issue.resolved_at, rejectedReason: issue.rejected_reason,
    reporter: reporterFor({ ...issue, ...reporter }, access),
    photos: url(photos.filter((p) => p.kind === 'report')), afterPhotos: url(photos.filter((p) => p.kind === 'after_fix')),
    hurries: Number(hurries?.n ?? 0), hurriedByMe: !!hurried,
    offers: offers.filter((o) => !o.withdrawn_at).map((o) => ({ id: o.id, contractor: o.contractor, price: o.price, durationDays: o.duration_days, note: o.note, pdfUrl: signedUrl(o.pdf_path) })),
    chosenOffer: chosen ? { id: chosen.id, contractor: chosen.contractor, price: chosen.price } : null,
    vote: session ? await voteSummary(session.id, access) : null,
    resolution,
    timeline: await timeline(issue, access),
    viewerRole: access.role,
  };
}

/** Obaveštava prijavioca i sve koji su požurili. */
async function issueFollowers(issue: Row, exclude: string) {
  const list = await rows(pool, 'SELECT user_id FROM issue_hurries WHERE issue_id = ? AND user_id IS NOT NULL', [issue.id]);
  const ids = new Set(list.map((r) => r.user_id as string));
  if (issue.reporter_user_id) ids.add(issue.reporter_user_id);
  ids.delete(exclude);
  return [...ids];
}

const changed = (issue: Row) => {
  toBuilding(issue.building_id, 'issue', issue.id);
  toBuilding(issue.building_id, 'issues');
};

/** Zatvaranje glasanja: pobednik po pravilu većine; 'planned' ili povratak na ponude. */
export async function closeSession(db: Db, sessionId: string, opts: { forcedWinner?: string } = {}) {
  const s = await one(db, 'SELECT s.*, i.building_id, i.status FROM votes_sessions s JOIN issues i ON i.id = s.issue_id WHERE s.id = ? AND s.closed_at IS NULL FOR UPDATE', [sessionId]);
  if (!s) return null;
  const lead = await leadingOffer(db, sessionId, s.issue_id);
  const votes = Number(lead?.votes ?? 0);
  const building = await one(db, 'SELECT apartments_count FROM buildings WHERE id = ?', [s.building_id]);
  const passes = s.majority_rule === 'two_thirds' ? votes * 3 >= building!.apartments_count * 2 : votes > 0;
  const winner = opts.forcedWinner ?? (passes ? lead!.id : null);
  await exec(db, 'UPDATE votes_sessions SET closed_at = ?, winner_offer_id = ? WHERE id = ?', [now(), winner, sessionId]);
  await addEvent(db, s.issue_id, 'vote_closed', null, { winner: lead?.contractor ?? null, passed: !!winner });
  if (!opts.forcedWinner) {
    const status = winner ? 'planned' : 'offers';
    await exec(db, 'UPDATE issues SET status = ?, chosen_offer_id = ? WHERE id = ?', [status, winner, s.issue_id]);
    await addEvent(db, s.issue_id, 'status_changed', null, { from: 'voting', to: status });
  }
  return { buildingId: s.building_id as string, issueId: s.issue_id as string, winner };
}

export async function issueRoutes(app: FastifyInstance) {
  app.get('/buildings/:id/issues', async (req) => {
    const { id } = req.params as { id: string };
    const access = await buildingAccess(userId(req), id);
    const { filter } = z.object({ filter: z.enum(['open', 'resolved', 'all']).default('open') }).parse(req.query);
    return {
      items: await listIssues(access, filter),
      counts: Object.fromEntries(
        (await rows(pool, `SELECT CASE WHEN status IN ${OPEN} THEN 'open' ELSE 'resolved' END AS k, COUNT(*) AS n FROM issues WHERE building_id = ? GROUP BY k`, [id])).map((r) => [r.k, Number(r.n)]),
      ),
    };
  });

  const issueInput = z.object({
    title: z.string().trim().min(3, 'Unesite kratak naslov.').max(190),
    description: z.string().trim().min(5, 'Opišite problem.').max(5000),
    location: z.enum(['ulaz', 'lift', 'stepeniste', 'krov', 'podrum', 'fasada', 'parking', 'ostalo']),
    urgency: z.enum(['low', 'medium', 'high']),
    isAnonymous: z.boolean().default(false),
    photos: z.array(z.string()).max(6, 'Najviše 6 slika.').default([]),
  });

  app.post('/buildings/:id/issues', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    const access = await buildingAccess(uid, id);
    const body = issueInput.parse(req.body);
    for (const p of body.photos) await assertOwnUpload(pool, uid, p);
    const issueId = uuid();
    await tx(async (db) => {
      await exec(
        db,
        'INSERT INTO issues (id, building_id, title, description, location, urgency, reporter_user_id, reporter_apartment_id, is_anonymous, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [issueId, id, body.title, body.description, body.location, body.urgency, uid, access.apartmentId, body.isAnonymous ? 1 : 0, now()],
      );
      for (const [i, path] of body.photos.entries()) {
        await exec(db, 'INSERT INTO issue_photos (id, issue_id, path, kind, sort) VALUES (?, ?, ?, ?, ?)', [uuid(), issueId, path, 'report', i]);
      }
      await addEvent(db, issueId, 'reported', uid, { photos: body.photos.length });
    });
    toBuilding(id, 'issues');
    pushLater(await managerIds(id), { title: 'Nova prijava problema', body: body.title, urgent: body.urgency === 'high', data: { screen: 'issue', id: issueId } });
    return { id: issueId };
  });

  app.get('/issues/:id', async (req) => {
    const issue = await issueOr404((req.params as { id: string }).id);
    return issueDetail(issue, await buildingAccess(userId(req), issue.building_id));
  });

  app.patch('/issues/:id', async (req) => {
    const uid = userId(req);
    const issue = await issueOr404((req.params as { id: string }).id);
    await requireManager(uid, issue.building_id);
    const body = z.object({
      status: z.enum(['reported', 'received', 'offers', 'planned', 'in_progress']).optional(),
      urgency: z.enum(['low', 'medium', 'high']).optional(),
    }).parse(req.body);
    if (issue.status === 'resolved' || issue.status === 'rejected') throw conflict('closed', 'Problem je već zatvoren.');
    await tx(async (db) => {
      if (body.status && body.status !== issue.status) {
        if (issue.status === 'voting') throw conflict('voting', 'Glasanje je u toku. Status se menja kad se završi.');
        await exec(db, 'UPDATE issues SET status = ? WHERE id = ?', [body.status, issue.id]);
        await addEvent(db, issue.id, 'status_changed', uid, { from: issue.status, to: body.status });
      }
      if (body.urgency && body.urgency !== issue.urgency) {
        await exec(db, 'UPDATE issues SET urgency = ? WHERE id = ?', [body.urgency, issue.id]);
        await addEvent(db, issue.id, 'urgency_changed', uid, { from: issue.urgency, to: body.urgency });
      }
    });
    changed(issue);
    if (body.status && body.status !== issue.status) {
      pushLater(await issueFollowers(issue, uid), { title: issue.title, body: `Status: ${STATUS_LABEL[body.status]}`, data: { screen: 'issue', id: issue.id } });
    }
    return { ok: true };
  });

  app.post('/issues/:id/hurry', async (req) => {
    const uid = userId(req);
    const issue = await issueOr404((req.params as { id: string }).id);
    const access = await requireResident(uid, issue.building_id);
    if (issue.status === 'resolved' || issue.status === 'rejected') throw conflict('closed', 'Problem je zatvoren.');
    try {
      await exec(pool, 'INSERT INTO issue_hurries (issue_id, apartment_id, user_id, created_at) VALUES (?, ?, ?, ?)', [issue.id, access.apartmentId, uid, now()]);
    } catch (err: any) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict('already_hurried', 'Tvoj stan je već požurio.');
      throw err;
    }
    changed(issue);
    return { ok: true };
  });

  app.post('/issues/:id/comments', async (req) => {
    const uid = userId(req);
    const issue = await issueOr404((req.params as { id: string }).id);
    await buildingAccess(uid, issue.building_id);
    const { body } = z.object({ body: z.string().trim().min(1, 'Napišite komentar.').max(2000) }).parse(req.body);
    const commentId = uuid();
    await tx(async (db) => {
      await exec(db, 'INSERT INTO issue_comments (id, issue_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)', [commentId, issue.id, uid, body, now()]);
      await addEvent(db, issue.id, 'comment', uid, { commentId });
    });
    toBuilding(issue.building_id, 'issue', issue.id);
    return { id: commentId };
  });

  app.post('/issues/:id/offers', async (req) => {
    const uid = userId(req);
    const issue = await issueOr404((req.params as { id: string }).id);
    await requireManager(uid, issue.building_id);
    const body = z.object({
      contractor: z.string().trim().min(2, 'Unesite izvođača.').max(190),
      price: z.coerce.number().positive('Unesite cenu.').max(1e10),
      durationDays: z.coerce.number().int().positive('Unesite rok.').max(3650),
      pdfPath: z.string().nullable().optional(),
      note: z.string().trim().max(2000).nullable().optional(),
      photos: z.array(z.string()).max(6).default([]),
    }).parse(req.body);
    await assertOwnUpload(pool, uid, body.pdfPath);
    for (const p of body.photos) await assertOwnUpload(pool, uid, p);
    if (issue.status === 'resolved' || issue.status === 'rejected') throw conflict('closed', 'Problem je već zatvoren.');
    const offerId = uuid();
    await tx(async (db) => {
      await exec(db, 'INSERT INTO offers (id, issue_id, contractor, price, duration_days, pdf_path, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [offerId, issue.id, body.contractor, body.price, body.durationDays, body.pdfPath ?? null, body.note ?? null, uid, now()]);
      for (const [i, path] of body.photos.entries()) await exec(db, 'INSERT INTO offer_photos (id, offer_id, path, sort) VALUES (?, ?, ?, ?)', [uuid(), offerId, path, i]);
      await addEvent(db, issue.id, 'offer_added', uid, { contractor: body.contractor, price: body.price });
      if (issue.status === 'reported' || issue.status === 'received') {
        await exec(db, "UPDATE issues SET status = 'offers' WHERE id = ?", [issue.id]);
        await addEvent(db, issue.id, 'status_changed', uid, { from: issue.status, to: 'offers' });
      }
    });
    changed(issue);
    return { id: offerId };
  });

  app.post('/offers/:id/withdraw', async (req) => {
    const uid = userId(req);
    const offer = await one(pool, 'SELECT * FROM offers WHERE id = ?', [(req.params as { id: string }).id]);
    if (!offer) throw notFound();
    const issue = await issueOr404(offer.issue_id);
    await requireManager(uid, issue.building_id);
    await tx(async (db) => {
      await exec(db, 'UPDATE offers SET withdrawn_at = ? WHERE id = ? AND withdrawn_at IS NULL', [now(), offer.id]);
      await addEvent(db, issue.id, 'offer_withdrawn', uid, { contractor: offer.contractor });
    });
    changed(issue);
    return { ok: true };
  });

  app.post('/issues/:id/vote-session', async (req) => {
    const uid = userId(req);
    const issue = await issueOr404((req.params as { id: string }).id);
    await requireManager(uid, issue.building_id);
    const body = z.object({ deadline: z.coerce.date(), majorityRule: z.enum(['simple', 'two_thirds']) }).parse(req.body);
    if (body.deadline <= now()) throw badRequest('bad_deadline', 'Rok mora da bude u budućnosti.');
    const offers = await one(pool, 'SELECT COUNT(*) AS n FROM offers WHERE issue_id = ? AND withdrawn_at IS NULL', [issue.id]);
    if (Number(offers?.n) < 2) throw badRequest('need_offers', 'Dodaj bar dve ponude pa otvori glasanje.');
    if (await one(pool, 'SELECT 1 AS ok FROM votes_sessions WHERE issue_id = ? AND closed_at IS NULL', [issue.id])) throw conflict('already_open', 'Glasanje je već otvoreno.');
    const sessionId = uuid();
    await tx(async (db) => {
      await exec(db, 'INSERT INTO votes_sessions (id, issue_id, deadline, majority_rule, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?)', [sessionId, issue.id, body.deadline, body.majorityRule, uid, now()]);
      await exec(db, "UPDATE issues SET status = 'voting' WHERE id = ?", [issue.id]);
      await addEvent(db, issue.id, 'status_changed', uid, { from: issue.status, to: 'voting' });
      await addEvent(db, issue.id, 'vote_opened', uid, { deadline: body.deadline.toISOString() });
    });
    changed(issue);
    toBuilding(issue.building_id, 'budget');
    pushLater(await residentIds(issue.building_id), { title: 'Novo glasanje', body: issue.title, data: { screen: 'issue', id: issue.id } });
    return { id: sessionId };
  });

  // Glas može da se menja do roka; rok proverava server, ne klijent.
  app.post('/issues/:id/vote', async (req) => {
    const uid = userId(req);
    const issue = await issueOr404((req.params as { id: string }).id);
    const access = await requireResident(uid, issue.building_id);
    const { offerId } = z.object({ offerId: z.string().uuid() }).parse(req.body);
    const session = await one(pool, 'SELECT * FROM votes_sessions WHERE issue_id = ? AND closed_at IS NULL LIMIT 1', [issue.id]);
    if (!session || session.deadline <= now()) throw conflict('vote_closed', 'Glasanje je završeno. Glas više ne može da se menja.');
    const offer = await one(pool, 'SELECT 1 AS ok FROM offers WHERE id = ? AND issue_id = ? AND withdrawn_at IS NULL', [offerId, issue.id]);
    if (!offer) throw badRequest('bad_offer', 'Ponuda nije pronađena.');
    await exec(
      pool,
      'INSERT INTO votes (session_id, apartment_id, offer_id, voted_by_user_id, updated_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE offer_id = VALUES(offer_id), voted_by_user_id = VALUES(voted_by_user_id), updated_at = VALUES(updated_at)',
      [session.id, access.apartmentId, offerId, uid, now()],
    );
    changed(issue);
    toBuilding(issue.building_id, 'budget');
    return { ok: true };
  });

  app.post('/issues/:id/vote-session/remind', async (req) => {
    const uid = userId(req);
    const issue = await issueOr404((req.params as { id: string }).id);
    await requireManager(uid, issue.building_id);
    const session = await one(pool, 'SELECT id FROM votes_sessions WHERE issue_id = ? AND closed_at IS NULL', [issue.id]);
    if (!session) throw conflict('vote_closed', 'Nema aktivnog glasanja.');
    const missing = await rows(
      pool,
      `SELECT DISTINCT m.user_id FROM memberships m WHERE m.building_id = ? AND m.status = 'approved'
       AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.session_id = ? AND v.apartment_id = m.apartment_id)`,
      [issue.building_id, session.id],
    );
    pushLater(missing.map((m) => m.user_id), { title: 'Još niste glasali', body: issue.title, data: { screen: 'issue', id: issue.id } });
    return { reminded: missing.length };
  });

  app.post('/issues/:id/contact-service', async (req) => {
    const uid = userId(req);
    const issue = await issueOr404((req.params as { id: string }).id);
    await requireManager(uid, issue.building_id);
    const body = z.object({ serviceId: z.string().uuid(), channel: z.enum(['phone', 'email']) }).parse(req.body);
    const service = await one(
      pool,
      'SELECT s.company FROM service_providers s JOIN buildings b ON b.organization_id = s.organization_id WHERE s.id = ? AND b.id = ?',
      [body.serviceId, issue.building_id],
    );
    if (!service) throw notFound('Servis nije pronađen.');
    await addEvent(pool, issue.id, 'service_contacted', uid, { company: service.company, channel: body.channel });
    changed(issue);
    return { ok: true };
  });

  // Zatvaranje: slika posle, račun i iznos su obavezni; pravi se expense stavka.
  app.post('/issues/:id/resolve', async (req) => {
    const uid = userId(req);
    const issue = await issueOr404((req.params as { id: string }).id);
    await requireManager(uid, issue.building_id);
    const body = z.object({
      amount: z.coerce.number().positive('Unesite iznos sa računa.').max(1e10),
      invoicePath: z.string({ error: 'Račun je obavezan.' }).min(1, 'Račun je obavezan.'),
      photos: z.array(z.string()).min(1, 'Dodajte bar jednu sliku posle popravke.').max(6),
    }).parse(req.body);
    await assertOwnUpload(pool, uid, body.invoicePath);
    for (const p of body.photos) await assertOwnUpload(pool, uid, p);
    if (issue.status === 'resolved' || issue.status === 'rejected') throw conflict('closed', 'Problem je već zatvoren.');
    await tx(async (db) => {
      const open = await one(db, 'SELECT id FROM votes_sessions WHERE issue_id = ? AND closed_at IS NULL', [issue.id]);
      let chosen: string | null = issue.chosen_offer_id;
      if (open) {
        const lead = await leadingOffer(db, open.id, issue.id);
        chosen = lead?.id ?? null;
        await closeSession(db, open.id, { forcedWinner: chosen ?? undefined });
      }
      for (const [i, path] of body.photos.entries()) await exec(db, "INSERT INTO issue_photos (id, issue_id, path, kind, sort) VALUES (?, ?, ?, 'after_fix', ?)", [uuid(), issue.id, path, i]);
      await addEntry(db, { buildingId: issue.building_id, type: 'expense', sign: -1, amount: body.amount, title: issue.title, occurredOn: localDate(), issueId: issue.id, invoicePath: body.invoicePath, createdBy: uid });
      await exec(db, "UPDATE issues SET status = 'resolved', resolved_at = ?, chosen_offer_id = ? WHERE id = ?", [now(), chosen, issue.id]);
      await addEvent(db, issue.id, 'resolved', uid, { amount: body.amount, photos: body.photos.length });
    });
    changed(issue);
    toBuilding(issue.building_id, 'budget');
    pushLater(await issueFollowers(issue, uid), { title: issue.title, body: 'Problem je rešen.', data: { screen: 'issue', id: issue.id } });
    return { balance: await balance(pool, issue.building_id) };
  });

  app.post('/issues/:id/reject', async (req) => {
    const uid = userId(req);
    const issue = await issueOr404((req.params as { id: string }).id);
    await requireManager(uid, issue.building_id);
    const { reason } = z.object({ reason: z.string().trim().min(5, 'Unesite obrazloženje.').max(2000) }).parse(req.body);
    if (issue.status === 'resolved' || issue.status === 'rejected') throw conflict('closed', 'Problem je već zatvoren.');
    await tx(async (db) => {
      await exec(db, "UPDATE votes_sessions SET closed_at = ? WHERE issue_id = ? AND closed_at IS NULL", [now(), issue.id]);
      await exec(db, "UPDATE issues SET status = 'rejected', rejected_reason = ? WHERE id = ?", [reason, issue.id]);
      await addEvent(db, issue.id, 'rejected', uid, { reason });
    });
    changed(issue);
    toBuilding(issue.building_id, 'budget');
    pushLater(await issueFollowers(issue, uid), { title: issue.title, body: 'Prijava je odbijena.', data: { screen: 'issue', id: issue.id } });
    return { ok: true };
  });
}

