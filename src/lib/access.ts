import { one, pool, rows, type Row } from '../db.js';
import { forbidden, notFound } from './errors.js';

// Autorizacija po zgradi. Svaka ruta prolazi kroz jednu od ovih provera.
export type Access =
  | { role: 'manager'; userId: string; buildingId: string; apartmentId: null; apartmentNumber: null }
  | { role: 'resident'; userId: string; buildingId: string; apartmentId: string; apartmentNumber: number };

export async function buildingAccess(userId: string, buildingId: string): Promise<Access> {
  const manager = await one(pool, 'SELECT 1 AS ok FROM building_managers WHERE building_id = ? AND user_id = ?', [buildingId, userId]);
  if (manager) return { role: 'manager', userId, buildingId, apartmentId: null, apartmentNumber: null };
  const member = await one(
    pool,
    `SELECT m.apartment_id, a.number FROM memberships m JOIN apartments a ON a.id = m.apartment_id
     WHERE m.building_id = ? AND m.user_id = ? AND m.status = 'approved' ORDER BY a.number LIMIT 1`,
    [buildingId, userId],
  );
  if (!member) throw forbidden();
  return { role: 'resident', userId, buildingId, apartmentId: member.apartment_id, apartmentNumber: member.number };
}

export async function requireManager(userId: string, buildingId: string) {
  const access = await buildingAccess(userId, buildingId);
  if (access.role !== 'manager') throw forbidden('Ovo može samo upravnik.');
  return access;
}

export async function requireResident(userId: string, buildingId: string) {
  const access = await buildingAccess(userId, buildingId);
  if (access.role !== 'resident') throw forbidden('Ovo može samo stanar.');
  return access;
}

export async function issueOr404(issueId: string): Promise<Row> {
  const issue = await one(pool, 'SELECT * FROM issues WHERE id = ?', [issueId]);
  if (!issue) throw notFound('Problem nije pronađen.');
  return issue;
}

export async function managerIds(buildingId: string): Promise<string[]> {
  const list = await rows(pool, 'SELECT user_id FROM building_managers WHERE building_id = ?', [buildingId]);
  return list.map((r) => r.user_id);
}

export async function residentIds(buildingId: string): Promise<string[]> {
  const list = await rows(pool, "SELECT DISTINCT user_id FROM memberships WHERE building_id = ? AND status = 'approved'", [buildingId]);
  return list.map((r) => r.user_id);
}
