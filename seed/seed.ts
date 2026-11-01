// Testni podaci tačno kao na ekranima dizajna.
//   npm run seed        puni bazu (ne radi ništa ako su test podaci već tu)
//   npm run seed:reset  briše samo test podatke i puni ponovo
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { exec, one, pool, rows, tx, uuid, type Db } from '../src/db.js';
import { hashPassword } from '../src/lib/auth.js';
import { saveFile } from '../src/lib/files.js';
import { chargeReference, mod97Check } from '../src/lib/ips.js';
import { migrate } from '../src/migrate.js';

const PASSWORD = 'Test1234!';
const IMAGES = path.resolve('../upravko-app/upravko-handoff/assets/seed-images');
export const BULEVAR_TOKEN = 'bulevar45-test-qr-kod';

/** Vreme kako piše u dizajnu (Beograd). Letnje računanje se završava 25. 10. 2026. */
const at = (local: string) => new Date(`${local.replace(' ', 'T')}${local < '2026-10-25 03:00' ? '+02:00' : '+01:00'}`);
const account = (base: string) => `${base}${mod97Check(base)}`;
const insertMany = (db: Db, table: string, cols: string[], values: unknown[][]) =>
  values.length ? exec(db, `INSERT INTO ${table} (${cols.join(', ')}) VALUES ?`, [values]) : Promise.resolve(null);

