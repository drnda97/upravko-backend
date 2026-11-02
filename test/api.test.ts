import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { exec, one, pool } from '../src/db.js';
import { setNow } from '../src/lib/clock.js';
import { closeExpiredVotes, createMonthlyCharges } from '../src/jobs/index.js';
import { migrate } from '../src/migrate.js';
import { BULEVAR_TOKEN, clearTestData, seed } from '../seed/seed.js';

let app: FastifyInstance;
const tokens = new Map<string, string>();
const DEMO = new Date('2026-10-30T11:00:00+01:00');

async function api(method: string, url: string, who?: string | null, payload?: unknown) {
  const headers: Record<string, string> = {};
  if (who) headers.authorization = `Bearer ${await login(who)}`;
  const res = await app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers, payload: payload as object });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function login(who: string) {
  if (tokens.has(who)) return tokens.get(who)!;
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `${who}@test.upravko.rs`, password: 'Test1234!' } });
  const token = JSON.parse(res.body).accessToken;
  tokens.set(who, token);
  return token as string;
}

async function upload(who: string, name: string, type: string) {
  const boundary = '----t';
  // Server proverava sadržaj, pa fajl počinje potpisom svog tipa.
  const data = type === 'application/pdf' ? '%PDF-1.4' : type === 'image/png' ? '\x89PNG\r\n\x1a\n' : '\xff\xd8\xff\xe0';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n${data}data\r\n--${boundary}--\r\n`, 'latin1');
  const res = await app.inject({ method: 'POST', url: '/api/v1/uploads', headers: { authorization: `Bearer ${await login(who)}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  return JSON.parse(res.body).path as string;
}

let bulevar: string, door: string, leak: string;
const issueByTitle = async (title: string) => (await one(pool, 'SELECT id FROM issues WHERE title = ? AND building_id = ?', [title, bulevar]))!.id as string;

beforeAll(async () => {
  await migrate('upravko_test');
  await clearTestData();
  await seed();
  app = await buildApp({ rateLimit: false });
  await app.ready();
  bulevar = (await one(pool, "SELECT id FROM buildings WHERE address = 'Bulevar oslobođenja 45'"))!.id;
  door = await issueByTitle('Ulazna vrata se ne zatvaraju');
  leak = await issueByTitle('Curenje u podrumu');
});

afterAll(async () => {
  setNow(DEMO);
  await app.close();
  await pool.end();
});

describe('web klijenti', () => {
  it('CORS dozvoljava PATCH (website/CRM)', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: '/api/v1/me', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'PATCH' } });
    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
  });
});

describe('brojevi iz dizajna', () => {
  it('Jelena vidi 284.300 / 216.450 / −18.500 / 17 od 24 / Al-Pro 9 / Požuri 11 / dug 4.000 / 12.000', async () => {
    const { body } = await api('GET', `/buildings/${bulevar}/dashboard`, 'jelena.kovac');
    expect(body.budget.balance).toBe(284300);
    expect(body.budget).not.toHaveProperty('incomeThisMonth');
    expect(body.budget.reserved).toBe(216450);
    expect(body.budget.lastChange.amount).toBe(-18500);
    expect(body.vote.totalVotes).toBe(17);
    expect(body.vote.apartmentsCount).toBe(24);
    expect(body.vote.leaderName).toBe('Al-Pro');
    expect(body.vote.leaderVotes).toBe(9);
    expect(body.issues).toHaveLength(3);
    expect(body.issues[0].hurries).toBe(11);
    expect(body.issues[0].hurriedByMe).toBe(true);
    expect(body.overdueTotal).toBe(12000);
    const budget = (await api('GET', `/buildings/${bulevar}/budget`, 'jelena.kovac')).body;
    expect(budget.mine.debt).toBe(4000);
    expect(budget.mine.nextDue).toBe('2026-11-15');
    expect(budget.free).toBe(67850);
    expect(budget.chart.map((c: any) => c.balance)).toEqual([182400, 214900, 231600, 248100, 216600, 284300]);
    expect(budget.mine.ips.payload).toMatch(/I:RSD4000,00\|SF:189\|.*RO:97\d{2}072611$/);
  });

  it('upravnik vidi dužnike i nepovezane uplate; nepovezane nisu u budžetu', async () => {
    const { body } = await api('GET', `/buildings/${bulevar}/budget/manager`, 'milan.petrovic');
    expect(body.overdueTotal).toBe(12000);
    expect(body.overdue.map((o: any) => [o.apartmentNumber, o.total, o.months])).toEqual([[5, 8000, 2], [14, 4000, 1]]);
    expect(body.lastImport).toMatchObject({ total: 24, matched: 22 });
    expect(body.unmatched).toHaveLength(2);
  });
});

