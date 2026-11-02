import { exec, one, pool, rows, uuid, type Db, type Row } from '../db.js';
import { localDate, now } from './clock.js';

export async function balance(db: Db, buildingId: string, until?: string): Promise<number> {
  const row = await one(
    db,
    `SELECT COALESCE(SUM(sign * amount), 0) AS total FROM ledger_entries WHERE building_id = ? ${until ? 'AND occurred_on <= ?' : ''}`,
    until ? [buildingId, until] : [buildingId],
  );
  return Number(row?.total ?? 0);
}

/** Vodeća ponuda: najviše glasova, pa niža cena. */
export async function leadingOffer(db: Db, sessionId: string, issueId: string): Promise<Row | undefined> {
  return one(
    db,
    `SELECT o.*, COUNT(v.apartment_id) AS votes FROM offers o
     LEFT JOIN votes v ON v.offer_id = o.id AND v.session_id = ?
     WHERE o.issue_id = ? AND o.withdrawn_at IS NULL
     GROUP BY o.id ORDER BY votes DESC, o.price ASC LIMIT 1`,
    [sessionId, issueId],
  );
}

/** Rezervisano: vodeća ponuda aktivnih glasanja + izabrane ponude nezavršenih problema. */
export async function reservations(db: Db, buildingId: string) {
  const voting = await rows(
    db,
    `SELECT s.id AS session_id, i.id AS issue_id, COALESCE(i.short_title, i.title) AS title FROM votes_sessions s
     JOIN issues i ON i.id = s.issue_id
     WHERE i.building_id = ? AND s.closed_at IS NULL AND i.status = 'voting'`,
    [buildingId],
  );
  const list: { issueId: string; title: string; contractor: string; amount: number; kind: 'voting' | 'planned' }[] = [];
  for (const v of voting) {
    const lead = await leadingOffer(db, v.session_id, v.issue_id);
    if (lead) list.push({ issueId: v.issue_id, title: v.title, contractor: lead.contractor, amount: lead.price, kind: 'voting' });
  }
  const planned = await rows(
    db,
    `SELECT i.id, COALESCE(i.short_title, i.title) AS title, o.contractor, o.price FROM issues i JOIN offers o ON o.id = i.chosen_offer_id
     WHERE i.building_id = ? AND i.status IN ('planned', 'in_progress')`,
    [buildingId],
  );
  for (const p of planned) list.push({ issueId: p.id, title: p.title, contractor: p.contractor, amount: p.price, kind: 'planned' });
  return list;
}

/**
 * Preplata stana (SQL izraz): uplate i njihova storna minus rate koje su zatvorene.
 * Vodi se iz knjige, bez posebne kolone, pa ne može da se raziđe sa uplatama.
 */
export const creditOf = (apartment: string) => `(
  (SELECT COALESCE(SUM(cl.sign * cl.amount), 0) FROM ledger_entries cl WHERE cl.apartment_id = ${apartment} AND cl.type IN ('income', 'reversal'))
  - (SELECT COALESCE(SUM(cc.amount), 0) FROM charges cc WHERE cc.apartment_id = ${apartment} AND cc.paid_at IS NOT NULL))`;

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function apartmentCredit(db: Db, apartmentId: string): Promise<number> {
  const row = await one(db, `SELECT ${creditOf('?')} AS credit`, [apartmentId, apartmentId]);
  return round2(Number(row?.credit ?? 0));
}

/** Ukupan dospeli neplaćeni iznos, umanjen za preplate. Stanarima se daje samo ovaj zbir, bez stanova i imena. */
export async function overdueTotal(db: Db, buildingId: string): Promise<number> {
  const row = await one(
    db,
    `SELECT COALESCE(SUM(GREATEST(d.due - ${creditOf('d.apartment_id')}, 0)), 0) AS total FROM (
       SELECT apartment_id, SUM(amount) AS due FROM charges
       WHERE building_id = ? AND paid_at IS NULL AND cancelled_at IS NULL AND due_date < ? GROUP BY apartment_id) d`,
    [buildingId, localDate()],
  );
  return round2(Number(row?.total ?? 0));
}

