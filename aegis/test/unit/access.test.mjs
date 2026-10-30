// Phase 2 rules, without Telegram: required rights, promotion parameters, access levels and the
// anti-escalation checks that decide who may appoint, edit, demote or change whose access.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { L, canManageAdmins, canSetLevel, defaultLevel, effectiveLevel, grantableBy, manageBlock } from '../../tgcloud/lib/engines/admins.js';
import { addToChannelUrl, addToGroupUrl, canManageAdmins as typeCanManage, defaultRights, demoteParams, grantable, missingRequired, promoteParams, rightsOf }
  from '../../tgcloud/lib/engines/rights.js';
import { mentionOf, parseCommand, startPayload } from '../../tgcloud/lib/core/commands.js';

const admin = (rights = {}, extra = {}) => ({ status: 'administrator', user: { id: 1, is_bot: false }, can_be_edited: false, ...rights, ...extra });
const creator = { status: 'creator', user: { id: 2 } };

test('required rights: delete, restrict, ban, invite, pin, promote — pin is "edit messages" in a channel', () => {
  assert.deepEqual(missingRequired('supergroup', { status: 'member' }), ['delete', 'restrict', 'ban', 'invite', 'pin', 'promote']);
  assert.deepEqual(missingRequired('supergroup', admin({ can_delete_messages: true, can_restrict_members: true, can_invite_users: true })), ['pin', 'promote']);
  assert.deepEqual(missingRequired('channel', admin({ can_delete_messages: true, can_restrict_members: true, can_invite_users: true, can_edit_messages: true,
    can_promote_members: true })), []);
  assert.deepEqual(missingRequired('channel', admin({ can_pin_messages: true })), ['delete', 'restrict', 'ban', 'invite', 'pin', 'promote']);
  assert.deepEqual(missingRequired('supergroup', creator), []);
  assert.equal(typeCanManage('group'), false, 'basic groups can\'t promote');
  assert.equal(typeCanManage('supergroup'), true);
});

test('promotion parameters: exactly the chosen rights; demotion clears everything', () => {
  const p = promoteParams('supergroup', ['can_delete_messages', 'can_pin_messages']);
  assert.equal(p.can_delete_messages, true);
  assert.equal(p.can_pin_messages, true);
  assert.equal(p.can_promote_members, false);
  assert.equal(p.can_manage_chat, true);
  assert.equal(p.can_post_messages, undefined, 'no channel rights in a group');
  const d = demoteParams('channel');
  assert.equal(d.can_manage_chat, false);
  assert.ok(grantable('channel').every((r) => d[r] === false));
  assert.ok(grantable('channel').includes('can_post_messages'));
  assert.ok(!grantable('supergroup').includes('can_post_messages'));
  assert.deepEqual(rightsOf(creator).can_promote_members, true);
  assert.deepEqual(rightsOf({ status: 'member' }), {});
  for (const forChannels of [false, true]) {
    const r = defaultRights(forChannels);
    assert.equal(typeof r.can_post_stories, 'boolean');
    assert.equal(r.can_promote_members, true);
  }
});

test('add-to-group/channel links ask for the required rights', () => {
  assert.equal(addToGroupUrl('aegis_bot'), 'https://t.me/aegis_bot?startgroup=aegis&admin=change_info+delete_messages+restrict_members+invite_users+pin_messages+promote_members');
  assert.match(addToChannelUrl('aegis_bot'), /^https:\/\/t\.me\/aegis_bot\?startchannel&admin=post_messages\+edit_messages\+delete_messages\+restrict_members/);
});

test('default access level follows Telegram rights; manual levels never touch the creator or non-admins', () => {
  assert.equal(defaultLevel(creator), L.creator);
  assert.equal(defaultLevel(admin({ can_promote_members: true })), L.full);
  assert.equal(defaultLevel(admin({ can_change_info: true })), L.settings);
  assert.equal(defaultLevel(admin({ can_delete_messages: true })), L.view);
  assert.equal(defaultLevel(admin({}, { user: { id: 3, is_bot: true } })), L.none, 'bots');
  assert.equal(defaultLevel({ status: 'member' }), L.none);
  assert.equal(effectiveLevel(admin({ can_promote_members: true }), L.none), L.none);
  assert.equal(effectiveLevel(admin({}), L.settings), L.settings);
  assert.equal(effectiveLevel(creator, L.view), L.creator);
  assert.equal(effectiveLevel({ status: 'left' }, L.full), L.none, 'former admins have nothing');
});

