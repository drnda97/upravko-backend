import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { exec, one, pool, rows, tx, uuid, type Db } from '../db.js';
import { buildingAccess, requireManager } from '../lib/access.js';
import { randomToken, sha256, userId } from '../lib/auth.js';
import { brandOf } from '../lib/brand.js';
import { balance, overdueTotal, reservations } from '../lib/budget.js';
import { localDate, now } from '../lib/clock.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { assertOwnUpload, signedUrl } from '../lib/files.js';
import { isValidAccount } from '../lib/ips.js';
import { sendMail } from '../lib/mail.js';
import { pushLater } from '../lib/push.js';
import { toBuilding, toUsers } from '../lib/realtime.js';
import { listIssues, voteSummary } from './issues.js';
import { listAnnouncements } from './announcements.js';

const money = z.coerce.number().min(0).max(1e10);

export const buildingInput = z.object({
  address: z.string().trim().min(3, 'Unesite adresu.').max(190),
  city: z.string().trim().min(2, 'Unesite grad.').max(100),
  apartmentsCount: z.coerce.number().int().min(1, 'Unesite broj stanova.').max(1000),
  feeAmount: money.default(0),
  feeMode: z.enum(['per_apartment', 'per_m2']).default('per_apartment'),
  feeDayOfMonth: z.coerce.number().int().min(1).max(28).default(1),
  paymentMode: z.enum(['direct', 'infostan']).default('direct'),
  currency: z.enum(['RSD', 'EUR', 'USD']).default('RSD'),
  bankAccount: z.string().regex(/^\d{18}$/, 'Račun ima 18 cifara.').optional().nullable(),
  recipientName: z.string().trim().max(70).optional().nullable(),
});

const newCode = () => randomBytes(4).toString('hex').toUpperCase();
export const newInviteToken = () => randomBytes(12).toString('base64url');

