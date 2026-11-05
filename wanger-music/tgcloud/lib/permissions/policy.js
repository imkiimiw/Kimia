// The one permission service (pure). No other module compares user ids with the owner id.
import { OWNER_ID } from '../config/static.js';

export const PERMISSIONS = Object.freeze([
  'panel.open', 'catalog.manage', 'approvals.review', 'stats.view',
  'admins.manage', 'forcejoin.manage', 'destinations.manage', 'sources.manage',
  'broadcast.send', 'settings.manage', 'users.ban', 'users.view', 'system.view',
]);

/** Database roles → permissions. Everything else is owner-only. */
export const ROLE_PERMISSIONS = Object.freeze({
  admin: Object.freeze(['panel.open', 'catalog.manage', 'approvals.review', 'stats.view']),
  user: Object.freeze([]),
});

export class PermissionError extends Error {
  /** @param {string} perm */
  constructor(perm) {
    super(`permission denied: ${perm}`);
    this.name = 'PermissionError';
    this.perm = perm;
  }
}

/** @param {{telegram_id?: number}|null|undefined} user */
export const isOwner = (user) => !!user && Number(user.telegram_id) === OWNER_ID;

/** @param {number} telegramId */
export const isOwnerId = (telegramId) => Number(telegramId) === OWNER_ID;

/** Owner or admin. @param {{telegram_id?: number, role?: string}|null|undefined} user */
export const isStaff = (user) => isOwner(user) || (!!user && user.role === 'admin');

/** @param {{telegram_id?: number, role?: string, is_banned?: number|boolean}|null|undefined} user @param {string} perm */
export function can(user, perm) {
  if (!user || !PERMISSIONS.includes(perm)) return false;
  if (isOwner(user)) return true;
  if (user.is_banned) return false;
  const list = /** @type {Record<string, readonly string[]>} */ (ROLE_PERMISSIONS)[user.role || 'user'] || [];
  return list.includes(perm);
}

/** Second check inside services for owner-only operations. @throws {PermissionError} */
export function assertCan(user, perm) {
  if (!can(user, perm)) throw new PermissionError(perm);
}
