import { describe, expect, it } from 'vitest';
import { OWNER_ID } from '../../tgcloud/lib/config.js';
import { actorOf, ALL_PERMS, can, canManageChannels, canModerate, canSetRole, isStaff, P, skipsForcedJoin } from '../../tgcloud/lib/roles.js';

const owner = actorOf(OWNER_ID, null);
const user = actorOf(1001, null);
const otherUser = actorOf(1002, null);
const superAdmin = actorOf(2001, { role: 'super_admin' });
const admin = actorOf(2002, { role: 'admin' });
const admin2 = actorOf(2005, { role: 'admin' });
const moderator = actorOf(2003, { role: 'moderator' });
const support = actorOf(2004, { role: 'support' });

describe('roles: owner vs ordinary user', () => {
  it('the owner is recognised by numeric id only and has every permission', () => {
    expect(owner.role).toBe('owner');
    expect(owner.perms).toBe(ALL_PERMS);
    for (const flag of Object.values(P)) expect(can(owner, flag)).toBe(true);
    expect(canManageChannels(owner)).toBe(true);
  });

  it('an ordinary user has no admin permission at all', () => {
    expect(user.role).toBe('user');
    for (const flag of Object.values(P)) expect(can(user, flag)).toBe(false);
    expect(canManageChannels(user)).toBe(false);
    expect(isStaff(user)).toBe(false);
    expect(canModerate(user, otherUser)).toBe(false);
    expect(canSetRole(user, otherUser, 'support')).toBe(false);
  });

  it('a stored row can never make someone the owner; unknown roles count as none', () => {
    expect(actorOf(1001, { role: 'owner' }).role).toBe('user');
    expect(actorOf(1001, { role: 'god' }).role).toBe('user');
    expect(actorOf(String(OWNER_ID), null).role).toBe('owner');
  });

  it('only the owner manages forced-join channels', () => {
    for (const a of [superAdmin, admin, moderator, support, user]) expect(canManageChannels(a)).toBe(false);
  });
});

describe('roles: the owner is immune', () => {
  it('nobody can ban, restrict or demote the owner — not even a super admin', () => {
    for (const a of [superAdmin, admin, moderator, support, user, owner]) {
      expect(canModerate(a, owner)).toBe(false);
      for (const r of ['super_admin', 'admin', 'moderator', 'support', 'user']) expect(canSetRole(a, owner, r)).toBe(false);
    }
  });
});

describe('roles: ranks and SUPER_ADMIN', () => {
  it('only the owner grants or revokes SUPER_ADMIN', () => {
    expect(canSetRole(owner, user, 'super_admin')).toBe(true);
    expect(canSetRole(owner, superAdmin, 'user')).toBe(true);
    expect(canSetRole(superAdmin, user, 'super_admin')).toBe(false);
    expect(canSetRole(superAdmin, actorOf(2010, { role: 'super_admin' }), 'admin')).toBe(false);
  });

  it('staff act only on people strictly below their rank, never on themselves', () => {
    expect(canModerate(admin, moderator)).toBe(true);
    expect(canModerate(admin, user)).toBe(true);
    expect(canModerate(admin, admin2)).toBe(false);
    expect(canModerate(admin, superAdmin)).toBe(false);
    expect(canModerate(admin, admin)).toBe(false);
    expect(canModerate(support, user)).toBe(false); // support has no MANAGE_USERS
  });

  it('a super admin hands out roles below its own; an admin without MANAGE_ADMINS cannot', () => {
    expect(canSetRole(superAdmin, user, 'admin')).toBe(true);
    expect(canSetRole(superAdmin, admin, 'moderator')).toBe(true);
    expect(canSetRole(admin, user, 'support')).toBe(false);
  });

  it('custom permission flags can only narrow a role, never widen it', () => {
    const narrowed = actorOf(3001, { role: 'support', perms: ALL_PERMS });
    expect(can(narrowed, P.BROADCAST)).toBe(false);
    expect(can(narrowed, P.VIEW_USERS)).toBe(true);
    const none = actorOf(3002, { role: 'admin', perms: 0 });
    expect(can(none, P.VIEW_USERS)).toBe(false);
  });

  it('staff and the owner skip the forced-join gate, users do not', () => {
    expect(skipsForcedJoin(owner)).toBe(true);
    expect(skipsForcedJoin(support)).toBe(true);
    expect(skipsForcedJoin(user)).toBe(false);
  });
});