describe('dozvole', () => {
  it('bez prijave nema podataka', async () => {
    expect((await api('GET', `/buildings/${bulevar}/dashboard`)).status).toBe(401);
  });

  it('pending stanar ne vidi zgradu', async () => {
    expect((await api('GET', `/buildings/${bulevar}/dashboard`, 'petra.jovanovic')).status).toBe(403);
    expect((await api('GET', `/issues/${door}`, 'petra.jovanovic')).status).toBe(403);
  });

  it('stanar druge zgrade ne vidi ništa', async () => {
    expect((await api('GET', `/buildings/${bulevar}/budget`, 'stanplus.stanar')).status).toBe(403);
    expect((await api('GET', `/issues/${door}`, 'stanplus.upravnik')).status).toBe(403);
  });

  it('stanar ne može da čita tuđa zaduženja ni spisak dužnika', async () => {
    expect((await api('GET', `/buildings/${bulevar}/budget/manager`, 'jelena.kovac')).status).toBe(403);
    const apartment = (await one(pool, 'SELECT id FROM apartments WHERE building_id = ? AND number = 5', [bulevar]))!.id;
    expect((await api('GET', `/buildings/${bulevar}/apartments/${apartment}/charges`, 'jelena.kovac')).status).toBe(403);
    const raw = JSON.stringify((await api('GET', `/buildings/${bulevar}/budget`, 'jelena.kovac')).body);
    expect(raw).not.toContain('Goran');
    expect(raw).not.toContain('Uplata, stan');
  });

  it('stanar ne vidi tuđe privatne poruke', async () => {
    const ana = (await api('GET', `/buildings/${bulevar}/threads`, 'ana.markovic')).body.items;
    expect(ana).toHaveLength(1);
    expect((await api('GET', `/threads/${ana[0].id}`, 'jelena.kovac')).status).toBe(404);
    expect((await api('POST', `/threads/${ana[0].id}/messages`, 'jelena.kovac', { body: 'x' })).status).toBe(404);
    expect((await api('GET', `/threads/${ana[0].id}`, 'milan.petrovic')).status).toBe(200);
  });

  it('stanar ne sme upravničke upise', async () => {
    for (const [url, payload] of [
      [`/issues/${door}/offers`, { contractor: 'X', price: 1, durationDays: 1 }],
      [`/buildings/${bulevar}/expenses`, { title: 'Trošak', amount: 1 }],
      [`/buildings/${bulevar}/announcements`, { type: 'info', title: 'Naslov', body: 'Tekst' }],
      [`/buildings/${bulevar}/invite/rotate`, {}],
    ] as const) {
      expect((await api('POST', url, 'jelena.kovac', payload)).status).toBe(403);
    }
    expect((await api('PATCH', `/issues/${door}`, 'jelena.kovac', { urgency: 'low' })).status).toBe(403);
  });

  it('finansijske stavke su nepromenljive i u bazi', async () => {
    await expect(exec(pool, 'UPDATE ledger_entries SET amount = 1 WHERE building_id = ?', [bulevar])).rejects.toThrow(/nepromenljiva/);
    await expect(exec(pool, 'DELETE FROM ledger_entries WHERE building_id = ?', [bulevar])).rejects.toThrow(/nepromenljiva/);
  });
});

describe('anonimna prijava', () => {
  it('Ana i Dragan ne vide ime, Milan vidi', async () => {
    const ana = (await api('GET', `/issues/${leak}`, 'ana.markovic')).body;
    expect(ana.reporter).toEqual({ name: null, apartmentNumber: null, anonymous: true });
    expect(JSON.stringify(ana)).not.toContain('Dragan');
    const list = JSON.stringify((await api('GET', `/buildings/${bulevar}/issues?filter=all`, 'jelena.kovac')).body.items.find((i: any) => i.id === leak));
    expect(list).not.toContain('Dragan');
    expect((await api('GET', `/issues/${leak}`, 'milan.petrovic')).body.reporter).toMatchObject({ name: 'Dragan Ilić', apartmentNumber: 12 });
  });
});

describe('Požuri i glasanje', () => {
  it('drugi Požuri sa istog stana ne prolazi', async () => {
    const res = await api('POST', `/issues/${door}/hurry`, 'jelena.kovac');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_hurried');
    expect((await api('POST', `/issues/${leak}/hurry`, 'jelena.kovac')).status).toBe(200);
    expect((await api('POST', `/issues/${leak}/hurry`, 'jelena.kovac')).status).toBe(409);
  });

  it('Jelena menja glas, rezultat se odmah menja, posle roka je zaključano', async () => {
    const detail = (await api('GET', `/issues/${door}`, 'jelena.kovac')).body;
    const metalac = detail.vote.offers.find((o: any) => o.contractor === 'Metalac');
    expect((await api('POST', `/issues/${door}/vote`, 'jelena.kovac', { offerId: metalac.id })).status).toBe(200);
    const after = (await api('GET', `/issues/${door}`, 'milan.petrovic')).body.vote;
    expect(after.offers.find((o: any) => o.contractor === 'Metalac').votes).toBe(6);
    expect(after.offers.find((o: any) => o.contractor === 'Al-Pro').votes).toBe(8);
    expect(after.totalVotes).toBe(17);

    setNow(new Date('2026-11-02T20:00:01+01:00'));
    const late = await api('POST', `/issues/${door}/vote`, 'jelena.kovac', { offerId: metalac.id });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('vote_closed');
    setNow(DEMO);
    // Vrati glas za sledeće testove.
    const alPro = detail.vote.offers.find((o: any) => o.contractor === 'Al-Pro');
    await api('POST', `/issues/${door}/vote`, 'jelena.kovac', { offerId: alPro.id });
  });
});