export async function createBuilding(db: Db, organizationId: string, managerId: string, b: z.infer<typeof buildingInput>) {
  const id = uuid();
  await exec(
    db,
    `INSERT INTO buildings (id, organization_id, address, city, apartments_count, currency, fee_mode, fee_amount, fee_day_of_month, payment_mode, bank_account, recipient_name, building_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, organizationId, b.address, b.city, b.apartmentsCount, b.currency, b.feeMode, b.feeAmount, b.feeDayOfMonth, b.paymentMode,
      b.bankAccount ?? null, b.recipientName ?? `SZ ${b.address}`, newCode(), now()],
  );
  await exec(db, 'INSERT INTO apartments (id, building_id, number) VALUES ?', [
    Array.from({ length: b.apartmentsCount }, (_, i) => [uuid(), id, i + 1]),
  ]);
  await exec(db, 'INSERT INTO building_managers (building_id, user_id, created_at) VALUES (?, ?, ?)', [id, managerId, now()]);
  await exec(db, 'INSERT INTO building_invite_codes (id, building_id, token, created_at) VALUES (?, ?, ?, ?)', [uuid(), id, newInviteToken(), now()]);
  return id;
}

async function buildingCard(id: string, access: 'manager' | 'resident') {
  const b = await one(pool, 'SELECT * FROM buildings WHERE id = ?', [id]);
  const stats = await one(
    pool,
    `SELECT SUM(status NOT IN ('resolved', 'rejected')) AS open_issues,
            SUM(status NOT IN ('resolved', 'rejected') AND urgency = 'high') AS urgent_issues,
            MAX(CASE WHEN status NOT IN ('resolved', 'rejected') AND urgency = 'high' THEN 1 ELSE 0 END) AS has_urgent
     FROM issues WHERE building_id = ?`,
    [id],
  );
  const pending = access === 'manager' ? await one(pool, "SELECT COUNT(*) AS n FROM memberships WHERE building_id = ? AND status = 'pending'", [id]) : null;
  return {
    id: b!.id, address: b!.address, city: b!.city, apartmentsCount: b!.apartments_count, currency: b!.currency,
    coverUrl: signedUrl(b!.cover_image_path), balance: await balance(pool, id),
    openIssues: Number(stats?.open_issues ?? 0), urgentIssues: Number(stats?.urgent_issues ?? 0),
    pendingRequests: pending ? Number(pending.n) : 0,
  };
}

export async function buildingRoutes(app: FastifyInstance) {
  // Kartice za izbor zgrade (ekrani 04 i 13).
  app.get('/buildings', async (req) => {
    const uid = userId(req);
    const managed = await rows(pool, 'SELECT m.building_id FROM building_managers m JOIN buildings b ON b.id = m.building_id WHERE m.user_id = ? ORDER BY b.created_at, b.address', [uid]);
    const member = await rows(
      pool,
      `SELECT m.building_id, m.role, a.number FROM memberships m JOIN apartments a ON a.id = m.apartment_id JOIN buildings b ON b.id = m.building_id
       WHERE m.user_id = ? AND m.status = 'approved' ORDER BY b.address, a.number`,
      [uid],
    );
    return {
      managed: await Promise.all(managed.map((m) => buildingCard(m.building_id, 'manager'))),
      resident: await Promise.all(member.map(async (m) => ({ ...(await buildingCard(m.building_id, 'resident')), role: m.role, apartmentNumber: m.number }))),
    };
  });

  app.post('/buildings', async (req) => {
    const uid = userId(req);
    const body = buildingInput.parse(req.body);
    if (body.bankAccount && !isValidAccount(body.bankAccount)) throw badRequest('bad_account', 'Broj računa nije ispravan.');
    const org = await one(pool, 'SELECT b.organization_id FROM building_managers m JOIN buildings b ON b.id = m.building_id WHERE m.user_id = ? LIMIT 1', [uid]);
    if (!org) throw badRequest('not_manager', 'Zgradu može da doda samo upravnik.');
    const id = await tx((db) => createBuilding(db, org.organization_id, uid, body));
    return { id };
  });

  app.get('/buildings/:id', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    const access = await buildingAccess(uid, id);
    const b = await one(pool, 'SELECT b.*, o.name, o.logo_variant, o.logo_url, o.color_primary, o.color_primary_dark, o.color_secondary, o.color_accent FROM buildings b JOIN organizations o ON o.id = b.organization_id WHERE b.id = ?', [id]);
    const manager = await one(pool, 'SELECT u.full_name FROM building_managers m JOIN users u ON u.id = m.user_id WHERE m.building_id = ? LIMIT 1', [id]);
    return {
      id: b!.id, address: b!.address, city: b!.city, apartmentsCount: b!.apartments_count, currency: b!.currency,
      coverUrl: signedUrl(b!.cover_image_path), feeMode: b!.fee_mode, feeAmount: b!.fee_amount, feeDayOfMonth: b!.fee_day_of_month,
      paymentMode: b!.payment_mode, bankAccount: b!.bank_account, recipientName: b!.recipient_name,
      brand: brandOf(b!), managerName: manager?.full_name ?? null, role: access.role, apartmentNumber: access.apartmentNumber,
    };
  });

  app.patch('/buildings/:id', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    await requireManager(uid, id);
    const body = z.object({
      address: z.string().trim().min(3).max(190), city: z.string().trim().min(2).max(100), currency: z.enum(['RSD', 'EUR', 'USD']),
      feeMode: z.enum(['per_apartment', 'per_m2']), feeAmount: money, feeDayOfMonth: z.coerce.number().int().min(1).max(28),
      paymentMode: z.enum(['direct', 'infostan']), bankAccount: z.string().regex(/^\d{18}$/, 'Račun ima 18 cifara.').nullable(),
      recipientName: z.string().trim().max(70).nullable(), coverPath: z.string().nullable(),
    }).partial().parse(req.body);
    if (body.bankAccount && !isValidAccount(body.bankAccount)) throw badRequest('bad_account', 'Broj računa nije ispravan.');
    await assertOwnUpload(pool, uid, body.coverPath);
    const cols: Record<string, unknown> = {
      address: body.address, city: body.city, currency: body.currency, fee_mode: body.feeMode, fee_amount: body.feeAmount,
      fee_day_of_month: body.feeDayOfMonth, payment_mode: body.paymentMode, bank_account: body.bankAccount,
      recipient_name: body.recipientName, cover_image_path: body.coverPath,
    };
    const entries = Object.entries(cols).filter(([, v]) => v !== undefined);
    await tx(async (db) => {
      if (entries.length) await exec(db, `UPDATE buildings SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
      // Infostan naplaćuje mimo aplikacije: otvorena zaduženja nisu dug prema zgradi.
      if (body.paymentMode === 'infostan') {
        await exec(db, 'UPDATE charges SET cancelled_at = ? WHERE building_id = ? AND paid_at IS NULL AND cancelled_at IS NULL', [now(), id]);
        await exec(db, "UPDATE payment_claims SET status = 'rejected', decided_by = ?, decided_at = ? WHERE building_id = ? AND status = 'pending'", [uid, now(), id]);
      }
    });
    toBuilding(id, 'budget');
    return { ok: true };
  });

  app.get('/buildings/:id/apartments', async (req) => {
    const { id } = req.params as { id: string };
    const access = await requireManager(userId(req), id);
    return rows(pool, 'SELECT id, number, area_m2 AS areaM2 FROM apartments WHERE building_id = ? ORDER BY number', [access.buildingId]);
  });

  // Sve što tabla prikazuje, jednim pozivom (ekrani 05 i 14).
  app.get('/buildings/:id/dashboard', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    const access = await buildingAccess(uid, id);
    const reserved = await reservations(pool, id);
    const last = await one(pool, "SELECT title, sign, amount, occurred_on FROM ledger_entries WHERE building_id = ? AND apartment_id IS NULL AND type <> 'opening' ORDER BY occurred_on DESC, created_at DESC LIMIT 1", [id]);
    const session = await one(
      pool,
      `SELECT s.id, s.issue_id FROM votes_sessions s JOIN issues i ON i.id = s.issue_id
       WHERE i.building_id = ? AND s.closed_at IS NULL ORDER BY s.deadline LIMIT 1`,
      [id],
    );
    const issues = await listIssues(access, 'open');
    const announcements = (await listAnnouncements(access)).slice(0, 3);
    const manager = access.role === 'manager' ? {
      pending: await rows(pool, `SELECT u.full_name AS fullName, m.created_at AS createdAt FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.building_id = ? AND m.status = 'pending' ORDER BY m.created_at`, [id]),
      pendingClaims: Number((await one(pool, "SELECT COUNT(*) AS n FROM payment_claims WHERE building_id = ? AND status = 'pending'", [id]))?.n ?? 0),
      unreadThreads: Number((await one(pool, `SELECT COUNT(*) AS n FROM private_threads t WHERE t.building_id = ? AND t.status = 'open' AND EXISTS (SELECT 1 FROM private_messages p WHERE p.thread_id = t.id AND p.sender_user_id = t.resident_user_id AND (t.manager_read_at IS NULL OR p.created_at > t.manager_read_at))`, [id]))?.n ?? 0),
    } : null;
    return {
      budget: {
        balance: await balance(pool, id),
        reserved: reserved.reduce((sum, r) => sum + r.amount, 0),
        lastChange: last ? { title: last.title, amount: last.sign * last.amount, occurredOn: last.occurred_on } : null,
      },
      vote: session ? await voteSummary(session.id, access) : null,
      issues,
      announcements,
      overdueTotal: await overdueTotal(pool, id),
      manager,
    };
  });

  // Zahtevi za pristup (ekran 15).
  app.get('/buildings/:id/memberships', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    await requireManager(uid, id);
    const { status } = z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }).parse(req.query);
    const list = await rows(
      pool,
      `SELECT m.id, m.role, m.status, m.created_at, m.apartment_id, a.number, u.full_name, u.phone, u.email,
        (SELECT ou.full_name FROM memberships o JOIN users ou ON ou.id = o.user_id
          WHERE o.apartment_id = m.apartment_id AND o.role = 'owner' AND o.status = 'approved' AND o.id <> m.id LIMIT 1) AS existing_owner
       FROM memberships m JOIN apartments a ON a.id = m.apartment_id JOIN users u ON u.id = m.user_id
       WHERE m.building_id = ? AND m.status = ? ORDER BY ${status === 'pending' ? 'm.created_at' : 'a.number'}`,
      [id, status],
    );
    const counts = await rows(pool, 'SELECT status, COUNT(*) AS n FROM memberships WHERE building_id = ? GROUP BY status', [id]);
    return {
      items: list.map((m) => ({
        id: m.id, role: m.role, status: m.status, createdAt: m.created_at, apartmentNumber: m.number, fullName: m.full_name,
        phone: m.phone, email: m.email, ownerConflict: m.role === 'owner' ? m.existing_owner : null,
      })),
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    };
  });

  const decide = (status: 'approved' | 'rejected') => async (req: any) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    const m = await one(pool, 'SELECT m.*, b.address FROM memberships m JOIN buildings b ON b.id = m.building_id WHERE m.id = ?', [id]);
    if (!m) throw notFound();
    await requireManager(uid, m.building_id);
    if (m.status !== 'pending') throw conflict('already_decided', 'O ovom zahtevu je već odlučeno.');
    await exec(pool, 'UPDATE memberships SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', [status, uid, now(), id]);
    toUsers([m.user_id], 'memberships');
    toBuilding(m.building_id, 'memberships');
    if (status === 'approved') pushLater([m.user_id], { title: 'Pristup je odobren', body: m.address, data: { screen: 'home', buildingId: m.building_id } });
    return { ok: true };
  };
  app.post('/memberships/:id/approve', decide('approved'));
  app.post('/memberships/:id/reject', decide('rejected'));

  // Upravnik ručno dodaje stanara (ekran 16): pristup je odmah odobren.
  app.post('/buildings/:id/residents', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    await requireManager(uid, id);
    const body = z.object({
      fullName: z.string().trim().min(2, 'Unesite ime i prezime.').max(120),
      phone: z.string().trim().max(40).optional().nullable(),
      email: z.string().trim().toLowerCase().email('Unesite ispravan e-mail.'),
      apartmentId: z.string().uuid('Izaberite stan.'),
      role: z.enum(['owner', 'tenant']),
    }).parse(req.body);
    const apartment = await one(pool, 'SELECT id FROM apartments WHERE id = ? AND building_id = ?', [body.apartmentId, id]);
    if (!apartment) throw badRequest('bad_apartment', 'Izaberite stan iz liste.');
    const token = randomToken();
    const isNew = await tx(async (db) => {
      const existing = await one(db, 'SELECT id FROM users WHERE email = ?', [body.email]);
      const residentId = existing?.id ?? uuid();
      if (!existing) await exec(db, 'INSERT INTO users (id, email, full_name, phone, created_at) VALUES (?, ?, ?, ?, ?)', [residentId, body.email, body.fullName, body.phone ?? null, now()]);
      if (await one(db, "SELECT 1 AS ok FROM memberships WHERE apartment_id = ? AND user_id = ? AND status = 'approved'", [body.apartmentId, residentId])) {
        throw conflict('already_member', 'Ovaj stanar je već u tom stanu.');
      }
      await exec(db, "INSERT INTO memberships (id, building_id, apartment_id, user_id, role, status, decided_by, decided_at, created_at) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?)", [uuid(), id, body.apartmentId, residentId, body.role, uid, now(), now()]);
      if (!existing) await exec(db, "INSERT INTO password_tokens (id, user_id, token_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, 'invite', ?, ?)", [uuid(), residentId, sha256(token), new Date(Date.now() + 14 * 86400_000), new Date()]);
      return !existing;
    });
    if (isNew) await sendMail(body.email, 'Pozivnica za Upravko', `Dodati ste u zgradu. Postavite lozinku (link važi 14 dana):\n${config.appLink}set-password/${token}`);
    toBuilding(id, 'memberships');
    return { ok: true };
  });

  // QR kod zgrade (ekran 17).
  app.get('/buildings/:id/invite', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    await requireManager(uid, id);
    const invite = await one(pool, 'SELECT * FROM building_invite_codes WHERE building_id = ? AND active = 1 LIMIT 1', [id]);
    if (!invite) throw notFound();
    const count = await one(pool, 'SELECT COUNT(*) AS n FROM memberships WHERE invite_code_id = ?', [invite.id]);
    return { token: invite.token, link: `${config.appLink}join/${invite.token}`, createdAt: invite.created_at, registrations: Number(count?.n ?? 0) };
  });

  app.post('/buildings/:id/invite/rotate', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    await requireManager(uid, id);
    await tx(async (db) => {
      await exec(db, 'UPDATE building_invite_codes SET active = 0, revoked_at = ? WHERE building_id = ? AND active = 1', [now(), id]);
      await exec(db, 'INSERT INTO building_invite_codes (id, building_id, token, created_at) VALUES (?, ?, ?, ?)', [uuid(), id, newInviteToken(), now()]);
    });
    return { ok: true };
  });

  // Servisi (ekran 22) su zajednički za organizaciju.
  const orgOf = async (buildingId: string) => (await one(pool, 'SELECT organization_id FROM buildings WHERE id = ?', [buildingId]))!.organization_id as string;
  const serviceInput = z.object({
    category: z.enum(['lift', 'zelenilo', 'ciscenje', 'elektricar', 'vodoinstalater', 'grejanje']),
    company: z.string().trim().min(2, 'Unesite naziv firme.').max(190),
    contactPerson: z.string().trim().max(120).optional().nullable(),
    phone: z.string().trim().max(40).optional().nullable(),
    email: z.string().trim().email('Unesite ispravan e-mail.').optional().nullable().or(z.literal('').transform(() => null)),
  });

  app.get('/buildings/:id/services', async (req) => {
    const { id } = req.params as { id: string };
    await requireManager(userId(req), id);
    return rows(pool, 'SELECT id, category, company, contact_person AS contactPerson, phone, email FROM service_providers WHERE organization_id = ? ORDER BY created_at', [await orgOf(id)]);
  });

  app.post('/buildings/:id/services', async (req) => {
    const { id } = req.params as { id: string };
    await requireManager(userId(req), id);
    const b = serviceInput.parse(req.body);
    const serviceId = uuid();
    await exec(pool, 'INSERT INTO service_providers (id, organization_id, category, company, contact_person, phone, email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [serviceId, await orgOf(id), b.category, b.company, b.contactPerson ?? null, b.phone ?? null, b.email ?? null, now()]);
    return { id: serviceId };
  });

  app.patch('/buildings/:id/services/:serviceId', async (req) => {
    const { id, serviceId } = req.params as { id: string; serviceId: string };
    await requireManager(userId(req), id);
    const b = serviceInput.parse(req.body);
    const result = await exec(pool, 'UPDATE service_providers SET category = ?, company = ?, contact_person = ?, phone = ?, email = ? WHERE id = ? AND organization_id = ?', [b.category, b.company, b.contactPerson ?? null, b.phone ?? null, b.email ?? null, serviceId, await orgOf(id)]);
    if (!result.affectedRows) throw notFound();
    return { ok: true };
  });

  // Podsećanje dužnika (ekran 20) ide samo tom stanu.
  app.post('/buildings/:id/apartments/:apartmentId/remind', async (req) => {
    const { id, apartmentId } = req.params as { id: string; apartmentId: string };
    await requireManager(userId(req), id);
    const owed = await one(pool, 'SELECT COALESCE(SUM(amount), 0) AS total FROM charges WHERE building_id = ? AND apartment_id = ? AND paid_at IS NULL AND cancelled_at IS NULL AND due_date < ?', [id, apartmentId, localDate()]);
    const users = await rows(pool, "SELECT user_id FROM memberships WHERE apartment_id = ? AND status = 'approved'", [apartmentId]);
    pushLater(users.map((u) => u.user_id), { title: 'Podsetnik za uplatu', body: `Dospeli dug: ${Number(owed?.total ?? 0)} RSD`, urgent: true, data: { screen: 'budget', buildingId: id } });
    return { ok: true };
  });
}
