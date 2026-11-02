import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exec, one, pool, rows, tx, uuid, type Db } from '../db.js';
import { managerIds, requireManager, requireResident } from '../lib/access.js';
import { userId } from '../lib/auth.js';
import { addEntry, allocatePayment, apartmentCredit } from '../lib/budget.js';
import { now } from '../lib/clock.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { pushLater } from '../lib/push.js';
import { toBuilding } from '../lib/realtime.js';

/** Zaduženja stana koja se mogu platiti: neplaćena i bez prijave na čekanju. */
export const PAYABLE = `c.paid_at IS NULL AND c.cancelled_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM payment_claim_charges cc JOIN payment_claims p ON p.id = cc.claim_id
  WHERE cc.charge_id = c.id AND p.status = 'pending')`;

/** Prijava je rešena ako su sva njena zaduženja plaćena drugim putem (izvod, ručni unos). */
export const settleClaims = (db: Db, apartmentId: string) =>
  exec(
    db,
    `UPDATE payment_claims p SET status = 'confirmed', decided_at = ?
     WHERE p.apartment_id = ? AND p.status = 'pending' AND NOT EXISTS (
       SELECT 1 FROM payment_claim_charges cc JOIN charges c ON c.id = cc.charge_id
       WHERE cc.claim_id = p.id AND c.paid_at IS NULL)`,
    [now(), apartmentId],
  );

async function claimOr404(id: string) {
  const claim = await one(pool, 'SELECT * FROM payment_claims WHERE id = ?', [id]);
  if (!claim) throw notFound('Prijava uplate nije pronađena.');
  return claim;
}

const residentsOf = async (apartmentId: string) =>
  (await rows(pool, "SELECT user_id FROM memberships WHERE apartment_id = ? AND status = 'approved'", [apartmentId])).map((r) => r.user_id as string);

export async function claimRoutes(app: FastifyInstance) {
  app.post('/buildings/:id/payment-claims', async (req) => {
    const uid = userId(req);
    const { id } = req.params as { id: string };
    const access = await requireResident(uid, id);
    const { scope } = z.object({ scope: z.enum(['next', 'all']) }).parse(req.body);
    const building = await one(pool, 'SELECT payment_mode FROM buildings WHERE id = ?', [id]);
    if (building!.payment_mode !== 'direct') throw badRequest('infostan', 'Rata za ovu zgradu se plaća preko Infostana.');
    const claimId = uuid();
    const amount = await tx(async (db) => {
      const payable = await rows(db, `SELECT c.id, c.amount FROM charges c WHERE c.apartment_id = ? AND ${PAYABLE} ORDER BY c.period FOR UPDATE`, [access.apartmentId]);
      const chosen = scope === 'all' ? payable : payable.slice(0, 1);
      if (!chosen.length) throw conflict('nothing_to_claim', 'Nema rate za prijavu. Uplata možda već čeka potvrdu.');
      // Stanar uplaćuje rate umanjene za preplatu (isto kao IPS kod).
      const total = Math.round((chosen.reduce((sum, c) => sum + c.amount, 0) - Math.max(await apartmentCredit(db, access.apartmentId), 0)) * 100) / 100;
      await exec(db, 'INSERT INTO payment_claims (id, building_id, apartment_id, user_id, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)', [claimId, id, access.apartmentId, uid, total, now()]);
      await exec(db, 'INSERT INTO payment_claim_charges (claim_id, charge_id) VALUES ?', [chosen.map((c) => [claimId, c.id])]);
      return total as number;
    });
    toBuilding(id, 'budget');
    pushLater(await managerIds(id), { title: 'Stanar je prijavio uplatu', body: `Stan ${access.apartmentNumber}: ${amount} RSD. Potvrdi da je legla.`, data: { screen: 'budget', buildingId: id } });
    return { id: claimId, amount };
  });

  app.post('/payment-claims/:id/confirm', async (req) => {
    const uid = userId(req);
    const claim = await claimOr404((req.params as { id: string }).id);
    await requireManager(uid, claim.building_id);
    const apartment = await one(pool, 'SELECT number FROM apartments WHERE id = ?', [claim.apartment_id]);
    await tx(async (db) => {
      const current = await one(db, 'SELECT status FROM payment_claims WHERE id = ? FOR UPDATE', [claim.id]);
      if (current!.status !== 'pending') throw conflict('already_decided', 'O ovoj uplati je već odlučeno.');
      const charges = await rows(
        db,
        `SELECT c.id, c.amount FROM charges c JOIN payment_claim_charges cc ON cc.charge_id = c.id
         WHERE cc.claim_id = ? AND c.paid_at IS NULL AND c.cancelled_at IS NULL FOR UPDATE`,
        [claim.id],
      );
      // Knjiži se samo ono što preplata stana ne pokriva.
      const total = Math.round((charges.reduce((sum, c) => sum + c.amount, 0) - Math.max(await apartmentCredit(db, claim.apartment_id), 0)) * 100) / 100;
      let entryId: string | null = null;
      if (total > 0) {
        entryId = await addEntry(db, { buildingId: claim.building_id, type: 'income', sign: 1, amount: total, title: `Uplata, stan ${apartment!.number}`, apartmentId: claim.apartment_id, createdBy: uid });
        await allocatePayment(db, claim.apartment_id, entryId, charges.map((c) => c.id));
      }
      await exec(db, "UPDATE payment_claims SET status = 'confirmed', decided_by = ?, decided_at = ?, ledger_entry_id = ? WHERE id = ?", [uid, now(), entryId, claim.id]);
    });
    toBuilding(claim.building_id, 'budget');
    pushLater(await residentsOf(claim.apartment_id), { title: 'Uplata je potvrđena', body: 'Upravnik je potvrdio da je uplata legla.', data: { screen: 'budget', buildingId: claim.building_id } });
    return { ok: true };
  });

  app.post('/payment-claims/:id/reject', async (req) => {
    const uid = userId(req);
    const claim = await claimOr404((req.params as { id: string }).id);
    await requireManager(uid, claim.building_id);
    const result = await exec(pool, "UPDATE payment_claims SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", [uid, now(), claim.id]);
    if (!result.affectedRows) throw conflict('already_decided', 'O ovoj uplati je već odlučeno.');
    toBuilding(claim.building_id, 'budget');
    pushLater(await residentsOf(claim.apartment_id), { title: 'Uplata nije potvrđena', body: 'Upravnik nije pronašao uplatu na računu zgrade.', urgent: true, data: { screen: 'budget', buildingId: claim.building_id } });
    return { ok: true };
  });
}
