import cron from 'node-cron';
import { exec, pool, rows, tx, uuid } from '../db.js';
import { residentIds } from '../lib/access.js';
import { localDate, localPeriod, now } from '../lib/clock.js';
import { pushLater } from '../lib/push.js';
import { toBuilding } from '../lib/realtime.js';
import { closeSession } from '../routes/issues.js';

export async function closeExpiredVotes() {
  const expired = await rows(pool, 'SELECT id FROM votes_sessions WHERE closed_at IS NULL AND deadline <= ?', [now()]);
  for (const s of expired) {
    const result = await tx((db) => closeSession(db, s.id));
    if (!result) continue;
    toBuilding(result.buildingId, 'issue', result.issueId);
    toBuilding(result.buildingId, 'issues');
    toBuilding(result.buildingId, 'budget');
    pushLater(await residentIds(result.buildingId), { title: 'Glasanje je završeno', body: result.winner ? 'Izabran je izvođač.' : 'Nije postignuta potrebna većina.', data: { screen: 'issue', id: result.issueId } });
  }
  return expired.length;
}

/** Rok je 15. u mesecu; ako je dan zaduženja posle 15, rok je 15. sledećeg meseca. */
export function dueDateFor(period: string, feeDay: number) {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(year, month - 1 + (feeDay > 15 ? 1 : 0), 15));
  return d.toISOString().slice(0, 10);
}

export async function createMonthlyCharges(today = localDate()) {
  const day = Number(today.slice(8, 10));
  const period = localPeriod(new Date(`${today}T12:00:00Z`));
  const buildings = await rows(pool, "SELECT * FROM buildings WHERE fee_day_of_month = ? AND fee_amount > 0 AND payment_mode = 'direct'", [day]);
  for (const b of buildings) {
    const apartments = await rows(pool, 'SELECT id, area_m2 FROM apartments WHERE building_id = ?', [b.id]);
    const values = apartments
      .map((a) => ({ id: a.id, amount: b.fee_mode === 'per_m2' ? Math.round(b.fee_amount * Number(a.area_m2 ?? 0) * 100) / 100 : b.fee_amount }))
      .filter((a) => a.amount > 0)
      .map((a) => [uuid(), b.id, a.id, period, a.amount, dueDateFor(period, b.fee_day_of_month), now()]);
    if (values.length) await exec(pool, 'INSERT IGNORE INTO charges (id, building_id, apartment_id, period, amount, due_date, created_at) VALUES ?', [values]);
    toBuilding(b.id, 'budget');
  }
}

export async function sendPaymentReminders(today = localDate()) {
  const target = new Date(`${today}T12:00:00Z`);
  target.setUTCDate(target.getUTCDate() + 3);
  const due = await rows(
    pool,
    `SELECT DISTINCT m.user_id, c.building_id FROM charges c JOIN memberships m ON m.apartment_id = c.apartment_id AND m.status = 'approved'
     JOIN buildings b ON b.id = c.building_id WHERE c.paid_at IS NULL AND c.cancelled_at IS NULL AND c.due_date = ? AND b.payment_mode = 'direct'`,
    [target.toISOString().slice(0, 10)],
  );
  for (const r of due) pushLater([r.user_id], { title: 'Podsetnik za uplatu', body: 'Rok za ratu je za 3 dana.', urgent: true, data: { screen: 'budget', buildingId: r.building_id } });
}

export function startJobs() {
  const tz = { timezone: 'Europe/Belgrade' };
  const guard = (name: string, job: () => Promise<unknown>) => () => {
    job().catch((err) => console.error(`posao ${name} nije uspeo`, err));
  };
  cron.schedule('* * * * *', guard('zatvaranje glasanja', closeExpiredVotes), tz);
  cron.schedule('5 0 * * *', guard('mesečna zaduženja', createMonthlyCharges), tz);
  cron.schedule('0 9 * * *', guard('podsetnici', sendPaymentReminders), tz);
}