test('managing admins needs Full plus Telegram\'s "add new admins" (or being the creator)', () => {
  assert.equal(canManageAdmins({ level: L.creator, member: creator }), true);
  assert.equal(canManageAdmins({ level: L.full, member: admin({ can_promote_members: true }) }), true);
  assert.equal(canManageAdmins({ level: L.full, member: admin({}) }), false, 'Full by a manual level, without the Telegram right');
  assert.equal(canManageAdmins({ level: L.settings, member: admin({ can_promote_members: true }) }), false, 'lowered by hand');
});

test('nobody can grant a right they (or the bot) don\'t have', () => {
  const bot = { can_delete_messages: true, can_restrict_members: true, can_promote_members: true, can_pin_messages: true };
  const frank = { level: L.full, member: admin({ can_promote_members: true, can_delete_messages: true }) };
  assert.deepEqual(grantableBy('supergroup', frank, bot), ['can_delete_messages', 'can_promote_members']);
  assert.deepEqual(grantableBy('supergroup', { level: L.creator, member: creator }, bot), ['can_delete_messages', 'can_restrict_members', 'can_pin_messages', 'can_promote_members']);
});

test('edit/demote: only Aegis admins, never the creator, not an equal or higher level unless you appointed them', () => {
  const frank = { id: 10, level: L.full, member: admin({ can_promote_members: true }) };
  const owner = { id: 2, level: L.creator, member: creator };
  const viaAegis = (level, promoter = 2, rights = {}) => ({ member: admin(rights, { can_be_edited: true }), level, promoter });
  assert.equal(manageBlock(frank, viaAegis(L.view)), null);
  assert.equal(manageBlock(frank, viaAegis(L.full)), 'higher');
  assert.equal(manageBlock(frank, viaAegis(L.full, 10)), null, 'one Frank appointed himself');
  assert.equal(manageBlock(frank, { member: admin({}), level: L.view, promoter: 0 }), 'not_via_aegis');
  assert.equal(manageBlock(frank, { member: creator, level: L.creator, promoter: 0 }), 'creator');
  assert.equal(manageBlock(frank, { member: { status: 'member' }, level: 0, promoter: 0 }), 'not_admin');
  assert.equal(manageBlock(owner, viaAegis(L.full)), null);
  assert.equal(manageBlock({ id: 11, level: L.view, member: admin({}) }, viaAegis(L.none)), 'no_rights');
});

test('access levels: the creator gives up to Full; Full gives only below Full to those below Full; nobody else changes levels', () => {
  assert.equal(canSetLevel(L.creator, L.view, L.full, false), true);
  assert.equal(canSetLevel(L.creator, L.full, L.none, false), true);
  assert.equal(canSetLevel(L.creator, L.view, null, false), true, 'back to the default');
  assert.equal(canSetLevel(L.creator, L.creator, L.view, true), false, 'the creator\'s own level');
  assert.equal(canSetLevel(L.full, L.view, L.settings, false), true);
  assert.equal(canSetLevel(L.full, L.view, L.full, false), false);
  assert.equal(canSetLevel(L.full, L.full, L.view, false), false);
  assert.equal(canSetLevel(L.settings, L.view, L.none, false), false);
});

test('commands: /start payloads, /cmd@bot mentions, the new Persian and English aliases', () => {
  assert.equal(startPayload('/start c_-1001234567890'), 'c_-1001234567890');
  assert.equal(startPayload('/start@aegis_bot c_-100123'), 'c_-100123');
  assert.equal(startPayload('/start'), null);
  assert.equal(startPayload('/start bad payload'), null);
  assert.equal(mentionOf('/config@Aegis_Bot'), 'aegis_bot');
  assert.equal(mentionOf('/config'), null);
  for (const [w, cmd] of [['پیکربندی', 'config'], ['config', 'config'], ['تنظیمات', 'config'], ['/config', 'config'], ['وضعیت', 'status'], ['status', 'status'],
    ['خاموش', 'shutdown'], ['/shutdown', 'shutdown'], ['فعال\u200Cسازی', 'activate'], ['فعالسازی', 'activate'], ['activate', 'activate'], ['настройки', 'config']]) {
    assert.equal(parseCommand(w), cmd, w);
  }
});
