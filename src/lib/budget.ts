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

/** Ukupan dospeli neplaćeni iznos. Stanarima se daje samo ovaj zbir, bez stanova i imena. */
export async function overdueTotal(db: Db, buildingId: string): Promise<number> {
  const row = await one(
    db,
    'SELECT COALESCE(SUM(amount), 0) AS total FROM charges WHERE building_id = ? AND paid_at IS NULL AND cancelled_at IS NULL AND due_date < ?',
    [buildingId, localDate()],
  );
  return Number(row?.total ?? 0);
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

/** Uplata se raspoređuje na najstarija neplaćena zaduženja stana. */
export async function allocatePayment(db: Db, apartmentId: string, entryId: string, amount: number, chargeId?: string | null) {
  const unpaid = await rows(
    db,
    `SELECT id, amount FROM charges WHERE apartment_id = ? AND paid_at IS NULL AND cancelled_at IS NULL ${chargeId ? 'AND id = ?' : ''} ORDER BY period FOR UPDATE`,
    chargeId ? [apartmentId, chargeId] : [apartmentId],
  );
  let left = amount;
  const paid: string[] = [];
  for (const c of unpaid) {
    if (left + 0.001 < c.amount) break;
    await exec(db, 'UPDATE charges SET paid_at = ?, payment_entry_id = ? WHERE id = ?', [now(), entryId, c.id]);
    left -= c.amount;
    paid.push(c.id);
  }
  return paid;
}

export const buildingOf = (buildingId: string) => one(pool, 'SELECT * FROM buildings WHERE id = ?', [buildingId]);
