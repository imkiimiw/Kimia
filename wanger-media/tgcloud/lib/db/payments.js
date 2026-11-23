// Telegram Stars payments (VIP). One row per telegram_payment_charge_id (unique): a redelivered
// successful_payment can't extend VIP twice. Rows are kept for refunds and the audit.
import { db } from 'sdk';
import { sql } from 'sdk/db';

/** Records a payment; false if this charge was recorded already. */
export async function insert({ userId, chargeId, stars, days, vipUntil }, now) {
  const r = await db.run(sql`INSERT INTO payments (user_id, charge_id, stars, days, vip_until, created_at)
    VALUES (${userId}, ${chargeId}, ${stars}, ${days}, ${vipUntil}, ${now}) ON CONFLICT(charge_id) DO NOTHING`);
  return r.rowsAffected === 1;
}

export async function setVipUntil(chargeId, vipUntil) {
  await db.run(sql`UPDATE payments SET vip_until = ${vipUntil} WHERE charge_id = ${chargeId}`);
}

/** The latest payments, newest first. */
export async function recent(limit) {
  return db.all(sql`SELECT id, user_id, charge_id, stars, days, refunded, created_at FROM payments ORDER BY id DESC LIMIT ${limit}`);
}

export async function get(id) {
  return db.get(sql`SELECT id, user_id, charge_id, stars, days, refunded, created_at FROM payments WHERE id = ${id}`);
}

/** Marks a payment refunded; true only for the call that changed it. */
export async function markRefunded(id) {
  const r = await db.run(sql`UPDATE payments SET refunded = 1 WHERE id = ${id} AND refunded = 0`);
  return r.rowsAffected === 1;
}
