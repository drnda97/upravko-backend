import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exec, one, pool, rows, tx, uuid, type Db } from '../db.js';
import { buildingAccess, requireManager } from '../lib/access.js';
import { userId } from '../lib/auth.js';
import { addEntry, allocatePayment, balance, overdueTotal, reservations } from '../lib/budget.js';
import { localDate, now } from '../lib/clock.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { assertOwnUpload, signedUrl } from '../lib/files.js';
import { allChargesReference, chargeReference, fullReference, ipsPayload, parseReference } from '../lib/ips.js';
import { toBuilding } from '../lib/realtime.js';
import { settleClaims } from './claims.js';

const amount = z.coerce.number().positive('Unesite iznos.').max(1e10);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function monthsBack(today: string, count: number) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(year, month - 1 - (count - 1 - i), 1));
    const period = d.toISOString().slice(0, 7);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    return { period, end };
  });
}

async function myCharges(buildingId: string, apartmentId: string, apartmentNumber: number) {
  const b = await one(pool, 'SELECT * FROM buildings WHERE id = ?', [buildingId]);
  const list = await rows(
    pool,
    `SELECT c.*, l.occurred_on AS paid_on FROM charges c LEFT JOIN ledger_entries l ON l.id = c.payment_entry_id
     WHERE c.apartment_id = ? AND c.cancelled_at IS NULL ORDER BY c.period DESC`,
    [apartmentId],
  );
  const claims = await rows(pool, "SELECT id, amount, status, created_at FROM payment_claims WHERE apartment_id = ? ORDER BY COALESCE(decided_at, created_at) DESC, status = 'rejected' DESC", [apartmentId]);
  const pending = claims.filter((c) => c.status === 'pending');
  const claimed = pending.length
    ? new Set((await rows(pool, 'SELECT charge_id FROM payment_claim_charges WHERE claim_id IN (?)', [pending.map((c) => c.id)])).map((r) => r.charge_id))
    : new Set();
  const unpaid = list.filter((c) => !c.paid_at).sort((x, y) => x.period.localeCompare(y.period));
  const payable = unpaid.filter((c) => !claimed.has(c.id));
  // IPS postoji samo za dinarske uplate direktno na račun zgrade.
  const canPay = b!.payment_mode === 'direct' && b!.currency === 'RSD' && !!b!.bank_account;
  const recipient = b!.recipient_name ?? `SZ ${b!.address}`;
  const qr = (amount: number, reference: string, purpose: string) => ({
    amount, recipient, account: b!.bank_account, reference: fullReference(reference),
    payload: ipsPayload({ account: b!.bank_account, recipient, amount, purpose, reference }),
  });
  const next = payable[0];
  const ips = canPay && next
    ? { ...qr(next.amount, chargeReference(apartmentNumber, next.period), `Rata ${next.period} stan ${apartmentNumber}`), period: next.period }
    : null;
  const ipsAll = canPay && payable.length > 1
    ? { ...qr(payable.reduce((sum, c) => sum + c.amount, 0), allChargesReference(apartmentNumber), `Rate stan ${apartmentNumber}`), periods: payable.map((c) => c.period) }
    : null;
  return {
    apartmentNumber, feeAmount: b!.fee_amount, feeMode: b!.fee_mode, paymentMode: b!.payment_mode,
    debt: unpaid.reduce((sum, c) => sum + c.amount, 0), nextDue: unpaid[0]?.due_date ?? null,
    paid: list.filter((c) => c.paid_at).map((c) => ({ period: c.period, amount: c.amount, paidOn: c.paid_on })),
    unpaid: unpaid.map((c) => ({ id: c.id, period: c.period, amount: c.amount, dueDate: c.due_date, claimed: claimed.has(c.id) })),
    pendingClaim: pending.length ? { amount: pending.reduce((sum, c) => sum + c.amount, 0), createdAt: pending[0]!.created_at } : null,
    claimRejected: claims[0]?.status === 'rejected' && unpaid.length > 0,
    ips, ipsAll,
  };
}

