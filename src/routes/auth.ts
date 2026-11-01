import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { exec, one, pool, rows, tx, uuid, type Db } from '../db.js';
import { managerIds } from '../lib/access.js';
import { checkPassword, hashPassword, issueTokens, randomToken, revokeRefresh, rotateRefresh, sha256, userId } from '../lib/auth.js';
import { brandOf } from '../lib/brand.js';
import { now } from '../lib/clock.js';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors.js';
import { signedUrl } from '../lib/files.js';
import { isValidAccount } from '../lib/ips.js';
import { sendMail } from '../lib/mail.js';
import { pushLater } from '../lib/push.js';
import { toUsers } from '../lib/realtime.js';
import { createBuilding, buildingInput } from './buildings.js';

const email = z.string().trim().toLowerCase().email('Unesite ispravan e-mail.');
const password = z.string().min(8, 'Lozinka mora da ima najmanje 8 karaktera.').max(72);
const fullName = z.string().trim().min(2, 'Unesite ime i prezime.').max(120);
const phone = z.string().trim().max(40).optional().nullable();
const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export async function publicUser(db: Db, id: string) {
  const u = await one(db, 'SELECT id, email, full_name, phone, theme_pref, notify_pref FROM users WHERE id = ?', [id]);
  if (!u) throw notFound();
  return { id: u.id, email: u.email, fullName: u.full_name, phone: u.phone, themePref: u.theme_pref, notifyPref: u.notify_pref };
}

async function inviteOr410(token: string) {
  const invite = await one(pool, 'SELECT * FROM building_invite_codes WHERE token = ?', [token]);
  if (!invite) throw notFound('Kod nije prepoznat. Proverite QR kod ili link.');
  if (!invite.active) throw new ApiError(410, 'invite_revoked', 'Kod više ne važi, traži novi od upravnika');
  return invite;
}

async function createPending(db: Db, invite: any, uid: string, apartmentId: string, role: string) {
  const apartment = await one(db, 'SELECT id, number FROM apartments WHERE id = ? AND building_id = ?', [apartmentId, invite.building_id]);
  if (!apartment) throw badRequest('bad_apartment', 'Izaberite stan iz liste.');
  const existing = await one(db, "SELECT 1 AS ok FROM memberships WHERE apartment_id = ? AND user_id = ? AND status <> 'rejected'", [apartmentId, uid]);
  if (existing) throw conflict('already_member', 'Već ste poslali zahtev za ovaj stan.');
  const id = uuid();
  await exec(
    db,
    "INSERT INTO memberships (id, building_id, apartment_id, user_id, role, status, invite_code_id, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
    [id, invite.building_id, apartmentId, uid, role, invite.id, now()],
  );
  return { id, number: apartment.number };
}