function pdf(title: string, lines: string[] = []) {
  const ascii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'dj').replace(/[()\\]/g, '');
  const text = [`BT /F1 20 Tf 50 780 Td (${ascii(title)}) Tj`, ...lines.map((l) => `0 -26 Td /F1 12 Tf (${ascii(l)}) Tj`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const image = (db: Db, name: string) =>
  saveFile(db, { data: fs.readFileSync(path.join(IMAGES, name)), mime: 'image/jpeg', originalName: name, uploadedBy: null });
const pdfFile = (db: Db, name: string, title: string, lines: string[] = []) =>
  saveFile(db, { data: pdf(title, lines), mime: 'application/pdf', originalName: name, uploadedBy: null });

let passwordHash = '';
async function user(db: Db, email: string, fullName: string, phone: string | null = null) {
  const id = uuid();
  await exec(db, 'INSERT INTO users (id, email, password_hash, full_name, phone, is_test, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', [id, email, passwordHash, fullName, phone, at('2026-05-01 10:00')]);
  return id;
}

async function org(db: Db, name: string, variant: string, c: [string, string, string, string]) {
  const id = uuid();
  await exec(db, 'INSERT INTO organizations (id, name, logo_variant, color_primary, color_primary_dark, color_secondary, color_accent, is_test, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)', [id, name, variant, ...c, at('2026-05-01 10:00')]);
  return id;
}

async function building(db: Db, b: { orgId: string; address: string; count: number; cover: string; fee: number; account: string; recipient: string; code: string; managerId: string; token: string; inviteAt: Date }) {
  const id = uuid();
  await exec(
    db,
    `INSERT INTO buildings (id, organization_id, address, city, apartments_count, cover_image_path, currency, fee_mode, fee_amount, fee_day_of_month, payment_mode, bank_account, recipient_name, building_code, created_at)
     VALUES (?, ?, ?, 'Novi Sad', ?, ?, 'RSD', 'per_apartment', ?, 1, 'direct', ?, ?, ?, ?)`,
    [id, b.orgId, b.address, b.count, b.cover, b.fee, b.account, b.recipient, b.code, at('2026-05-01 10:00')],
  );
  const apartments = new Map<number, string>();
  const list = Array.from({ length: b.count }, (_, i) => {
    const aptId = uuid();
    apartments.set(i + 1, aptId);
    return [aptId, id, i + 1, 38 + ((i * 17) % 55)];
  });
  await insertMany(db, 'apartments', ['id', 'building_id', 'number', 'area_m2'], list);
  await exec(db, 'INSERT INTO building_managers (building_id, user_id, created_at) VALUES (?, ?, ?)', [id, b.managerId, at('2026-05-01 10:00')]);
  const inviteId = uuid();
  await exec(db, 'INSERT INTO building_invite_codes (id, building_id, token, created_at) VALUES (?, ?, ?, ?)', [inviteId, id, b.token, b.inviteAt]);
  return { id, apartments, inviteId };
}

type Built = Awaited<ReturnType<typeof building>>;
type Member = { number: number; userId: string; role?: 'owner' | 'tenant'; status?: 'pending' | 'approved'; invited?: boolean; createdAt?: Date };

async function members(db: Db, b: Built, managerId: string, list: Member[]) {
  await insertMany(db, 'memberships', ['id', 'building_id', 'apartment_id', 'user_id', 'role', 'status', 'invite_code_id', 'decided_by', 'decided_at', 'created_at'],
    list.map((m) => {
      const approved = (m.status ?? 'approved') === 'approved';
      const created = m.createdAt ?? at('2026-09-05 12:00');
      return [uuid(), b.id, b.apartments.get(m.number), m.userId, m.role ?? 'owner', m.status ?? 'approved', m.invited ? b.inviteId : null, approved ? managerId : null, approved ? created : null, created];
    }));
}

/** Tačan budžet sa §6: krajnje stanje 284.300 RSD. */
async function ledger(db: Db, b: Built, managerId: string) {
  const entry = (type: string, sign: number, amount: number, title: string, on: string, extra: { apartment?: string; issue?: string; invoice?: string } = {}) => {
    const id = uuid();
    return { id, row: [id, b.id, type, sign, amount, title, on, extra.apartment ?? null, extra.issue ?? null, extra.invoice ?? null, managerId, at(`${on} 12:00`)] };
  };
  const invoice = await pdfFile(db, 'racun.pdf', 'Racun', ['Testni racun iz seed podataka']);
  const ledgerRows: unknown[][] = [entry('opening', 1, 182400, 'Početno stanje', '2026-05-31').row];
  const months: [string, string, [string, number, string, boolean?][]][] = [
    ['2026-06', 'jun', [['Čišćenje ulaza, jun', 9800, '12'], ['Struja zajedničkih prostorija, jun', 6200, '14'], ['Redovan servis lifta, jun', 12500, '18'], ['Popravka interfona', 35000, '24']]],
    ['2026-07', 'jul', [['Čišćenje ulaza, jul', 9800, '13'], ['Struja zajedničkih prostorija, jul', 5900, '14'], ['Redovan servis lifta, jul', 12500, '17'], ['Krečenje stepeništa', 51100, '27']]],
    ['2026-08', 'avgust', [['Čišćenje ulaza, avgust', 9800, '12'], ['Struja zajedničkih prostorija, avgust', 5700, '14'], ['Redovan servis lifta, avgust', 12500, '19'], ['Orezivanje zelenila', 18000, '21'], ['Zamena oluka', 33500, '26']]],
    ['2026-09', 'septembar', [['Čišćenje ulaza, septembar', 9800, '11'], ['Struja zajedničkih prostorija, septembar', 6100, '14'], ['Veliki servis lifta', 31200, '16'], ['Hidroizolacija dela krova', 68400, '25']]],
    ['2026-10', 'oktobar', [['Čišćenje ulaza, oktobar', 9800, '15']]],
  ];
  for (const [period, , expenses] of months) {
    for (const [title, amount, day] of expenses) ledgerRows.push(entry('expense', -1, amount, title, `${period}-${day}`, { invoice }).row);
  }
  const skip: Record<string, number[]> = { '2026-09': [5, 12, 19], '2026-10': [5, 14] };
  const chargeRows: unknown[][] = [];
  const octoberLines: unknown[][] = [];
  const importId = uuid();
  const payment = (number: number, period: string, on: string) => {
    const apartment = b.apartments.get(number)!;
    const e = entry('income', 1, 4000, `Uplata, stan ${number}`, on, { apartment });
    ledgerRows.push(e.row);
    const chargeId = uuid();
    chargeRows.push([chargeId, b.id, apartment, period, 4000, `${period}-15`, at(`${on} 12:00`), e.id, at(`${period}-01 00:10`)]);
    return { entryId: e.id, chargeId, apartment };
  };
  for (const [period] of months) {
    for (let n = 1; n <= 24; n++) {
      if (skip[period]?.includes(n)) continue;
      const jelena = n === 7 && (period === '2026-09' ? '06' : period === '2026-10' ? '08' : null);
      const on = `${period}-${jelena || String(1 + ((n * 3) % 27)).padStart(2, '0')}`;
      const paid = payment(n, period, on);
      if (period === '2026-10') {
        const ref = chargeReference(n, period);
        octoberLines.push([uuid(), importId, on, `Stan ${n}`, 4000, `97${mod97Check(ref)}${ref}`, 'Rata za oktobar', paid.apartment, paid.chargeId, paid.entryId, 'matched']);
      }
    }
  }
  // Zakasnele septembarske uplate stanova 12 i 19 ulaze u oktobar (ukupno 96.000).
  payment(12, '2026-09', '2026-10-20');
  payment(19, '2026-09', '2026-10-21');
  // Neplaćeno: stan 5 sep + okt, stan 14 okt = dospelih 12.000. Novembar je zadužen za sve.
  for (const [number, period] of [[5, '2026-09'], [5, '2026-10'], [14, '2026-10']] as [number, string][]) {
    chargeRows.push([uuid(), b.id, b.apartments.get(number), period, 4000, `${period}-15`, null, null, at(`${period}-01 00:10`)]);
  }
  for (let n = 1; n <= 24; n++) chargeRows.push([uuid(), b.id, b.apartments.get(n), '2026-11', 4000, '2026-11-15', null, null, at('2026-10-30 08:00')]);
  await insertMany(db, 'ledger_entries', ['id', 'building_id', 'type', 'sign', 'amount', 'title', 'occurred_on', 'apartment_id', 'issue_id', 'invoice_path', 'created_by', 'created_at'], ledgerRows);
  await insertMany(db, 'charges', ['id', 'building_id', 'apartment_id', 'period', 'amount', 'due_date', 'paid_at', 'payment_entry_id', 'created_at'], chargeRows);
  await exec(db, 'INSERT INTO bank_imports (id, building_id, file_name, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [importId, b.id, 'Izvod_oktobar.csv', managerId, at('2026-10-29 09:00')]);
  await insertMany(db, 'bank_import_lines', ['id', 'import_id', 'occurred_on', 'payer', 'amount', 'reference', 'purpose', 'matched_apartment_id', 'matched_charge_id', 'ledger_entry_id', 'status'], [
    ...octoberLines,
    // Nepovezane ne ulaze u budžet dok ih upravnik ne poveže.
    [uuid(), importId, '2026-10-27', 'M. Jovanović', 4000, null, null, null, null, null, 'unmatched'],
    [uuid(), importId, '2026-10-28', 'D. Ilić', 8000, null, 'stan 12 sep i okt', null, null, null, 'unmatched'],
  ]);
  return invoice;
}

async function issue(db: Db, i: { buildingId: string; title: string; shortTitle?: string; description: string; location: string; urgency: string; status: string; reporter: string | null; apartment: string | null; anonymous?: boolean; createdAt: Date; resolvedAt?: Date }) {
  const id = uuid();
  await exec(db, 'INSERT INTO issues (id, building_id, title, short_title, description, location, urgency, status, reporter_user_id, reporter_apartment_id, is_anonymous, resolved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, i.buildingId, i.title, i.shortTitle ?? null, i.description, i.location, i.urgency, i.status, i.reporter, i.apartment, i.anonymous ? 1 : 0, i.resolvedAt ?? null, i.createdAt]);
  return id;
}
const photos = (db: Db, issueId: string, paths: string[], kind = 'report') =>
  insertMany(db, 'issue_photos', ['id', 'issue_id', 'path', 'kind', 'sort'], paths.map((p, i) => [uuid(), issueId, p, kind, i]));
const event = (db: Db, issueId: string, type: string, actor: string | null, when: Date, payload?: unknown) =>
  exec(db, 'INSERT INTO issue_events (id, issue_id, type, actor_user_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)', [uuid(), issueId, type, actor, payload ? JSON.stringify(payload) : null, when]);
async function comment(db: Db, issueId: string, userId: string, body: string, when: Date) {
  const id = uuid();
  await exec(db, 'INSERT INTO issue_comments (id, issue_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)', [id, issueId, userId, body, when]);
  await event(db, issueId, 'comment', userId, when, { commentId: id });
}
const hurries = (db: Db, issueId: string, apartments: Map<number, string>, numbers: number[], userFor: (n: number) => string | null) =>
  insertMany(db, 'issue_hurries', ['issue_id', 'apartment_id', 'user_id', 'created_at'], numbers.map((n) => [issueId, apartments.get(n), userFor(n), at('2026-10-29 12:00')]));

async function offer(db: Db, issueId: string, managerId: string, o: { contractor: string; price: number; days: number; when: Date; note?: string }) {
  const id = uuid();
  const file = await pdfFile(db, `${o.contractor.replace(/\W/g, '')}_predracun.pdf`, `Predracun: ${o.contractor}`, [`Iznos: ${o.price} RSD`, `Rok izvodjenja: ${o.days} dana`]);
  await exec(db, 'INSERT INTO offers (id, issue_id, contractor, price, duration_days, pdf_path, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, issueId, o.contractor, o.price, o.days, file, o.note ?? null, managerId, o.when]);
  return id;
}

/** Problemi, glasanje i objave; isti set ide i u Stan Plus zgradu. */
async function content(db: Db, b: Built, p: { managerId: string; ana: string; dragan: string; jelena: string; userFor: (n: number) => string | null; invoice: string; images: Record<string, string> }) {
  const a = b.apartments;
  const img = p.images;

  const door = await issue(db, { buildingId: b.id, title: 'Ulazna vrata se ne zatvaraju', shortTitle: 'Ulazna vrata', description: 'Brava ne hvata i vrata ostaju odškrinuta. Noću ulaze nepoznate osobe, a zimi se hladi ceo ulaz. Opruga na vrhu vrata je pukla.', location: 'ulaz', urgency: 'high', status: 'voting', reporter: p.ana, apartment: a.get(3)!, createdAt: at('2026-10-24 18:32') });
  await photos(db, door, [img.door!, img.svetlo!, img.zgrada2!]);
  await event(db, door, 'reported', p.ana, at('2026-10-24 18:32'), { photos: 3 });
  await event(db, door, 'status_changed', p.managerId, at('2026-10-25 10:01'), { from: 'reported', to: 'received' });
  await comment(db, door, p.managerId, 'Kontaktiran servis za vrata. Tražim ponude od tri firme.', at('2026-10-25 10:05'));
  await comment(db, door, p.dragan, 'Sinoć su vrata opet stajala otvorena do jutra. Molim da ide što pre.', at('2026-10-27 21:40'));
  const alPro = await offer(db, door, p.managerId, { contractor: 'Al-Pro', price: 216450, days: 10, when: at('2026-10-29 10:00'), note: 'Nova brava, opruga i samozatvarač. Garancija 2 godine.' });
  const metalac = await offer(db, door, p.managerId, { contractor: 'Metalac', price: 257400, days: 7, when: at('2026-10-29 11:00') });
  const vrataPlus = await offer(db, door, p.managerId, { contractor: 'Vrata Plus', price: 187200, days: 21, when: at('2026-10-29 12:00') });
  await event(db, door, 'offer_added', p.managerId, at('2026-10-29 10:00'), { contractor: 'Al-Pro', price: 216450 });
  await event(db, door, 'offer_added', p.managerId, at('2026-10-29 11:00'), { contractor: 'Metalac', price: 257400 });
  await event(db, door, 'offer_added', p.managerId, at('2026-10-29 12:00'), { contractor: 'Vrata Plus', price: 187200 });
  await event(db, door, 'status_changed', p.managerId, at('2026-10-30 09:10'), { from: 'offers', to: 'voting' });
  await comment(db, door, p.managerId, 'Stigle su tri ponude. Glasanje je otvoreno do 2. 11. u 20h.', at('2026-10-30 09:12'));
  const session = uuid();
  await exec(db, "INSERT INTO votes_sessions (id, issue_id, deadline, majority_rule, opened_by, opened_at) VALUES (?, ?, ?, 'simple', ?, ?)", [session, door, at('2026-11-02 20:00'), p.managerId, at('2026-10-30 09:10')]);
  const ballots: [number, string][] = [
    ...[7, 1, 2, 3, 4, 6, 8, 9, 10].map((n) => [n, alPro] as [number, string]),
    ...[11, 13, 15, 16, 17].map((n) => [n, metalac] as [number, string]),
    ...[20, 22, 23].map((n) => [n, vrataPlus] as [number, string]),
  ];
  await insertMany(db, 'votes', ['session_id', 'apartment_id', 'offer_id', 'voted_by_user_id', 'updated_at'], ballots.map(([n, o]) => [session, a.get(n), o, p.userFor(n), at('2026-10-30 10:00')]));
  await hurries(db, door, a, [7, 1, 2, 3, 4, 6, 8, 9, 10, 11, 13], p.userFor);

  const lift = await issue(db, { buildingId: b.id, title: 'Lift staje između 3. i 4. sprata', description: 'Lift se povremeno zaustavi između spratova i vrata se ne otvaraju. Treba mu dugme za alarm nekoliko puta pritisnuti da krene.', location: 'lift', urgency: 'high', status: 'in_progress', reporter: p.dragan, apartment: a.get(12)!, createdAt: at('2026-10-21 08:15') });
  await photos(db, lift, [img.lift!]);
  await event(db, lift, 'reported', p.dragan, at('2026-10-21 08:15'), { photos: 1 });
  await event(db, lift, 'status_changed', p.managerId, at('2026-10-21 12:00'), { from: 'reported', to: 'received' });
  await event(db, lift, 'status_changed', p.managerId, at('2026-10-23 09:00'), { from: 'received', to: 'in_progress' });
  await hurries(db, lift, a, [1, 2, 3, 4, 6, 8, 12], p.userFor);

  const leak = await issue(db, { buildingId: b.id, title: 'Curenje u podrumu', description: 'Voda curi iz cevi pored ostave br. 5, na podu je bara. Miriše na vlagu.', location: 'podrum', urgency: 'medium', status: 'offers', reporter: p.dragan, apartment: a.get(12)!, anonymous: true, createdAt: at('2026-10-28 19:20') });
  await photos(db, leak, [img.podrum!]);
  await event(db, leak, 'reported', p.dragan, at('2026-10-28 19:20'), { photos: 1 });
  await event(db, leak, 'status_changed', p.managerId, at('2026-10-29 08:30'), { from: 'reported', to: 'received' });
  await offer(db, leak, p.managerId, { contractor: 'AquaFix', price: 31500, days: 1, when: at('2026-10-29 15:00') });
  await offer(db, leak, p.managerId, { contractor: 'Vodomont NS', price: 24000, days: 3, when: at('2026-10-29 16:00') });
  await event(db, leak, 'offer_added', p.managerId, at('2026-10-29 15:00'), { contractor: 'AquaFix', price: 31500 });
  await event(db, leak, 'offer_added', p.managerId, at('2026-10-29 16:00'), { contractor: 'Vodomont NS', price: 24000 });
  await event(db, leak, 'status_changed', p.managerId, at('2026-10-29 16:01'), { from: 'received', to: 'offers' });
  await hurries(db, leak, a, [1, 2, 4, 6], p.userFor);

  const light = await issue(db, { buildingId: b.id, title: 'Ne radi svetlo na 5. spratu', description: 'Na 5. spratu svetlo u hodniku ne radi već nedelju dana. Senzor ne reaguje.', location: 'stepeniste', urgency: 'low', status: 'resolved', reporter: p.ana, apartment: a.get(3)!, createdAt: at('2026-10-22 20:10'), resolvedAt: at('2026-10-29 14:00') });
  await photos(db, light, [img.svetlo!]);
  await photos(db, light, [img.svetlo!], 'after_fix');
  await event(db, light, 'reported', p.ana, at('2026-10-22 20:10'), { photos: 1 });
  await event(db, light, 'status_changed', p.managerId, at('2026-10-23 10:00'), { from: 'reported', to: 'received' });
  await event(db, light, 'resolved', p.managerId, at('2026-10-29 14:00'), { amount: 18500, photos: 1 });
  await exec(db, `INSERT INTO ledger_entries (id, building_id, type, sign, amount, title, occurred_on, issue_id, invoice_path, created_by, created_at) VALUES (?, ?, 'expense', -1, 18500, 'Zamena sijalica i senzora u hodniku', '2026-10-29', ?, ?, ?, ?)`, [uuid(), b.id, light, p.invoice, p.managerId, at('2026-10-29 14:00')]);

  // Objave
  const skup = await pdfFile(db, 'Poziv za skupštinu.pdf', 'Poziv za skupstinu', ['Cetvrtak 6. 11. u 19h, prostorija u prizemlju']);
  const zapisnik = await pdfFile(db, 'Zapisnik oktobar.pdf', 'Zapisnik sa sastanka, oktobar');
  const news: [string, Partial<{ summary: string; attachment: string; pinned: number; expires: string; eventAt: Date; place: string }>, string, string, Date, number[]][] = [
    ['meeting', { summary: 'Prostorija u prizemlju. Na dnevnom redu: ulazna vrata i fasada.', attachment: skup, pinned: 1, expires: '2026-11-07', eventAt: at('2026-11-06 19:00'), place: 'Prostorija u prizemlju' }, 'Skupština stanara u četvrtak 6. 11. u 19h',
      'Pozivam sve vlasnike i zakupce na redovnu skupštinu. Na dnevnom redu:\n\n1. Izbor izvođača za ulazna vrata\n2. Ponude za krečenje fasade\n3. Plan održavanja za 2027.\n\nAko ne možete da dođete, glasajte u aplikaciji. Zapisnik stiže dan posle.', at('2026-10-28 12:30'),
      [7, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19]],
    ['urgent', {}, 'Bez vode u utorak od 9 do 12h', 'Vodovod menja ventil u ulici.', at('2026-10-30 08:30'), [1, 2, 3, 4, 5, 6, 8, 9, 10]],
    ['payment_reminder', {}, 'Rata za novembar do 15. 11.', '4.000 RSD, IPS QR je u Budžetu.', at('2026-10-29 18:00'), [1, 2, 3]],
    ['info', {}, 'Zamenjene sijalice i senzori u hodniku', 'Trošak 18.500 RSD, račun u Budžetu.', at('2026-10-29 14:30'), [7, 1, 2, 3]],
    ['meeting', { attachment: zapisnik }, 'Zapisnik sa sastanka, oktobar', 'PDF · 2 strane', at('2026-10-20 18:00'), [7, 1, 2, 3, 4]],
  ];
  for (const [type, o, title, body, when, reads] of news) {
    const id = uuid();
    await exec(db, 'INSERT INTO announcements (id, building_id, type, title, summary, body, attachment_path, pinned, expires_at, event_at, event_place, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, b.id, type, title, o.summary ?? null, body, o.attachment ?? null, o.pinned ?? 0, o.expires ?? null, o.eventAt ?? null, o.place ?? null, p.managerId, when]);
    await insertMany(db, 'announcement_reads', ['announcement_id', 'apartment_id', 'read_at'], reads.map((n) => [id, a.get(n), when]));
  }
}

async function thread(db: Db, buildingId: string, residentId: string, subject: string, status: string, messages: [string, string, Date][]) {
  const id = uuid();
  const last = messages[messages.length - 1]![2];
  await exec(db, 'INSERT INTO private_threads (id, building_id, resident_user_id, subject, status, resident_read_at, manager_read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, buildingId, residentId, subject, status, last, status === 'closed' ? last : null, messages[0]![2]]);
  await insertMany(db, 'private_messages', ['id', 'thread_id', 'sender_user_id', 'body', 'created_at'], messages.map(([sender, body, when]) => [uuid(), id, sender, body, when]));
}

async function services(db: Db, orgId: string) {
  const list = [
    ['lift', 'Lift Servis NS', 'Zoran Đurić', '021 456 789', 'kontakt@liftservisns.test'],
    ['zelenilo', 'Zelena bašta', 'Ivana Krstić', '064 221 908', 'ivana@zelenabasta.test'],
    ['ciscenje', 'Čistoća Plus', 'Mira Babić', '063 410 225', 'mira@cistocaplus.test'],
    ['elektricar', 'Elektro Sigma', 'Bojan Nikolić', '065 778 140', 'bojan@elektrosigma.test'],
    ['vodoinstalater', 'Vodomont NS', 'Đorđe Mitić', '062 903 551', 'djordje@vodomont.test'],
    ['grejanje', 'Toplana, dežurna služba', 'Dežurni', '021 480 6000', 'dezurni@toplana.test'],
  ];
  await insertMany(db, 'service_providers', ['id', 'organization_id', 'category', 'company', 'contact_person', 'phone', 'email', 'created_at'],
    list.map((s, i) => [uuid(), orgId, ...s, new Date(at('2026-05-01 10:00').getTime() + i * 1000)]));
}

export async function clearTestData() {
  const files = await rows(pool, 'SELECT path FROM uploads WHERE uploaded_by IS NULL');
  await exec(pool, 'DELETE FROM organizations WHERE is_test = 1');
  await exec(pool, 'DELETE FROM users WHERE is_test = 1');
  if (files.length) {
    await exec(pool, 'DELETE FROM uploads WHERE path IN (?)', [files.map((f) => f.path)]);
    for (const f of files) fs.rmSync(path.join(config.storageDir, f.path), { force: true });
  }
}

export async function seed() {
  passwordHash = await hashPassword(PASSWORD);
  await tx(async (db) => {
    const images = Object.fromEntries(await Promise.all(['door', 'lift', 'podrum', 'svetlo', 'zgrada1', 'zgrada2'].map(async (n) => [n, await image(db, `${n}.jpg`)])));
    const upravko = await org(db, 'Upravko', 'upravko', ['#2B44C9', '#8EA2FF', '#0E1631', '#C6F36D']);
    const stanPlus = await org(db, 'Stan Plus', 'stanplus', ['#0E6E6A', '#5FD3C8', '#0B3B3A', '#FFD36E']);

    const milan = await user(db, 'milan.petrovic@test.upravko.rs', 'Milan Petrović', '+381 63 100 200');
    const jelena = await user(db, 'jelena.kovac@test.upravko.rs', 'Jelena Kovač', '+381 64 123 4567');
    const dragan = await user(db, 'dragan.ilic@test.upravko.rs', 'Dragan Ilić', '+381 64 300 400');
    const ana = await user(db, 'ana.markovic@test.upravko.rs', 'Ana Marković', '+381 65 200 111');
    const goran = await user(db, 'goran.lukic@test.upravko.rs', 'Goran Lukić', '+381 63 700 800');
    const sanja = await user(db, 'sanja.rakic@test.upravko.rs', 'Sanja Rakić', '+381 64 555 600');
    const nikola = await user(db, 'nikola.stanic@test.upravko.rs', 'Nikola Stanić', '+381 63 555 210');
    const petra = await user(db, 'petra.jovanovic@test.upravko.rs', 'Petra Jovanović', '+381 64 902 118');
    const milica = await user(db, 'milica.popovic@test.upravko.rs', 'Milica Popović', '+381 65 330 447');

    const bulevar = await building(db, {
      orgId: upravko, address: 'Bulevar oslobođenja 45', count: 24, cover: images.zgrada1!, fee: 4000, account: account('1600000000012345'),
      recipient: 'SZ Bulevar oslobođenja 45', code: 'BUL45NS', managerId: milan, token: BULEVAR_TOKEN, inviteAt: at('2026-09-01 10:00'),
    });
    // Stanovi 18 i 21 nemaju stanara: na njih čekaju zahtevi Petre i Milice.
    const others: [number, string, string][] = [
      [1, 'Marko Savić', 'marko.savic'], [2, 'Ivana Tomić', 'ivana.tomic'], [4, 'Stefan Nikolić', 'stefan.nikolic'], [6, 'Maja Đorđević', 'maja.djordjevic'],
      [8, 'Nenad Popov', 'nenad.popov'], [9, 'Tijana Vuković', 'tijana.vukovic'], [10, 'Bojan Radić', 'bojan.radic'], [11, 'Olivera Janković', 'olivera.jankovic'],
      [13, 'Vladimir Stojanović', 'vladimir.stojanovic'], [15, 'Katarina Pavlović', 'katarina.pavlovic'], [16, 'Miloš Živković', 'milos.zivkovic'],
      [17, 'Jovana Mitrović', 'jovana.mitrovic'], [19, 'Aleksandar Lazić', 'aleksandar.lazic'], [20, 'Dunja Ristić', 'dunja.ristic'],
      [22, 'Predrag Simić', 'predrag.simic'], [23, 'Nataša Bogdanović', 'natasa.bogdanovic'], [24, 'Luka Vasić', 'luka.vasic'],
    ];
    const byNumber = new Map<number, string>([[3, ana], [5, goran], [7, jelena], [12, dragan], [14, sanja]]);
    for (const [n, name, slug] of others) byNumber.set(n, await user(db, `${slug}@test.upravko.rs`, name));
    let invited = 0;
    const approved: Member[] = [...byNumber.entries()].sort((x, y) => x[0] - y[0]).map(([number, userId]) => ({ number, userId, invited: ++invited <= 18 }));
    await members(db, bulevar, milan, [
      ...approved,
      { number: 12, userId: nikola, status: 'pending', createdAt: at('2026-10-28 11:00'), invited: true },
      { number: 18, userId: petra, role: 'tenant', status: 'pending', createdAt: at('2026-10-29 17:00'), invited: true },
      { number: 21, userId: milica, status: 'pending', createdAt: at('2026-10-30 08:00'), invited: true },
    ]);
    const invoice = await ledger(db, bulevar, milan);
    await content(db, bulevar, { managerId: milan, ana, dragan, jelena, userFor: (n) => byNumber.get(n) ?? null, invoice, images: images as Record<string, string> });

    // Sanja je prijavila uplatu za oktobar; čeka potvrdu upravnika.
    const sanjaCharge = await one(db, "SELECT id FROM charges WHERE apartment_id = ? AND period = '2026-10'", [bulevar.apartments.get(14)]);
    const sanjaClaim = uuid();
    await exec(db, 'INSERT INTO payment_claims (id, building_id, apartment_id, user_id, amount, created_at) VALUES (?, ?, ?, ?, 4000, ?)', [sanjaClaim, bulevar.id, bulevar.apartments.get(14), sanja, at('2026-10-30 09:30')]);
    await exec(db, 'INSERT INTO payment_claim_charges (claim_id, charge_id) VALUES (?, ?)', [sanjaClaim, sanjaCharge!.id]);

    await thread(db, bulevar.id, jelena, 'Buka iz stana iznad', 'open', [
      [jelena, 'Poštovani, već treću noć zaredom posle ponoći se čuje bušenje iz stana 11. Ne bih da pišem u grupu, da li možete da razgovarate sa njima?', at('2026-10-30 08:50')],
      [milan, 'Razgovaraću sa njima ove nedelje i javiti vam.', at('2026-10-30 10:24')],
    ]);
    await thread(db, bulevar.id, jelena, 'Ključ za podrum', 'closed', [
      [jelena, 'Da li mogu da preuzmem ključ za podrum?', at('2026-10-21 09:00')],
      [milan, 'Možete, kod mene je u kancelariji.', at('2026-10-21 12:00')],
      [jelena, 'Preuzela sam ključ, hvala!', at('2026-10-22 18:00')],
    ]);
    await thread(db, bulevar.id, jelena, 'Uplata za avgust', 'closed', [
      [jelena, 'Uplatila sam ratu za avgust, ne vidim je u aplikaciji.', at('2026-09-02 10:00')],
      [milan, 'Uplata je evidentirana, dug je 0 RSD.', at('2026-09-03 09:00')],
    ]);
    await thread(db, bulevar.id, ana, 'Vlaga u zidu kupatila', 'open', [
      [ana, 'Mislim da curi vertikala, isto vidim i kod komšije ispod.', at('2026-10-29 18:40')],
    ]);
    await thread(db, bulevar.id, dragan, 'Ključ za podrum', 'closed', [
      [dragan, 'Da li ste ostavili ključ kod domara?', at('2026-10-22 10:00')],
      [milan, 'Jesam, možete da ga preuzmete.', at('2026-10-22 11:00')],
    ]);
    await services(db, upravko);

    const fronta = await building(db, {
      orgId: upravko, address: 'Narodnog fronta 12', count: 16, cover: images.zgrada2!, fee: 3000, account: account('1600000000067890'),
      recipient: 'SZ Narodnog fronta 12', code: 'NF12NS', managerId: milan, token: 'fronta12-test-qr-kod', inviteAt: at('2026-09-01 10:00'),
    });
    await members(db, fronta, milan, [{ number: 4, userId: jelena, role: 'tenant' }]);
    await exec(db, "INSERT INTO ledger_entries (id, building_id, type, sign, amount, title, occurred_on, created_by, created_at) VALUES (?, ?, 'opening', 1, 131700, 'Početno stanje', '2026-05-31', ?, ?)", [uuid(), fronta.id, milan, at('2026-05-31 12:00')]);
    const intercom = await issue(db, { buildingId: fronta.id, title: 'Ne radi interfon za stan 4', description: 'Interfon ne zvoni u stanu 4.', location: 'ulaz', urgency: 'medium', status: 'received', reporter: jelena, apartment: fronta.apartments.get(4)!, createdAt: at('2026-10-27 10:00') });
    await event(db, intercom, 'reported', jelena, at('2026-10-27 10:00'), { photos: 0 });
    await event(db, intercom, 'status_changed', milan, at('2026-10-28 09:00'), { from: 'reported', to: 'received' });

    // Stan Plus: isti tip podataka, drugi brend. Razlika dolazi samo iz organizacije.
    const spManager = await user(db, 'stanplus.upravnik@test.upravko.rs', 'Vesna Lazarević', '+381 63 900 100');
    const spResident = await user(db, 'stanplus.stanar@test.upravko.rs', 'Tamara Ilić', '+381 64 900 200');
    const spAna = await user(db, 'stanplus.stan3@test.upravko.rs', 'Ana Marković', null);
    const spDragan = await user(db, 'stanplus.stan12@test.upravko.rs', 'Dragan Ilić', null);
    const lazar = await building(db, {
      orgId: stanPlus, address: 'Bulevar cara Lazara 10', count: 24, cover: images.zgrada1!, fee: 4000, account: account('1600000000054321'),
      recipient: 'SZ Bulevar cara Lazara 10', code: 'BCL10NS', managerId: spManager, token: 'lazar10-test-qr-kod', inviteAt: at('2026-09-01 10:00'),
    });
    await members(db, lazar, spManager, [{ number: 3, userId: spAna }, { number: 7, userId: spResident }, { number: 12, userId: spDragan }]);
    const spInvoice = await ledger(db, lazar, spManager);
    const spUsers = new Map([[3, spAna], [7, spResident], [12, spDragan]]);
    await content(db, lazar, { managerId: spManager, ana: spAna, dragan: spDragan, jelena: spResident, userFor: (n) => spUsers.get(n) ?? null, invoice: spInvoice, images: images as Record<string, string> });
    await services(db, stanPlus);
  });
}

if (process.argv[1]?.endsWith('seed.ts')) {
  await migrate();
  const exists = await one(pool, 'SELECT 1 AS ok FROM organizations WHERE is_test = 1 LIMIT 1');
  if (process.argv.includes('--reset')) await clearTestData();
  else if (exists) {
    console.log('Test podaci već postoje. Za ponovno punjenje: npm run seed:reset');
    process.exit(0);
  }
  await seed();
  console.log(`Seed gotov. Lozinka svih test naloga: ${PASSWORD}`);
  console.log(`QR link za registraciju: ${config.appLink}join/${BULEVAR_TOKEN}`);
  process.exit(0);
}