describe('registracija', () => {
  const email = `novi.stanar.${Date.now()}@test.upravko.rs`;

  it('nov stanar preko QR linka: čekanje, pa Milan odobri', async () => {
    const preview = (await api('GET', `/invites/${BULEVAR_TOKEN}`)).body;
    expect(preview.building.address).toBe('Bulevar oslobođenja 45');
    const reg = await api('POST', '/auth/register-resident', null, {
      token: BULEVAR_TOKEN, fullName: 'Novi Stanar', phone: '+381 60 000 000', email, password: 'Lozinka123', apartmentId: preview.apartments[0].id, role: 'tenant',
    });
    expect(reg.status).toBe(200);
    const headers = { authorization: `Bearer ${reg.body.accessToken}` };
    const blocked = await app.inject({ method: 'GET', url: `/api/v1/buildings/${bulevar}/dashboard`, headers });
    expect(blocked.statusCode).toBe(403);
    const me = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/me', headers })).body);
    expect(me.memberships[0].status).toBe('pending');
    expect((await api('POST', `/memberships/${me.memberships[0].id}/approve`, 'milan.petrovic')).status).toBe(200);
    const allowed = await app.inject({ method: 'GET', url: `/api/v1/buildings/${bulevar}/dashboard`, headers });
    expect(allowed.statusCode).toBe(200);
    await exec(pool, 'DELETE FROM users WHERE email = ?', [email]);
  });

  it('Nikola prikazuje upozorenje o dva vlasnika, zakupac ne', async () => {
    const { items } = (await api('GET', `/buildings/${bulevar}/memberships?status=pending`, 'milan.petrovic')).body;
    expect(items.find((m: any) => m.fullName === 'Nikola Stanić').ownerConflict).toBe('Dragan Ilić');
    expect(items.find((m: any) => m.fullName === 'Petra Jovanović').ownerConflict).toBeNull();
  });

  it('„Napravi novi kod“ poništava stari link', async () => {
    const before = (await api('GET', `/buildings/${bulevar}/invite`, 'milan.petrovic')).body;
    expect(before.registrations).toBeGreaterThanOrEqual(21);
    await api('POST', `/buildings/${bulevar}/invite/rotate`, 'milan.petrovic');
    const old = await api('GET', `/invites/${before.token}`);
    expect(old.status).toBe(410);
    expect(old.body.message).toBe('Kod više ne važi, traži novi od upravnika');
    const fresh = (await api('GET', `/buildings/${bulevar}/invite`, 'milan.petrovic')).body;
    expect((await api('GET', `/invites/${fresh.token}`)).status).toBe(200);
  });

  it('nov upravnik vidi samo prazna stanja', async () => {
    const reg = await api('POST', '/auth/register-manager', null, {
      fullName: 'Nova Upravnica', email: `nova.upravnica.${Date.now()}@test.upravko.rs`, password: 'Lozinka123',
      building: { address: 'Nova ulica 1', city: 'Beograd', apartmentsCount: 8, feeAmount: 2000 },
    });
    expect(reg.status).toBe(200);
    const headers = { authorization: `Bearer ${reg.body.accessToken}` };
    const id = reg.body.buildingId;
    for (const url of ['dashboard', 'budget', 'budget/manager', 'issues', 'announcements', 'threads', 'services', 'invite', 'memberships']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/buildings/${id}/${url}`, headers });
      expect(res.statusCode, url).toBe(200);
    }
    const dash = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/buildings/${id}/dashboard`, headers })).body);
    expect(dash).toMatchObject({ budget: { balance: 0, reserved: 0, lastChange: null }, vote: null, issues: [], announcements: [], overdueTotal: 0 });
    await exec(pool, 'DELETE FROM organizations WHERE id = (SELECT organization_id FROM buildings WHERE id = ?)', [id]);
    await exec(pool, 'DELETE FROM users WHERE id = ?', [reg.body.user.id]);
  });
});

describe('privatna poruka u javni problem', () => {
  it('nastaje tek posle pristanka stanara', async () => {
    const thread = (await api('GET', `/buildings/${bulevar}/threads`, 'ana.markovic')).body.items[0];
    const before = (await api('GET', `/buildings/${bulevar}/issues?filter=all`, 'milan.petrovic')).body.items.length;
    await api('POST', `/threads/${thread.id}/request-conversion`, 'milan.petrovic');
    expect((await api('GET', `/buildings/${bulevar}/issues?filter=all`, 'milan.petrovic')).body.items).toHaveLength(before);
    expect((await api('POST', `/threads/${thread.id}/respond-conversion`, 'milan.petrovic', { accept: true })).status).toBe(403);
    const res = await api('POST', `/threads/${thread.id}/respond-conversion`, 'ana.markovic', { accept: true, isAnonymous: true });
    expect(res.status).toBe(200);
    expect((await api('GET', `/issues/${res.body.issueId}`, 'jelena.kovac')).body.reporter.anonymous).toBe(true);
  });
});

