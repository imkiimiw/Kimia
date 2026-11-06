// Roles and permissions — the only place that decides who may do what. Pure module: must not import
// 'sdk'. Callers load the actor (lib/db/users.js) and must re-check on every admin action.
import { OWNER_ID } from './config.js';

/** Permission flags (bitmask). */
export const P = {
  VIEW_USERS: 1,
  MANAGE_USERS: 2, // ban / unban / quotas / notes
  VIEW_STATS: 4,
  MANAGE_PLATFORMS: 8, // methods on/off, credentials, health checks
  MANAGE_SETTINGS: 16, // global switches, texts
  BROADCAST: 32,
  MANAGE_ADMINS: 64, // appoint / change / remove staff below one's own rank
  VIEW_AUDIT: 128,
};
export const ALL_PERMS = Object.values(P).reduce((a, b) => a | b, 0);

/** Rank: a higher number outranks a lower one. 'user' = no staff role. */
export const RANK = { user: 0, support: 1, moderator: 2, admin: 3, super_admin: 4, owner: 5 };
export const STAFF_ROLES = ['super_admin', 'admin', 'moderator', 'support'];

export const ROLE_DEFAULTS = {
  super_admin: ALL_PERMS,
  admin: P.VIEW_USERS | P.MANAGE_USERS | P.VIEW_STATS | P.MANAGE_PLATFORMS | P.BROADCAST | P.VIEW_AUDIT,
  moderator: P.VIEW_USERS | P.MANAGE_USERS | P.VIEW_STATS,
  support: P.VIEW_USERS | P.VIEW_STATS,
  user: 0,
};

export const isOwnerId = (id) => Number(id) === OWNER_ID;

/**
 * The actor for a user id and its roles row (or null). The owner is recognised by id only;
 * a stored row can never make someone the owner, and an unknown role counts as no role.
 */
export function actorOf(userId, roleRow) {
  if (isOwnerId(userId)) return { id: Number(userId), role: 'owner', perms: ALL_PERMS };
  const role = roleRow && STAFF_ROLES.includes(roleRow.role) ? roleRow.role : 'user';
  const perms = role === 'user' ? 0 : roleRow.perms == null ? ROLE_DEFAULTS[role] : roleRow.perms & ROLE_DEFAULTS[role];
  return { id: Number(userId), role, perms };
}

export const isStaff = (actor) => !!actor && RANK[actor.role] >= RANK.support;
export const can = (actor, flag) => !!actor && (actor.role === 'owner' || (actor.perms & flag) === flag);

/** Only the owner manages forced-join channels (brief §4). */
export const canManageChannels = (actor) => !!actor && actor.role === 'owner';

/**
 * May `actor` act on `target` as a staff matter (ban, restrict, change role)? Never on the owner,
 * never on oneself, only on someone strictly below one's rank.
 */
export function outranks(actor, target) {
  if (!actor || !target) return false;
  if (target.role === 'owner') return false;
  if (actor.id === target.id) return false;
  return RANK[actor.role] > RANK[target.role];
}

/** Ban / unban / quota / note on a user. */
export const canModerate = (actor, target) => can(actor, P.MANAGE_USERS) && outranks(actor, target);

/**
 * May `actor` give `target` the role `newRole` ('user' = remove the role)? SUPER_ADMIN is granted
 * and revoked by the owner only; others need MANAGE_ADMINS and may only hand out roles below their own.
 */
export function canSetRole(actor, target, newRole) {
  if (!(newRole in RANK) || newRole === 'owner') return false;
  if (!outranks(actor, target)) return false;
  if (newRole === 'super_admin' || target.role === 'super_admin') return actor.role === 'owner';
  if (actor.role === 'owner') return true;
  return can(actor, P.MANAGE_ADMINS) && RANK[newRole] < RANK[actor.role];
}

/** Staff and the owner skip the forced-join gate (they run the bot). */
export const skipsForcedJoin = (actor) => isStaff(actor);