export async function addEntry(
  db: Db,
  e: {
    buildingId: string; type: 'income' | 'expense' | 'opening' | 'reversal'; sign: 1 | -1; amount: number; title: string;
    occurredOn?: string; apartmentId?: string | null; issueId?: string | null; invoicePath?: string | null;
    reversesEntryId?: string | null; createdBy: string | null;
  },
) {
  const id = uuid();
  await exec(
    db,
    `INSERT INTO ledger_entries (id, building_id, type, sign, amount, title, occurred_on, apartment_id, issue_id, invoice_path, reverses_entry_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, e.buildingId, e.type, e.sign, e.amount, e.title, e.occurredOn ?? localDate(), e.apartmentId ?? null, e.issueId ?? null,
      e.invoicePath ?? null, e.reversesEntryId ?? null, e.createdBy, now()],
  );
  return id;
}

/** Uplate stana se zaključavaju po stanu, da dve istovremene ne potroše istu preplatu. */
const lockApartment = (db: Db, apartmentId: string) => one(db, 'SELECT id FROM apartments WHERE id = ? FOR UPDATE', [apartmentId]);

/** Poslednja nestornirana uplata stana; na nju se vezuju rate zatvorene iz preplate. */
const lastPayment = async (db: Db, apartmentId: string) =>
  (await one(
    db,
    `SELECT l.id FROM ledger_entries l WHERE l.apartment_id = ? AND l.type = 'income'
       AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = l.id)
     ORDER BY l.occurred_on DESC, l.created_at DESC LIMIT 1`,
    [apartmentId],
  ))?.id as string | undefined;

/**
 * Preplata stana (uplata je već u knjizi) zatvara izabrane rate, pa najstarije otvorene.
 * Ono što ne pokrije celu ratu ostaje preplata za sledeću.
 */
export async function allocatePayment(db: Db, apartmentId: string, entryId?: string | null, chargeIds: string[] = []) {
  await lockApartment(db, apartmentId);
  let left = await apartmentCredit(db, apartmentId);
  const paid: string[] = [];
  if (left <= 0) return paid;
  const entry = entryId ?? (await lastPayment(db, apartmentId));
  if (!entry) return paid;
  const unpaid = await rows(db, 'SELECT id, amount FROM charges WHERE apartment_id = ? AND paid_at IS NULL AND cancelled_at IS NULL ORDER BY period FOR UPDATE', [apartmentId]);
  const ordered = [...unpaid.filter((c) => chargeIds.includes(c.id)), ...unpaid.filter((c) => !chargeIds.includes(c.id))];
  for (const c of ordered) {
    if (left + 0.001 < c.amount) break;
    await exec(db, 'UPDATE charges SET paid_at = ?, payment_entry_id = ? WHERE id = ?', [now(), entry, c.id]);
    left -= c.amount;
    paid.push(c.id);
  }
  return paid;
}

/** Posle storna: ako uplate više ne pokrivaju zatvorene rate, najnovije se ponovo otvaraju, pa se preplata raspoređuje iznova. */
export async function rebalanceApartment(db: Db, apartmentId: string) {
  await lockApartment(db, apartmentId);
  let credit = await apartmentCredit(db, apartmentId);
  if (credit < 0) {
    const closed = await rows(db, 'SELECT id, amount FROM charges WHERE apartment_id = ? AND paid_at IS NOT NULL ORDER BY period DESC FOR UPDATE', [apartmentId]);
    for (const c of closed) {
      if (credit >= -0.001) break;
      await exec(db, 'UPDATE charges SET paid_at = NULL, payment_entry_id = NULL WHERE id = ?', [c.id]);
      credit += c.amount;
    }
  }
  await allocatePayment(db, apartmentId);
}

export const buildingOf = (buildingId: string) => one(pool, 'SELECT * FROM buildings WHERE id = ?', [buildingId]);