describe('budžet', () => {
  it('nepovezana uplata ulazi u budžet tek kad se poveže', async () => {
    const { unmatched } = (await api('GET', `/buildings/${bulevar}/budget/manager`, 'milan.petrovic')).body;
    const apartment = (await one(pool, 'SELECT id FROM apartments WHERE building_id = ? AND number = 14', [bulevar]))!.id;
    const line = unmatched.find((u: any) => u.payer === 'M. Jovanović');
    expect((await api('POST', `/bank-lines/${line.id}/link`, 'milan.petrovic', { apartmentId: apartment })).status).toBe(200);
    expect((await api('GET', `/buildings/${bulevar}/budget`, 'milan.petrovic')).body.balance).toBe(288300);
    expect((await api('POST', `/bank-lines/${line.id}/link`, 'milan.petrovic', { apartmentId: apartment })).status).toBe(409);
  });

  it('storno je nova stavka i vraća stanje', async () => {
    const { payments } = (await api('GET', `/buildings/${bulevar}/budget/manager`, 'milan.petrovic')).body;
    const res = await api('POST', `/ledger/${payments[0].id}/reverse`, 'milan.petrovic');
    expect(res.status).toBe(200);
    expect((await api('POST', `/ledger/${payments[0].id}/reverse`, 'milan.petrovic')).status).toBe(409);
    expect((await api('GET', `/buildings/${bulevar}/budget`, 'milan.petrovic')).body.balance).toBe(284300);
  });

  it('IPS prati najstariju neplaćenu ratu i sledi se iz meseca u mesec', async () => {
    const mine = async () => (await api('GET', `/buildings/${bulevar}/budget`, 'jelena.kovac')).body.mine;
    expect((await mine()).ips.period).toBe('2026-11');
    await createMonthlyCharges('2026-12-01');
    const dve = await mine();
    expect(dve.debt).toBe(8000);
    expect(dve.ips.period).toBe('2026-11');
    const apartment = (await one(pool, 'SELECT id FROM apartments WHERE building_id = ? AND number = 7', [bulevar]))!.id;
    const paid = await api('POST', `/buildings/${bulevar}/payments`, 'milan.petrovic', { apartmentId: apartment, amount: 4000 });
    expect(paid.status).toBe(200);
    const next = await mine();
    expect(next.ips.period).toBe('2026-12');
    expect(next.ips.payload).toMatch(/I:RSD4000,00\|.*RO:97\d{2}072612$/);
    await api('POST', `/ledger/${paid.body.id}/reverse`, 'milan.petrovic');
    await exec(pool, "DELETE FROM charges WHERE period = '2026-12'");
    expect((await mine()).ips.period).toBe('2026-11');
  });

  it('Platio/la sam: uplata čeka potvrdu, pa je upravnik potvrdi', async () => {
    const budget = async (who: string) => (await api('GET', `/buildings/${bulevar}/budget`, who)).body;
    const before = (await budget('milan.petrovic')).balance;
    const res = await api('POST', `/buildings/${bulevar}/payment-claims`, 'jelena.kovac', { scope: 'next' });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(4000);
    const waiting = (await budget('jelena.kovac')).mine;
    expect(waiting.pendingClaim.amount).toBe(4000);
    expect(waiting.debt).toBe(4000);
    expect(waiting.ips).toBeNull();
    expect((await budget('milan.petrovic')).balance).toBe(before);
    expect((await api('POST', `/buildings/${bulevar}/payment-claims`, 'jelena.kovac', { scope: 'next' })).status).toBe(409);
    expect((await api('POST', `/buildings/${bulevar}/payment-claims`, 'milan.petrovic', { scope: 'next' })).status).toBe(403);
    expect((await api('POST', `/payment-claims/${res.body.id}/confirm`, 'jelena.kovac')).status).toBe(403);
    const { claims } = (await api('GET', `/buildings/${bulevar}/budget/manager`, 'milan.petrovic')).body;
    expect(claims.find((c: any) => c.id === res.body.id)).toMatchObject({ apartmentNumber: 7, resident: 'Jelena Kovač', periods: ['2026-11'] });
    expect((await api('GET', `/buildings/${bulevar}/dashboard`, 'milan.petrovic')).body.manager.pendingClaims).toBeGreaterThanOrEqual(1);
    expect((await api('POST', `/payment-claims/${res.body.id}/confirm`, 'milan.petrovic')).status).toBe(200);
    expect((await api('POST', `/payment-claims/${res.body.id}/confirm`, 'milan.petrovic')).status).toBe(409);
    expect((await budget('jelena.kovac')).mine.debt).toBe(0);
    expect((await budget('milan.petrovic')).balance).toBe(before + 4000);
    const entry = await one(pool, 'SELECT ledger_entry_id FROM payment_claims WHERE id = ?', [res.body.id]);
    await api('POST', `/ledger/${entry!.ledger_entry_id}/reverse`, 'milan.petrovic');
    expect((await budget('jelena.kovac')).mine.debt).toBe(4000);
  });

  it('odbijena prijava vraća QR, a uplata svih rata plaća sve odjednom', async () => {
    const mine = async () => (await api('GET', `/buildings/${bulevar}/budget`, 'jelena.kovac')).body.mine;
    const first = await api('POST', `/buildings/${bulevar}/payment-claims`, 'jelena.kovac', { scope: 'next' });
    expect((await api('POST', `/payment-claims/${first.body.id}/reject`, 'milan.petrovic')).status).toBe(200);
    const rejected = await mine();
    expect(rejected.claimRejected).toBe(true);
    expect(rejected.ips.period).toBe('2026-11');
    await createMonthlyCharges('2026-12-01');
    const two = await mine();
    expect(two.debt).toBe(8000);
    expect(two.ipsAll.amount).toBe(8000);
    expect(two.ipsAll.periods).toEqual(['2026-11', '2026-12']);
    expect(two.ipsAll.payload).toMatch(/I:RSD8000,00\|.*RO:97\d{2}070000$/);
    const all = await api('POST', `/buildings/${bulevar}/payment-claims`, 'jelena.kovac', { scope: 'all' });
    expect(all.body.amount).toBe(8000);
    await api('POST', `/payment-claims/${all.body.id}/confirm`, 'milan.petrovic');
    expect((await mine()).debt).toBe(0);
    const entry = await one(pool, 'SELECT ledger_entry_id FROM payment_claims WHERE id = ?', [all.body.id]);
    await api('POST', `/ledger/${entry!.ledger_entry_id}/reverse`, 'milan.petrovic');
    await exec(pool, "DELETE FROM charges WHERE period = '2026-12'");
  });

  it('uplata uneta ručno rešava prijavu', async () => {
    const claim = await api('POST', `/buildings/${bulevar}/payment-claims`, 'jelena.kovac', { scope: 'next' });
    const apartment = (await one(pool, 'SELECT id FROM apartments WHERE building_id = ? AND number = 7', [bulevar]))!.id;
    const paid = await api('POST', `/buildings/${bulevar}/payments`, 'milan.petrovic', { apartmentId: apartment, amount: 4000 });
    expect(paid.status).toBe(200);
    expect((await one(pool, 'SELECT status FROM payment_claims WHERE id = ?', [claim.body.id]))!.status).toBe('confirmed');
    await api('POST', `/ledger/${paid.body.id}/reverse`, 'milan.petrovic');
  });

  it('izvod sa pozivom za sve rate plaća sva dugovanja stana', async () => {
    await createMonthlyCharges('2026-12-01');
    const ref = (await api('GET', `/buildings/${bulevar}/budget`, 'jelena.kovac')).body.mine.ipsAll.reference;
    const csv = `datum,uplatilac,iznos,poziv na broj,svrha\n30. 10. 2026.,Jelena,"8.000,00",${ref},rate`;
    expect((await api('POST', `/buildings/${bulevar}/bank-imports`, 'milan.petrovic', { fileName: 'x.csv', csv })).body).toEqual({ total: 1, matched: 1 });
    expect((await api('GET', `/buildings/${bulevar}/budget`, 'jelena.kovac')).body.mine.debt).toBe(0);
    const line = await one(pool, "SELECT ledger_entry_id FROM bank_import_lines WHERE reference = ?", [ref]);
    await api('POST', `/ledger/${line!.ledger_entry_id}/reverse`, 'milan.petrovic');
    await exec(pool, "DELETE FROM charges WHERE period = '2026-12'");
  });

  it('prihod bez stana ulazi u budžet i može da se stornira', async () => {
    const before = (await api('GET', `/buildings/${bulevar}/budget`, 'milan.petrovic')).body.balance;
    const res = await api('POST', `/buildings/${bulevar}/income`, 'milan.petrovic', { title: 'Uplata od Infostana', amount: 50000 });
    expect((await api('POST', `/buildings/${bulevar}/income`, 'jelena.kovac', { title: 'Hak', amount: 1 })).status).toBe(403);
    expect((await api('GET', `/buildings/${bulevar}/budget`, 'jelena.kovac')).body.balance).toBe(before + 50000);
    await api('POST', `/ledger/${res.body.id}/reverse`, 'milan.petrovic');
  });

  it('Infostan zgrada nema lažnih dugova, IPS ni novih rata', async () => {
    await api('POST', `/buildings/${bulevar}/payment-claims`, 'jelena.kovac', { scope: 'next' });
    await api('PATCH', `/buildings/${bulevar}`, 'milan.petrovic', { paymentMode: 'infostan' });
    const mine = (await api('GET', `/buildings/${bulevar}/budget`, 'jelena.kovac')).body;
    expect(mine.mine.ips).toBeNull();
    expect(mine.mine.debt).toBe(0);
    expect(mine.mine.pendingClaim).toBeNull();
    expect(mine.overdueTotal).toBe(0);
    const manager = (await api('GET', `/buildings/${bulevar}/budget/manager`, 'milan.petrovic')).body;
    expect(manager).toMatchObject({ overdue: [], overdueTotal: 0, claims: [] });
    expect((await api('POST', `/buildings/${bulevar}/payment-claims`, 'jelena.kovac', { scope: 'next' })).status).toBe(400);
    const apartment = (await one(pool, 'SELECT id FROM apartments WHERE building_id = ? AND number = 7', [bulevar]))!.id;
    expect((await api('POST', `/buildings/${bulevar}/payments`, 'milan.petrovic', { apartmentId: apartment, amount: 4000 })).status).toBe(400);
    await createMonthlyCharges('2026-12-01');
    expect(Number((await one(pool, "SELECT COUNT(*) AS n FROM charges WHERE building_id = ? AND period = '2026-12'", [bulevar]))!.n)).toBe(0);
    expect(Number((await one(pool, 'SELECT COUNT(*) AS n FROM charges WHERE building_id = ?', [bulevar]))!.n)).toBeGreaterThan(100);
    await api('PATCH', `/buildings/${bulevar}`, 'milan.petrovic', { paymentMode: 'direct' });
  });

  it('mesečno pravilo ne pravi duplikate', async () => {
    const count = async () => Number((await one(pool, "SELECT COUNT(*) AS n FROM charges WHERE building_id = ? AND period = '2026-11'", [bulevar]))!.n);
    expect(await count()).toBe(24);
    await createMonthlyCharges('2026-11-01');
    expect(await count()).toBe(24);
    await createMonthlyCharges('2026-12-01');
    expect(Number((await one(pool, "SELECT COUNT(*) AS n FROM charges WHERE building_id = ? AND period = '2026-12'", [bulevar]))!.n)).toBe(24);
    await exec(pool, "DELETE FROM charges WHERE period = '2026-12'");
  });
});