async function notifyRequest(buildingId: string, name: string, number: number) {
  const managers = await managerIds(buildingId);
  toUsers(managers, 'memberships');
  pushLater(managers, { title: 'Nov zahtev za pristup', body: `${name}, stan ${number}`, data: { screen: 'requests', buildingId } });
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', authLimit, async (req) => {
    const body = z.object({ email, password: z.string() }).parse(req.body);
    const user = await one(pool, 'SELECT id, password_hash FROM users WHERE email = ?', [body.email]);
    if (!user?.password_hash || !(await checkPassword(body.password, user.password_hash))) {
      throw new ApiError(401, 'bad_credentials', 'Pogrešan e-mail ili lozinka.');
    }
    return { ...(await issueTokens(pool, user.id)), user: await publicUser(pool, user.id) };
  });

  app.post('/auth/refresh', async (req) => {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    return rotateRefresh(refreshToken);
  });

  app.post('/auth/logout', async (req) => {
    const body = z.object({ refreshToken: z.string(), pushToken: z.string().optional() }).parse(req.body);
    await revokeRefresh(body.refreshToken);
    if (body.pushToken) await exec(pool, 'DELETE FROM push_tokens WHERE token = ?', [body.pushToken]);
    return { ok: true };
  });

  app.post('/auth/forgot-password', authLimit, async (req) => {
    const body = z.object({ email }).parse(req.body);
    const user = await one(pool, 'SELECT id FROM users WHERE email = ?', [body.email]);
    if (user) {
      const token = randomToken();
      await exec(pool, "INSERT INTO password_tokens (id, user_id, token_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, 'reset', ?, ?)", [
        uuid(), user.id, sha256(token), new Date(Date.now() + 3600_000), new Date(),
      ]);
      await sendMail(body.email, 'Promena lozinke za Upravko', `Otvorite link da postavite novu lozinku (važi 1 sat):\n${config.appLink}set-password/${token}`);
    }
    return { ok: true }; // Isti odgovor i kad nalog ne postoji.
  });

  app.post('/auth/reset-password', authLimit, async (req) => {
    const body = z.object({ token: z.string(), password }).parse(req.body);
    const row = await one(pool, 'SELECT * FROM password_tokens WHERE token_hash = ?', [sha256(body.token)]);
    if (!row || row.used_at || row.expires_at < new Date()) throw badRequest('bad_token', 'Link je istekao. Zatražite novi.');
    await tx(async (db) => {
      await exec(db, 'UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(body.password), row.user_id]);
      await exec(db, 'UPDATE password_tokens SET used_at = ? WHERE id = ?', [new Date(), row.id]);
      await exec(db, 'DELETE FROM refresh_tokens WHERE user_id = ?', [row.user_id]);
    });
    return { ...(await issueTokens(pool, row.user_id)), user: await publicUser(pool, row.user_id) };
  });

  // Prikaz zgrade posle skeniranja QR koda (pre registracije).
  app.get('/invites/:token', async (req) => {
    const { token } = req.params as { token: string };
    const invite = await inviteOr410(token);
    const b = await one(pool, 'SELECT b.*, o.name, o.logo_variant, o.logo_url, o.color_primary, o.color_primary_dark, o.color_secondary, o.color_accent FROM buildings b JOIN organizations o ON o.id = b.organization_id WHERE b.id = ?', [invite.building_id]);
    const apartments = await rows(pool, 'SELECT id, number FROM apartments WHERE building_id = ? ORDER BY number', [invite.building_id]);
    const manager = await one(pool, 'SELECT u.full_name FROM building_managers m JOIN users u ON u.id = m.user_id WHERE m.building_id = ? LIMIT 1', [invite.building_id]);
    return {
      building: { id: b!.id, address: b!.address, city: b!.city, apartmentsCount: b!.apartments_count, coverUrl: signedUrl(b!.cover_image_path) },
      brand: brandOf(b!),
      managerName: manager?.full_name ?? null,
      apartments,
    };
  });

  const joinFields = { apartmentId: z.string().uuid('Izaberite stan.'), role: z.enum(['owner', 'tenant']) };

  app.post('/auth/register-resident', authLimit, async (req) => {
    const body = z.object({ token: z.string(), fullName, phone, email, password, ...joinFields }).parse(req.body);
    const invite = await inviteOr410(body.token);
    const hash = await hashPassword(body.password);
    const result = await tx(async (db) => {
      if (await one(db, 'SELECT 1 AS ok FROM users WHERE email = ?', [body.email])) {
        throw conflict('email_taken', 'Nalog sa ovim e-mailom već postoji. Prijavite se, pa skenirajte kod.');
      }
      const id = uuid();
      await exec(db, 'INSERT INTO users (id, email, password_hash, full_name, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, body.email, hash, body.fullName, body.phone ?? null, now()]);
      const membership = await createPending(db, invite, id, body.apartmentId, body.role);
      return { id, number: membership.number };
    });
    await notifyRequest(invite.building_id, body.fullName, result.number);
    return { ...(await issueTokens(pool, result.id)), user: await publicUser(pool, result.id) };
  });

  // Već prijavljen korisnik skenira kod druge zgrade.
  app.post('/invites/:token/join', async (req) => {
    const uid = userId(req);
    const { token } = req.params as { token: string };
    const body = z.object(joinFields).parse(req.body);
    const invite = await inviteOr410(token);
    const membership = await tx((db) => createPending(db, invite, uid, body.apartmentId, body.role));
    const user = await publicUser(pool, uid);
    await notifyRequest(invite.building_id, user.fullName, membership.number);
    return { ok: true };
  });

  app.post('/auth/register-manager', authLimit, async (req) => {
    const body = z.object({ fullName, phone, email, password, organizationName: z.string().trim().min(2).max(120).optional(), building: buildingInput }).parse(req.body);
    if (body.building.bankAccount && !isValidAccount(body.building.bankAccount)) throw badRequest('bad_account', 'Broj računa nije ispravan (18 cifara).');
    const hash = await hashPassword(body.password);
    const id = uuid();
    const buildingId = await tx(async (db) => {
      if (await one(db, 'SELECT 1 AS ok FROM users WHERE email = ?', [body.email])) throw conflict('email_taken', 'Nalog sa ovim e-mailom već postoji.');
      await exec(db, 'INSERT INTO users (id, email, password_hash, full_name, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, body.email, hash, body.fullName, body.phone ?? null, now()]);
      const orgId = uuid();
      await exec(db, "INSERT INTO organizations (id, name, logo_variant, created_at) VALUES (?, ?, 'upravko', ?)", [orgId, body.organizationName ?? 'Upravko', now()]);
      return createBuilding(db, orgId, id, body.building);
    });
    return { ...(await issueTokens(pool, id)), user: await publicUser(pool, id), buildingId };
  });

  // Moj nalog: šta korisnik vidi, odakle kreće navigacija.
  app.get('/me', async (req) => {
    const uid = userId(req);
    const user = await publicUser(pool, uid);
    const brandCols = 'o.name, o.logo_variant, o.logo_url, o.color_primary, o.color_primary_dark, o.color_secondary, o.color_accent';
    const managed = await rows(pool, `SELECT b.id, b.address, b.city, ${brandCols} FROM building_managers m JOIN buildings b ON b.id = m.building_id JOIN organizations o ON o.id = b.organization_id WHERE m.user_id = ? ORDER BY b.created_at, b.address`, [uid]);
    const memberships = await rows(
      pool,
      `SELECT m.id, m.status, m.role, m.created_at, a.number, b.id AS building_id, b.address, b.city, ${brandCols}
       FROM memberships m JOIN apartments a ON a.id = m.apartment_id JOIN buildings b ON b.id = m.building_id JOIN organizations o ON o.id = b.organization_id
       WHERE m.user_id = ? ORDER BY b.address, a.number`,
      [uid],
    );
    const pendingManagers = new Map<string, string | null>();
    for (const m of memberships.filter((x) => x.status === 'pending')) {
      const row = await one(pool, 'SELECT u.full_name FROM building_managers bm JOIN users u ON u.id = bm.user_id WHERE bm.building_id = ? LIMIT 1', [m.building_id]);
      pendingManagers.set(m.id, row?.full_name ?? null);
    }
    return {
      user,
      serverNow: now().toISOString(),
      managed: managed.map((b) => ({ id: b.id, address: b.address, city: b.city, brand: brandOf(b) })),
      memberships: memberships.map((m) => ({
        id: m.id, status: m.status, role: m.role, createdAt: m.created_at, apartmentNumber: m.number, buildingId: m.building_id,
        address: m.address, city: m.city, brand: brandOf(m), managerName: pendingManagers.get(m.id) ?? null,
      })),
    };
  });

  app.patch('/me', async (req) => {
    const uid = userId(req);
    const body = z.object({
      fullName: fullName.optional(), phone, email: email.optional(),
      themePref: z.enum(['system', 'light', 'dark']).optional(), notifyPref: z.enum(['all', 'urgent']).optional(),
    }).parse(req.body);
    const cols: Record<string, unknown> = {
      full_name: body.fullName, phone: body.phone, email: body.email, theme_pref: body.themePref, notify_pref: body.notifyPref,
    };
    const entries = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (entries.length) {
      try {
        await exec(pool, `UPDATE users SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [...entries.map(([, v]) => v), uid]);
      } catch (err: any) {
        if (err.code === 'ER_DUP_ENTRY') throw conflict('email_taken', 'Taj e-mail već koristi drugi nalog.');
        throw err;
      }
    }
    return publicUser(pool, uid);
  });

  app.post('/me/push-tokens', async (req) => {
    const uid = userId(req);
    const body = z.object({ token: z.string().min(10).max(255), platform: z.string().max(20).optional() }).parse(req.body);
    await exec(pool, 'INSERT INTO push_tokens (token, user_id, platform, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)', [body.token, uid, body.platform ?? null, new Date()]);
    return { ok: true };
  });
}