async function ledgerFeed(buildingId: string) {
  const entries = await rows(
    pool,
    `SELECT l.id, l.type, l.sign, l.amount, l.title, l.occurred_on, l.invoice_path, l.issue_id, l.reverses_entry_id, u.full_name AS author,
       EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = l.id) AS reversed
     FROM ledger_entries l LEFT JOIN users u ON u.id = l.created_by
     WHERE l.building_id = ? AND l.apartment_id IS NULL ORDER BY l.occurred_on DESC, l.created_at DESC`,
    [buildingId],
  );
  // Uplate po stanovima se stanarima prikazuju zbirno, po mesecu.
  const fees = await rows(
    pool,
    `SELECT DATE_FORMAT(occurred_on, '%Y-%m') AS period, COUNT(*) AS n, SUM(sign * amount) AS total, MIN(occurred_on) AS first_on, MAX(occurred_on) AS last_on
     FROM ledger_entries WHERE building_id = ? AND apartment_id IS NOT NULL GROUP BY period`,
    [buildingId],
  );
  const feed = [
    ...entries.map((e) => ({
      kind: 'entry' as const, id: e.id, type: e.type, title: e.title, amount: e.sign * e.amount, occurredOn: e.occurred_on as string,
      author: e.author, invoiceUrl: signedUrl(e.invoice_path), issueId: e.issue_id, reversed: !!e.reversed, reversal: !!e.reverses_entry_id,
    })),
    ...fees.map((f) => ({
      kind: 'fees' as const, id: `fees-${f.period}`, period: f.period as string, count: Number(f.n), amount: Number(f.total),
      firstOn: f.first_on as string, occurredOn: f.last_on as string,
    })),
  ];
  return feed.sort((a, b) => b.occurredOn.localeCompare(a.occurredOn));
}

/** Upis uplate iz izvoda; vraća false kad zaduženje nije moguće pronaći. */
async function bookLine(db: Db, buildingId: string, uid: string, line: { occurredOn: string; amount: number; apartmentId: string; apartmentNumber: number; chargeId?: string | null }) {
  const entryId = await addEntry(db, {
    buildingId, type: 'income', sign: 1, amount: line.amount, title: `Uplata, stan ${line.apartmentNumber}`,
    occurredOn: line.occurredOn, apartmentId: line.apartmentId, createdBy: uid,
  });
  await allocatePayment(db, line.apartmentId, entryId, line.amount, line.chargeId);
  await settleClaims(db, line.apartmentId);
  return entryId;
}

function parseCsvLine(line: string, separator: string) {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (c === separator && !quoted) {
      cells.push(cell);
      cell = '';
    } else cell += c;
  }
  cells.push(cell);
  return cells.map((s) => s.trim());
}

