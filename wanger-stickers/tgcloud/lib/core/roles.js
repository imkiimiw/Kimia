/**
 * Permissions (pure) — the only place that decides who may do what.
 *
 * - owner (OWNER_ID, numeric): everything.
 * - reviewer (added by the owner, Kimi's request 2026-11-12): may review pack publications
 *   (approve / reject / remove a post) and see the review queue. Nothing else.
 * - everyone else: no admin permission at all.
 */
import { OWNER_ID } from '../config.js';

const REVIEWER = new Set(['panel.open', 'publish.review', 'publish.queue', 'publish.remove']);

/** @param {{tg_id?: number}|null} user @param {{role?: string}|null} staffRow */
export function roleOf(user, staffRow) {
  const id = user && user.tg_id;
  if (typeof id === 'number' && id === OWNER_ID) return 'owner';
  if (staffRow && staffRow.role === 'reviewer') return 'reviewer';
  return 'user';
}

/** @param {string} role @param {string} perm */
export function can(role, perm) {
  if (role === 'owner') return true;
  if (role === 'reviewer') return REVIEWER.has(perm);
  return false;
}