describe('zatvaranje problema', () => {
  it('traži sliku, račun i iznos, pa skida 216.450 sa budžeta (67.850)', async () => {
    expect((await api('POST', `/issues/${door}/resolve`, 'milan.petrovic', { amount: 216450 })).status).toBe(400);
    const invoicePath = await upload('milan.petrovic', 'racun.pdf', 'application/pdf');
    const photo = await upload('milan.petrovic', 'posle.jpg', 'image/jpeg');
    const res = await api('POST', `/issues/${door}/resolve`, 'milan.petrovic', { amount: 216450, invoicePath, photos: [photo] });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(67850);
    const detail = (await api('GET', `/issues/${door}`, 'jelena.kovac')).body;
    expect(detail.status).toBe('resolved');
    expect(detail.chosenOffer.contractor).toBe('Al-Pro');
    expect(detail.resolution).toMatchObject({ amount: 216450, balanceAfter: 67850 });
    expect((await api('GET', `/buildings/${bulevar}/budget`, 'jelena.kovac')).body.reserved).toBe(0);
    expect((await api('POST', `/issues/${door}/resolve`, 'milan.petrovic', { amount: 1, invoicePath, photos: [photo] })).status).toBe(409);
  });

  it('tuđ fajl ne može da se zakači', async () => {
    const foreign = await upload('jelena.kovac', 'x.pdf', 'application/pdf');
    expect((await api('POST', `/buildings/${bulevar}/expenses`, 'milan.petrovic', { title: 'Trošak', amount: 10, invoicePath: foreign })).status).toBe(400);
  });

  it('istek roka zatvara glasanje i bira pobednika', async () => {
    const lift = await issueByTitle('Lift staje između 3. i 4. sprata');
    await api('POST', `/issues/${lift}/offers`, 'milan.petrovic', { contractor: 'Lift Servis NS', price: 50000, durationDays: 2 });
    await api('POST', `/issues/${lift}/offers`, 'milan.petrovic', { contractor: 'Drugi', price: 60000, durationDays: 2 });
    const opened = await api('POST', `/issues/${lift}/vote-session`, 'milan.petrovic', { deadline: '2026-11-01T12:00:00+01:00', majorityRule: 'simple' });
    expect(opened.status).toBe(200);
    const detail = (await api('GET', `/issues/${lift}`, 'jelena.kovac')).body;
    await api('POST', `/issues/${lift}/vote`, 'jelena.kovac', { offerId: detail.vote.offers.find((o: any) => o.contractor === 'Drugi').id });
    setNow(new Date('2026-11-01T13:00:00+01:00'));
    expect(await closeExpiredVotes()).toBe(1);
    setNow(DEMO);
    const after = (await api('GET', `/issues/${lift}`, 'jelena.kovac')).body;
    expect(after.status).toBe('planned');
    expect(after.chosenOffer.contractor).toBe('Drugi');
  });
});