function parseAmount(raw: string) {
  const s = raw.replace(/\s|RSD/g, '');
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function parseDate(raw: string) {
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const local = raw.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  return local ? `${local[3]}-${local[2]!.padStart(2, '0')}-${local[1]!.padStart(2, '0')}` : null;
}

export function parseStatement(csv: string) {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const separator = (lines[0]?.split(';').length ?? 0) > (lines[0]?.split(',').length ?? 0) ? ';' : ',';
  const parsed = [];
  for (const [i, line] of lines.entries()) {
    const [dateCell, payer, amountCell, reference, purpose] = parseCsvLine(line, separator);
    const occurredOn = parseDate(dateCell ?? '');
    const value = parseAmount(amountCell ?? '');
    if (!occurredOn || !value) {
      if (i === 0) continue; // zaglavlje
      throw badRequest('bad_csv', `Red ${i + 1} nije ispravan. Kolone: datum, uplatilac, iznos, poziv na broj, svrha.`);
    }
    parsed.push({ occurredOn, payer: payer ?? '', amount: value, reference: reference || null, purpose: purpose || null });
  }
  if (!parsed.length) throw badRequest('bad_csv', 'Izvod je prazan.');
  return parsed;
}

export async function budgetRoutes(app: FastifyInstance) {
  app.get('/buildings/:id/budget', async (req) => {
    const { id } = req.params as { id: string };
    const access = await buildingAccess(userId(req), id);
    const total = await balance(pool, id);
    const reserved = await reservations(pool, id);
    const reservedSum = reserved.reduce((sum, r) => sum + r.amount, 0);
    const months = monthsBack(localDate(), 6);
    const chart = await Promise.all(months.map(async (m) => ({ period: m.period, balance: await balance(pool, id, m.end) })));
    const biggest = await one(
      pool,
      "SELECT title, amount, occurred_on FROM ledger_entries WHERE building_id = ? AND type = 'expense' AND occurred_on >= ? ORDER BY amount DESC LIMIT 1",
      [id, `${months[0]!.period}-01`],
    );
    return {
      balance: total, reserved: reservedSum, free: total - reservedSum, reservations: reserved, chart,
      biggestExpense: biggest ? { title: biggest.title, amount: biggest.amount, period: biggest.occurred_on.slice(0, 7) } : null,
      feed: await ledgerFeed(id),
      overdueTotal: await overdueTotal(pool, id),
      mine: access.role === 'resident' ? await myCharges(id, access.apartmentId, access.apartmentNumber) : null,
    };
  });

  // Podaci koje vidi samo upravnik (ekran 20).
  app.get('/buildings/:id/budget/manager', async (req) => {
    const { id } = req.params as { id: string };
    await requireManager(userId(req), id);
    const overdue = await rows(
      pool,
      `SELECT a.id AS apartment_id, a.number, SUM(c.amount) AS total, COUNT(*) AS months,
        (SELECT u.full_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.apartment_id = a.id AND m.status = 'approved' ORDER BY m.role, m.created_at LIMIT 1) AS resident
       FROM charges c JOIN apartments a ON a.id = c.apartment_id
       WHERE c.building_id = ? AND c.paid_at IS NULL AND c.cancelled_at IS NULL AND c.due_date < ? GROUP BY a.id ORDER BY total DESC, a.number`,
      [id, localDate()],
    );
    const lastImport = await one(pool, 'SELECT * FROM bank_imports WHERE building_id = ? ORDER BY created_at DESC LIMIT 1', [id]);
    const stats = lastImport ? await one(pool, "SELECT COUNT(*) AS total, SUM(status = 'matched') AS matched FROM bank_import_lines WHERE import_id = ?", [lastImport.id]) : null;
    const unmatched = await rows(
      pool,
      `SELECT l.id, l.payer, l.amount, l.reference, l.purpose, l.occurred_on FROM bank_import_lines l JOIN bank_imports i ON i.id = l.import_id
       WHERE i.building_id = ? AND l.status = 'unmatched' ORDER BY l.occurred_on, l.id`,
      [id],
    );
    const entries = await rows(pool, 'SELECT id, title, sign, amount, occurred_on AS occurredOn FROM ledger_entries WHERE building_id = ? AND apartment_id IS NOT NULL ORDER BY occurred_on DESC, created_at DESC LIMIT 50', [id]);
    const claims = await rows(
      pool,
      `SELECT p.id, p.amount, p.created_at, a.id AS apartment_id, a.number, u.full_name,
        (SELECT GROUP_CONCAT(c.period ORDER BY c.period) FROM payment_claim_charges cc JOIN charges c ON c.id = cc.charge_id WHERE cc.claim_id = p.id) AS periods
       FROM payment_claims p JOIN apartments a ON a.id = p.apartment_id LEFT JOIN users u ON u.id = p.user_id
       WHERE p.building_id = ? AND p.status = 'pending' ORDER BY p.created_at`,
      [id],
    );
    return {
      claims: claims.map((c) => ({ id: c.id, amount: c.amount, createdAt: c.created_at, apartmentNumber: c.number, resident: c.full_name, periods: (c.periods ?? '').split(',').filter(Boolean) })),
      overdueTotal: overdue.reduce((sum, o) => sum + Number(o.total), 0),
      overdue: overdue.map((o) => ({ apartmentId: o.apartment_id, apartmentNumber: o.number, resident: o.resident, total: Number(o.total), months: Number(o.months) })),
      lastImport: lastImport ? { fileName: lastImport.file_name, total: Number(stats?.total ?? 0), matched: Number(stats?.matched ?? 0) } : null,
      unmatched: unmatched.map((l) => ({ id: l.id, payer: l.payer, amount: l.amount, reference: l.reference, purpose: l.purpose, occurredOn: l.occurred_on })),
      payments: entries.map((e) => ({ ...e, amount: e.sign * e.amount })),
    };
  });

  app.get('/buildings/:id/apartments/:apartmentId/charges', async (req) => {
    const { id, apartmentId } = req.params as { id: string; apartmentId: string };
    await requireManager(userId(req), id);
    return rows(pool, 'SELECT id, period, amount, due_date AS dueDate FROM charges WHERE building_id = ? AND apartment_id = ? AND paid_at IS NULL AND cancelled_at IS NULL ORDER BY period', [id, apartmentId]);
  });

  app.post('/buildings/:id/expenses', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    await requireManager(uid, id);
    const body = z.object({
      title: z.string().trim().min(3, 'Unesite opis.').max(190), amount, invoicePath: z.string().nullable().optional(),
      occurredOn: date.optional(), issueId: z.string().uuid().nullable().optional(),
    }).parse(req.body);
    await assertOwnUpload(pool, uid, body.invoicePath);
    if (body.issueId && !(await one(pool, 'SELECT 1 AS ok FROM issues WHERE id = ? AND building_id = ?', [body.issueId, id]))) throw notFound('Problem nije pronađen.');
    const entryId = await addEntry(pool, { buildingId: id, type: 'expense', sign: -1, amount: body.amount, title: body.title, occurredOn: body.occurredOn, issueId: body.issueId, invoicePath: body.invoicePath, createdBy: uid });
    toBuilding(id, 'budget');
    return { id: entryId };
  });

  // Ručna uplata ("Unesi uplatu", "Označi uplatu ručno").
  app.post('/buildings/:id/payments', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    await requireManager(uid, id);
    const body = z.object({ apartmentId: z.string().uuid('Izaberite stan.'), amount, chargeId: z.string().uuid().nullable().optional(), occurredOn: date.optional() }).parse(req.body);
    const apartment = await one(pool, 'SELECT number FROM apartments WHERE id = ? AND building_id = ?', [body.apartmentId, id]);
    if (!apartment) throw badRequest('bad_apartment', 'Izaberite stan iz liste.');
    const building = await one(pool, 'SELECT payment_mode FROM buildings WHERE id = ?', [id]);
    if (building!.payment_mode !== 'direct') throw badRequest('infostan', 'Kod Infostana uplata se unosi kao prihod zgrade.');
    const entryId = await tx((db) => bookLine(db, id, uid, { occurredOn: body.occurredOn ?? localDate(), amount: body.amount, apartmentId: body.apartmentId, apartmentNumber: apartment.number, chargeId: body.chargeId }));
    toBuilding(id, 'budget');
    return { id: entryId };
  });

  // Prihod bez stana, npr. uplata od Infostana.
  app.post('/buildings/:id/income', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    await requireManager(uid, id);
    const body = z.object({ title: z.string().trim().min(3, 'Unesite opis.').max(190), amount, occurredOn: date.optional() }).parse(req.body);
    const entryId = await addEntry(pool, { buildingId: id, type: 'income', sign: 1, amount: body.amount, title: body.title, occurredOn: body.occurredOn, createdBy: uid });
    toBuilding(id, 'budget');
    return { id: entryId };
  });

  // Ispravka je uvek nova stavka; original ostaje u istoriji.
  app.post('/ledger/:id/reverse', async (req) => {
    const uid = userId(req);
    const entry = await one(pool, 'SELECT * FROM ledger_entries WHERE id = ?', [(req.params as { id: string }).id]);
    if (!entry) throw notFound();
    await requireManager(uid, entry.building_id);
    if (entry.type === 'reversal' || entry.type === 'opening') throw badRequest('bad_entry', 'Ova stavka ne može da se stornira.');
    if (await one(pool, 'SELECT 1 AS ok FROM ledger_entries WHERE reverses_entry_id = ?', [entry.id])) throw conflict('already_reversed', 'Stavka je već stornirana.');
    const id = await tx(async (db) => {
      await exec(db, 'UPDATE charges SET paid_at = NULL, payment_entry_id = NULL WHERE payment_entry_id = ?', [entry.id]);
      return addEntry(db, {
        buildingId: entry.building_id, type: 'reversal', sign: entry.sign === 1 ? -1 : 1, amount: entry.amount, title: `Storno: ${entry.title}`,
        apartmentId: entry.apartment_id, issueId: entry.issue_id, reversesEntryId: entry.id, createdBy: uid,
      });
    });
    toBuilding(entry.building_id, 'budget');
    return { id };
  });

  app.post('/buildings/:id/bank-imports', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    await requireManager(uid, id);
    const body = z.object({ fileName: z.string().trim().min(1).max(190), csv: z.string().min(1).max(2_000_000) }).parse(req.body);
    const lines = parseStatement(body.csv);
    const apartments = await rows(pool, 'SELECT id, number FROM apartments WHERE building_id = ?', [id]);
    const byNumber = new Map(apartments.map((a) => [Number(a.number), a]));
    const result = await tx(async (db) => {
      const importId = uuid();
      await exec(db, 'INSERT INTO bank_imports (id, building_id, file_name, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [importId, id, body.fileName, uid, now()]);
      let matched = 0;
      for (const line of lines) {
        const reference = parseReference(line.reference);
        const apartment = reference ? byNumber.get(Number(reference.slice(0, -4))) : undefined;
        const period = reference ? `20${reference.slice(-4, -2)}-${reference.slice(-2)}` : '';
        // Poziv "stan + 0000" je uplata svih dugovanja: raspoređuje se na najstarija.
        const payAll = reference?.endsWith('0000');
        const charge = apartment
          ? await one(
              db,
              payAll
                ? 'SELECT id FROM charges WHERE apartment_id = ? AND paid_at IS NULL AND cancelled_at IS NULL ORDER BY period LIMIT 1 FOR UPDATE'
                : 'SELECT id FROM charges WHERE apartment_id = ? AND period = ? AND paid_at IS NULL AND cancelled_at IS NULL AND amount = ? FOR UPDATE',
              payAll ? [apartment.id] : [apartment.id, period, line.amount],
            )
          : undefined;
        let entryId: string | null = null;
        if (apartment && charge) {
          entryId = await bookLine(db, id, uid, { occurredOn: line.occurredOn, amount: line.amount, apartmentId: apartment.id, apartmentNumber: apartment.number, chargeId: payAll ? null : charge.id });
          matched++;
        }
        await exec(
          db,
          'INSERT INTO bank_import_lines (id, import_id, occurred_on, payer, amount, reference, purpose, matched_apartment_id, matched_charge_id, ledger_entry_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [uuid(), importId, line.occurredOn, line.payer, line.amount, line.reference, line.purpose, entryId ? apartment!.id : null, charge?.id ?? null, entryId, entryId ? 'matched' : 'unmatched'],
        );
      }
      return { total: lines.length, matched };
    });
    toBuilding(id, 'budget');
    return result;
  });

  app.post('/bank-lines/:id/link', async (req) => {
    const uid = userId(req);
    const line = await one(pool, 'SELECT l.*, i.building_id FROM bank_import_lines l JOIN bank_imports i ON i.id = l.import_id WHERE l.id = ?', [(req.params as { id: string }).id]);
    if (!line) throw notFound();
    await requireManager(uid, line.building_id);
    const body = z.object({ apartmentId: z.string().uuid('Izaberite stan.'), chargeId: z.string().uuid().nullable().optional() }).parse(req.body);
    if (line.status === 'matched') throw conflict('already_linked', 'Uplata je već povezana.');
    const apartment = await one(pool, 'SELECT number FROM apartments WHERE id = ? AND building_id = ?', [body.apartmentId, line.building_id]);
    if (!apartment) throw badRequest('bad_apartment', 'Izaberite stan iz liste.');
    await tx(async (db) => {
      const entryId = await bookLine(db, line.building_id, uid, { occurredOn: line.occurred_on, amount: line.amount, apartmentId: body.apartmentId, apartmentNumber: apartment.number, chargeId: body.chargeId });
      await exec(db, "UPDATE bank_import_lines SET status = 'matched', matched_apartment_id = ?, matched_charge_id = ?, ledger_entry_id = ? WHERE id = ?", [body.apartmentId, body.chargeId ?? null, entryId, line.id]);
    });
    toBuilding(line.building_id, 'budget');
    return { ok: true };
  });
}
