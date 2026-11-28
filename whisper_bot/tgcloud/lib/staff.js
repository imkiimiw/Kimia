// Who may use the panel (/admin): the owner (lib/config.js OWNER_ID), who may do everything, and the
// admins the owner added (table admins), each with the permissions the owner gave them (ADMIN_PERMS).
// Always by numeric id, checked server-side on every /admin command and every a:* button (lib/router.js).
import { db } from 'sdk';
import { sql } from 'sdk/db';
import {
  ADMIN_PERMS, DEFAULT_ADMIN_PERMS, MAX_ADMINS, OWNER_ID,
} from './config.js';
import { nowSec } from './util.js';

const permsOf = (value) => String(value || '').split(',').filter((p) => ADMIN_PERMS.includes(p));

/** { id, owner, perms:Set } for the owner or an admin; null for everyone else. */
export async function getStaff(userId) {
  const id = Number(userId);
  if (id === OWNER_ID) return { id, owner: true, perms: new Set(ADMIN_PERMS) };
  const r = await db.get(sql`SELECT perms FROM admins WHERE user_id = ${id}`);
  return r ? { id, owner: false, perms: new Set(permsOf(r.perms)) } : null;
}

/** May `staff` do what `perm` stands for? 'owner' is the owner alone. */
export function can(staff, perm) {
  if (!staff) return false;
  if (staff.owner) return true;
  return perm !== 'owner' && staff.perms.has(perm);
}

export async function listAdmins() {
  const rows = await db.all(sql`SELECT user_id, perms, added_at FROM admins ORDER BY added_at LIMIT ${MAX_ADMINS}`);
  return rows.map((r) => ({ id: Number(r.user_id), perms: permsOf(r.perms), addedAt: Number(r.added_at) }));
}

/** 'ok' | 'dup' | 'full' | 'owner' */
export async function addAdmin(userId) {
  const id = Number(userId);
  if (id === OWNER_ID) return 'owner';
  const r = await db.run(sql`
    INSERT INTO admins (user_id, perms, added_at)
    SELECT ${id}, ${DEFAULT_ADMIN_PERMS.join(',')}, ${nowSec()}
    WHERE (SELECT count(*) FROM (SELECT 1 FROM admins LIMIT ${MAX_ADMINS})) < ${MAX_ADMINS}
    ON CONFLICT(user_id) DO NOTHING`);
  if (r.rowsAffected) return 'ok';
  return (await getStaff(id)) ? 'dup' : 'full';
}

export async function removeAdmin(userId) {
  return (await db.run(sql`DELETE FROM admins WHERE user_id = ${Number(userId)}`)).rowsAffected > 0;
}

/** Turns one permission of an admin on or off; returns their permissions after, or null if not an admin. */
export async function togglePerm(userId, perm) {
  if (!ADMIN_PERMS.includes(perm)) return null;
  const staff = await getStaff(userId);
  if (!staff || staff.owner) return null;
  if (staff.perms.has(perm)) staff.perms.delete(perm);
  else staff.perms.add(perm);
  const perms = ADMIN_PERMS.filter((p) => staff.perms.has(p));
  await db.run(sql`UPDATE admins SET perms = ${perms.join(',')} WHERE user_id = ${staff.id}`);
  return perms;
}

/** Who to tell about something that needs `perm`: the owner first, then the admins who have it. */
export async function staffWith(perm) {
  const ids = [OWNER_ID];
  for (const a of await listAdmins()) if (a.perms.includes(perm)) ids.push(a.id);
  return ids;
}
