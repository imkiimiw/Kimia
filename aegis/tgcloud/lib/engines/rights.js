/*
 * Telegram administrator rights, as Aegis uses them. Pure: no database, no Bot API.
 *
 * Required rights for Aegis itself (shown when it is added, and in the panel): delete, restrict,
 * ban, invite, pin, promote. In the Bot API "ban" is part of can_restrict_members, and a channel has
 * no can_pin_messages: pinning there needs can_edit_messages.
 * Grantable rights: what an admin promoted through Aegis can receive (only rights the bot has, and
 * only rights the person asking has — lib/engines/admins.js).
 */

export const REQUIRED = [
  { id: 'delete', group: 'can_delete_messages', channel: 'can_delete_messages' },
  { id: 'restrict', group: 'can_restrict_members', channel: 'can_restrict_members' },
  { id: 'ban', group: 'can_restrict_members', channel: 'can_restrict_members' },
  { id: 'invite', group: 'can_invite_users', channel: 'can_invite_users' },
  { id: 'pin', group: 'can_pin_messages', channel: 'can_edit_messages' },
  { id: 'promote', group: 'can_promote_members', channel: 'can_promote_members' },
];

const GRANT_GROUP = ['can_change_info', 'can_delete_messages', 'can_restrict_members', 'can_invite_users', 'can_pin_messages',
  'can_manage_video_chats', 'can_promote_members'];
const GRANT_CHANNEL = ['can_change_info', 'can_post_messages', 'can_edit_messages', 'can_delete_messages', 'can_invite_users',
  'can_restrict_members', 'can_manage_video_chats', 'can_promote_members'];

/* Every right field Aegis reads or writes. */
export const ALL_RIGHTS = ['can_manage_chat', 'can_change_info', 'can_post_messages', 'can_edit_messages', 'can_delete_messages',
  'can_invite_users', 'can_restrict_members', 'can_pin_messages', 'can_manage_topics', 'can_promote_members', 'can_manage_video_chats',
  'can_post_stories', 'can_edit_stories', 'can_delete_stories'];

const kind = (chatType) => (chatType === 'channel' ? 'channel' : 'group');

export const grantable = (chatType) => (kind(chatType) === 'channel' ? GRANT_CHANNEL : GRANT_GROUP);

/* The rights of a ChatMember as { field: true } (the creator has them all). */
export function rightsOf(member) {
  const out = {};
  if (!member) return out;
  if (member.status === 'creator') {
    for (const r of ALL_RIGHTS) out[r] = true;
    return out;
  }
  if (member.status !== 'administrator') return out;
  for (const r of ALL_RIGHTS) if (member[r] === true) out[r] = true;
  return out;
}

export const isAdminStatus = (status) => status === 'creator' || status === 'administrator';

/* The required items the bot lacks, by id, for a ChatMember of the bot (or its rights object). */
export function missingRequired(chatType, member) {
  const rights = member && member.status ? rightsOf(member) : (member || {});
  const k = kind(chatType);
  return REQUIRED.filter((it) => rights[it[k]] !== true).map((it) => it.id);
}

/* Basic groups ("group") can't promote or restrict at all: those Bot API methods need a supergroup. */
export const canManageAdmins = (chatType) => chatType === 'supergroup' || chatType === 'channel';

/* The admin=… rights for an "add / grant rights" deep link (t.me/<bot>?startgroup&admin=…). */
export function deepLinkRights(chatType) {
  if (kind(chatType) === 'channel') return 'post_messages+edit_messages+delete_messages+restrict_members+invite_users+promote_members+change_info';
  return 'change_info+delete_messages+restrict_members+invite_users+pin_messages+promote_members';
}

export const addToGroupUrl = (bot) => `https://t.me/${bot}?startgroup=aegis&admin=${deepLinkRights('supergroup')}`;
export const addToChannelUrl = (bot) => `https://t.me/${bot}?startchannel&admin=${deepLinkRights('channel')}`;

/* What Aegis asks for by default when someone adds it as an admin (setMyDefaultAdministratorRights). */
export function defaultRights(forChannels) {
  const base = {
    is_anonymous: false, can_manage_chat: true, can_delete_messages: true, can_manage_video_chats: false, can_restrict_members: true,
    can_promote_members: true, can_change_info: true, can_invite_users: true, can_post_stories: false, can_edit_stories: false,
    can_delete_stories: false,
  };
  if (forChannels) return { ...base, can_post_messages: true, can_edit_messages: true };
  return { ...base, can_pin_messages: true, can_manage_topics: false };
}

/* promoteChatMember parameters giving exactly `chosen` (an array of right fields) in a chat type. */
export function promoteParams(chatType, chosen) {
  const set = new Set(chosen);
  const out = { is_anonymous: false };
  for (const r of grantable(chatType)) out[r] = set.has(r);
  out.can_manage_chat = chosen.length > 0;
  return out;
}

/* promoteChatMember parameters that remove every right (demotion). */
export function demoteParams(chatType) {
  const out = { is_anonymous: false, can_manage_chat: false };
  for (const r of grantable(chatType)) out[r] = false;
  return out;
}