describe('ispravke posle testiranja', () => {
  const statuses = (list: { status: number }[]) => list.map((r) => r.status).sort();
  const apartment = async (number: number) => (await one(pool, 'SELECT id FROM apartments WHERE building_id = ? AND number = ?', [bulevar, number]))!.id as string;
  const newIssue = async (title: string) =>
    (await api('POST', `/buildings/${bulevar}/issues`, 'jelena.kovac', { title, description: 'Opis problema za test.', location: 'ulaz', urgency: 'low' })).body.id as string;

  it('upravnik ne može da ubaci tuđ nalog u svoju zgradu', async () => {
    const apartmentId = await apartment(10);
    const add = (email: string) => api('POST', `/buildings/${bulevar}/residents`, 'milan.petrovic', { fullName: 'Neko Nekić', email, apartmentId, role: 'tenant' });
    expect((await add('stanplus.upravnik@test.upravko.rs')).status).toBe(409);
    expect((await add(`novi.stanar.${Date.now()}@test.upravko.rs`)).status).toBe(200);
    expect((await add('ana.markovic@test.upravko.rs')).status).toBe(200); // stanarka iste organizacije
  });

  it('podsetnik ne ide stanu druge zgrade', async () => {
    const foreign = (await one(pool, 'SELECT id FROM apartments WHERE building_id <> ? LIMIT 1', [bulevar]))!.id;
    expect((await api('POST', `/buildings/${bulevar}/apartments/${foreign}/remind`, 'milan.petrovic')).status).toBe(404);
  });

  it('dvostruki klik ne duplira novac, probleme ni odluke', async () => {
    const pending = (await one(pool, "SELECT id FROM memberships WHERE building_id = ? AND status = 'pending' LIMIT 1", [bulevar]))!.id;
    expect(statuses(await Promise.all([1, 2].map(() => api('POST', `/memberships/${pending}/approve`, 'milan.petrovic'))))).toEqual([200, 409]);

    const csv = 'datum,uplatilac,iznos,poziv na broj,svrha\n30. 10. 2026.,Paralelni Uplatilac,"1.234,00",,x';
    await api('POST', `/buildings/${bulevar}/bank-imports`, 'milan.petrovic', { fileName: 'p.csv', csv });
    const line = (await one(pool, "SELECT id FROM bank_import_lines WHERE payer = 'Paralelni Uplatilac'"))!.id;
    const apartmentId = await apartment(7);
    expect(statuses(await Promise.all([1, 2].map(() => api('POST', `/bank-lines/${line}/link`, 'milan.petrovic', { apartmentId }))))).toEqual([200, 409]);
    expect(Number((await one(pool, 'SELECT COUNT(*) AS n FROM ledger_entries WHERE apartment_id = ? AND amount = 1234', [apartmentId]))!.n)).toBe(1);

    const issue = await newIssue('Paralelno zatvaranje');
    const invoicePath = await upload('milan.petrovic', 'r.pdf', 'application/pdf');
    const photo = await upload('milan.petrovic', 'p.jpg', 'image/jpeg');
    const before = (await api('GET', `/buildings/${bulevar}/budget`, 'milan.petrovic')).body.balance;
    expect(statuses(await Promise.all([1, 2].map(() => api('POST', `/issues/${issue}/resolve`, 'milan.petrovic', { amount: 1000, invoicePath, photos: [photo] }))))).toEqual([200, 409]);
    expect((await api('GET', `/buildings/${bulevar}/budget`, 'milan.petrovic')).body.balance).toBe(before - 1000);

    const voting = await newIssue('Paralelno glasanje');
    for (const contractor of ['Prvi', 'Drugi']) await api('POST', `/issues/${voting}/offers`, 'milan.petrovic', { contractor, price: 1000, durationDays: 1 });
    const open = () => api('POST', `/issues/${voting}/vote-session`, 'milan.petrovic', { deadline: '2026-11-20T12:00:00+01:00', majorityRule: 'simple' });
    expect(statuses(await Promise.all([open(), open()]))).toEqual([200, 409]);

    const thread = (await api('POST', `/buildings/${bulevar}/threads`, 'jelena.kovac', { subject: 'Paralelni pristanak', body: 'Tekst poruke.' })).body.id;
    await api('POST', `/threads/${thread}/request-conversion`, 'milan.petrovic');
    expect(statuses(await Promise.all([1, 2].map(() => api('POST', `/threads/${thread}/respond-conversion`, 'jelena.kovac', { accept: true }))))).toEqual([200, 400]);
    expect(Number((await one(pool, "SELECT COUNT(*) AS n FROM issues WHERE title = 'Paralelni pristanak'"))!.n)).toBe(1);
  });

  it('ponuda se ne povlači tokom glasanja, kad je izabrana ni dvaput', async () => {
    const voting = await issueByTitle('Paralelno glasanje');
    const offers = (await api('GET', `/issues/${voting}`, 'milan.petrovic')).body.offers;
    expect((await api('POST', `/offers/${offers[0].id}/withdraw`, 'milan.petrovic')).body.code).toBe('voting');
    const lift = (await api('GET', `/issues/${await issueByTitle('Lift staje između 3. i 4. sprata')}`, 'milan.petrovic')).body;
    expect((await api('POST', `/offers/${lift.chosenOffer.id}/withdraw`, 'milan.petrovic')).body.code).toBe('chosen');
    const other = lift.offers.find((o: any) => o.id !== lift.chosenOffer.id);
    expect((await api('POST', `/offers/${other.id}/withdraw`, 'milan.petrovic')).status).toBe(200);
    expect((await api('POST', `/offers/${other.id}/withdraw`, 'milan.petrovic')).status).toBe(409);
  });

  it('nepostojeći datum, budući datum i premali iznos daju 400, ne 500', async () => {
    const expense = (body: object) => api('POST', `/buildings/${bulevar}/expenses`, 'milan.petrovic', { title: 'Test datuma', amount: 10, ...body });
    for (const occurredOn of ['2026-02-30', '2026-13-45', '2099-01-01']) expect((await expense({ occurredOn })).status).toBe(400);
    expect((await expense({ amount: 0.001 })).status).toBe(400);
    const csv = 'datum,uplatilac,iznos,poziv na broj,svrha\n31. 2. 2026.,Neko,"100,00",,x';
    expect((await api('POST', `/buildings/${bulevar}/bank-imports`, 'milan.petrovic', { fileName: 'd.csv', csv })).body.code).toBe('bad_csv');
    const announcement = { type: 'info', title: 'Stara objava', body: 'Tekst objave.', expiresAt: '2026-10-01' };
    expect((await api('POST', `/buildings/${bulevar}/announcements`, 'milan.petrovic', announcement)).status).toBe(400);
  });

  it('uplata sa ratom drugog stana se ne knjiži', async () => {
    await createMonthlyCharges('2026-12-01');
    const apartmentId = await apartment(7);
    const charge = (await one(pool, "SELECT id FROM charges WHERE building_id = ? AND apartment_id <> ? AND period = '2026-12' LIMIT 1", [bulevar, apartmentId]))!.id;
    const before = (await api('GET', `/buildings/${bulevar}/budget`, 'milan.petrovic')).body.balance;
    expect((await api('POST', `/buildings/${bulevar}/payments`, 'milan.petrovic', { apartmentId, amount: 4000, chargeId: charge })).body.code).toBe('bad_charge');
    expect((await api('GET', `/buildings/${bulevar}/budget`, 'milan.petrovic')).body.balance).toBe(before);
    await exec(pool, "DELETE FROM charges WHERE period = '2026-12'");
  });

  it('stornirana uplata je označena u listi upravnika', async () => {
    const payments = (await api('GET', `/buildings/${bulevar}/budget/manager`, 'milan.petrovic')).body.payments;
    const target = payments.find((p: any) => !p.reversed && !p.reversal);
    await api('POST', `/ledger/${target.id}/reverse`, 'milan.petrovic');
    const after = (await api('GET', `/buildings/${bulevar}/budget/manager`, 'milan.petrovic')).body.payments;
    expect(after.find((p: any) => p.id === target.id).reversed).toBe(true);
    expect(after.some((p: any) => p.reversal)).toBe(true);
  });

  it('upload proverava sadržaj, ne samo MIME', async () => {
    const boundary = '----t';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n<html><script>alert(1)</script></html>\r\n--${boundary}--\r\n`;
    const res = await app.inject({ method: 'POST', url: '/api/v1/uploads', headers: { authorization: `Bearer ${await login('milan.petrovic')}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(res.statusCode).toBe(400);
  });

  it('archived=false vraća aktuelne objave', async () => {
    const current = (await api('GET', `/buildings/${bulevar}/announcements`, 'jelena.kovac')).body;
    expect((await api('GET', `/buildings/${bulevar}/announcements?archived=false`, 'jelena.kovac')).body).toEqual(current);
  });

  it('isti refresh token sme da se ponovi samo jednom', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-forwarded-for': '10.20.30.40' }, payload: { email: 'dragan.ilic@test.upravko.rs', password: 'Test1234!' } });
    const refreshToken = JSON.parse(res.body).refreshToken;
    const refresh = () => api('POST', '/auth/refresh', null, { refreshToken });
    expect((await refresh()).status).toBe(200);
    expect((await refresh()).status).toBe(200);
    expect((await refresh()).status).toBe(401);
  });

  it('X-Forwarded-For koji upiše klijent ne zaobilazi limit prijave', async () => {
    const limited = await buildApp();
    await limited.ready();
    const attempt = (i: number) => limited.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.7` },
      payload: { email: 'milan.petrovic@test.upravko.rs', password: 'pogresna' },
    });
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await attempt(i)).statusCode);
    await limited.close();
    expect(codes.at(-1)).toBe(429);
  });
});

describe('preplata po stanu', () => {
  const mine = async () => (await api('GET', `/buildings/${bulevar}/budget`, 'jelena.kovac')).body.mine;
  const apartment7 = async () => (await one(pool, 'SELECT id FROM apartments WHERE building_id = ? AND number = 7', [bulevar]))!.id as string;
  const pay = async (amount: number) => api('POST', `/buildings/${bulevar}/payments`, 'milan.petrovic', { apartmentId: await apartment7(), amount });
  const reverse = (id: string) => api('POST', `/ledger/${id}/reverse`, 'milan.petrovic');
  // Stan 7 je do ovde sve platio; decembarska rata je otvorena rata za ove testove.
  beforeAll(() => createMonthlyCharges('2026-12-01'));
  afterAll(() => exec(pool, "DELETE FROM charges WHERE period IN ('2026-12', '2027-01')"));

  it('delimična uplata ostaje preplata, a sledeća uplata zatvara ratu', async () => {
    const start = await mine();
    const rate = start.unpaid[0].amount;
    const part = Math.round((rate - start.credit) / 2);
    const first = await pay(part);
    expect(first.status).toBe(200);
    const half = await mine();
    expect(half.unpaid).toHaveLength(start.unpaid.length);
    expect(half.credit).toBe(start.credit + part);
    expect(half.debt).toBe(start.debt - part);
    expect(half.ips.amount).toBe(rate - start.credit - part);
    const manager = (await api('GET', `/buildings/${bulevar}/budget/manager`, 'milan.petrovic')).body.overdue.find((o: any) => o.apartmentNumber === 7);
    if (manager) expect(manager.credit).toBe(start.credit + part);

    const rest = await pay(rate - start.credit - part);
    const done = await mine();
    expect(done.unpaid).toHaveLength(start.unpaid.length - 1);
    expect(done.credit).toBe(0);

    // Storno prve uplate ponovo otvara ratu; druga ostaje preplata.
    await reverse(first.body.id);
    const back = await mine();
    expect(back.unpaid).toHaveLength(start.unpaid.length);
    expect(back.credit).toBe(rate - part);
    await reverse(rest.body.id);
    const end = await mine();
    expect(end.credit).toBe(start.credit);
    expect(end.debt).toBe(start.debt);
  });

  it('nova mesečna rata se zatvara iz preplate', async () => {
    const start = await mine();
    const rate = start.unpaid[0].amount;
    const open = start.unpaid.reduce((sum: number, c: any) => sum + c.amount, 0);
    const paid = await pay(open - start.credit + rate);
    expect((await mine()).credit).toBe(rate);
    await createMonthlyCharges('2027-01-01');
    const after = await mine();
    expect(after.unpaid).toHaveLength(0);
    expect(after.credit).toBe(0);
    expect(after.paid.some((c: any) => c.period === '2027-01')).toBe(true);
    await reverse(paid.body.id);
    await exec(pool, "DELETE FROM charges WHERE period = '2027-01'");
    expect((await mine()).credit).toBe(start.credit);
  });

  it('Platio/la sam i izvod računaju ratu umanjenu za preplatu', async () => {
    const start = await mine();
    const rate = start.unpaid[0].amount;
    const part = 1000;
    const first = await pay(part);
    const owed = rate - start.credit - part;
    const claim = await api('POST', `/buildings/${bulevar}/payment-claims`, 'jelena.kovac', { scope: 'next' });
    expect(claim.body.amount).toBe(owed);
    await api('POST', `/payment-claims/${claim.body.id}/confirm`, 'milan.petrovic');
    const entry = await one(pool, 'SELECT l.id, l.amount FROM payment_claims p JOIN ledger_entries l ON l.id = p.ledger_entry_id WHERE p.id = ?', [claim.body.id]);
    expect(entry!.amount).toBe(owed);
    expect((await mine()).credit).toBe(0);
    await reverse(entry!.id);

    // Isto preko izvoda: iznos iz IPS koda se prepoznaje po pozivu na broj.
    const ips = (await mine()).ips;
    expect(ips.amount).toBe(owed);
    const csv = `datum,uplatilac,iznos,poziv na broj,svrha\n30. 10. 2026.,Jelena,${owed},${ips.reference},rata`;
    expect((await api('POST', `/buildings/${bulevar}/bank-imports`, 'milan.petrovic', { fileName: 'pp.csv', csv })).body).toEqual({ total: 1, matched: 1 });
    expect((await mine()).unpaid).toHaveLength(start.unpaid.length - 1);
    const line = await one(pool, 'SELECT ledger_entry_id FROM bank_import_lines WHERE reference = ? ORDER BY id DESC LIMIT 1', [ips.reference]);
    await reverse(line!.ledger_entry_id);
    await reverse(first.body.id);
    expect((await mine()).credit).toBe(start.credit);
  });
});
