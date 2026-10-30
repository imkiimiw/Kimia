/*
 * Aegis database. Every table is prefixed aegis_ (the bot's own namespace).
 * Deploy with `npm run deploy` (push, then `tgcloud migrate --safe` creates/extends the tables).
 * No foreign keys (the platform forbids them): integrity is kept in code. Times are unix seconds
 * unless a name ends in _ms. JSON lives in TEXT columns. Every query is keyed, indexed or LIMITed.
 * Data migrations (seeding, backfills) are versioned in lib/core/migrations.js.
 * Only block comments in this project's modules: a paste that loses its line breaks still works.
 */
import { table, integer, text, index, uniqueIndex, sql } from 'sdk/db';

/*
 * Everyone the bot has met in private. started = has opened the bot's private chat (/start or any
 * message), so the bot may write to them; blocked = blocked the bot (my_chat_member "kicked" or a
 * 403 from sending). Reachable = started and not blocked. join_ok_at/join_rev cache a passed
 * forced-join check for the current channel list revision.
 */
export const users = table('aegis_users', {
  userId: integer('user_id').primaryKey(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  username: text('username'),
  tgLang: text('tg_lang'), /* Telegram's language_code, as last seen */
  lang: text('lang').notNull().default('en'),
  langSet: integer('lang_set').notNull().default(0), /* 1 = chosen in the picker */
  started: integer('started').notNull().default(0),
  startedAt: integer('started_at').notNull().default(0), /* first time they opened the bot's chat */
  blocked: integer('blocked').notNull().default(0),
  blockedAt: integer('blocked_at').notNull().default(0),
  joinOkAt: integer('join_ok_at').notNull().default(0),
  joinRev: integer('join_rev').notNull().default(0),
  firstSeen: integer('first_seen').notNull().default(0),
  lastSeen: integer('last_seen').notNull().default(0),
}, (t) => ({
  reachable: index('idx_aegis_users_reachable').on(t.userId).where(sql`started = 1 AND blocked = 0`),
  startedAt: index('idx_aegis_users_started_at').on(t.startedAt).where(sql`started = 1`),
  lastSeen: index('idx_aegis_users_last_seen').on(t.lastSeen).where(sql`started = 1`),
  blocked: index('idx_aegis_users_blocked').on(t.blockedAt).where(sql`blocked = 1`),
}));

/*
 * Groups, supergroups and channels the bot is or was in, from my_chat_member. active = the bot is
 * in the chat now (member/administrator). member_count is cached (getChatMemberCount) and refreshed
 * lazily. lang = the language for messages the bot posts there (set in the chat's panel).
 * registered = Aegis has set the chat up (Phase 2): bot_rights is the bot's own ChatMember rights
 * (JSON), missing the required rights it lacks (JSON list of right ids, see lib/engines/rights.js).
 * admins_at = when the admin cache (aegis_chat_admins) was last refreshed. reminder = remind the
 * group about admins not appointed through Aegis (reminded_at: the last reminder).
 */
export const chats = table('aegis_chats', {
  chatId: integer('chat_id').primaryKey(),
  type: text('type').notNull(), /* group, supergroup, channel */
  title: text('title'),
  username: text('username'),
  botStatus: text('bot_status').notNull().default('member'), /* member, administrator, restricted, left, kicked */
  active: integer('active').notNull().default(1),
  lang: text('lang').notNull().default('en'),
  addedBy: integer('added_by').notNull().default(0),
  memberCount: integer('member_count').notNull().default(0),
  countAt: integer('count_at').notNull().default(0),
  joinedAt: integer('joined_at').notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(0),
  registered: integer('registered').notNull().default(0),
  registeredAt: integer('registered_at').notNull().default(0),
  botRights: text('bot_rights'),
  missing: text('missing'),
  rightsAt: integer('rights_at').notNull().default(0),
  adminsAt: integer('admins_at').notNull().default(0),
  reminder: integer('reminder').notNull().default(1),
  remindedAt: integer('reminded_at').notNull().default(0),
}, (t) => ({
  activeType: index('idx_aegis_chats_active_type').on(t.active, t.type, t.chatId),
  countAt: index('idx_aegis_chats_count_at').on(t.active, t.countAt),
}));

/*
 * Cache of each chat's administrators (getChatAdministrators / chat_member / getChatMember).
 * via_aegis = can_be_edited: Telegram lets the bot edit or demote only admins it promoted itself.
 * rights = the admin's rights (JSON). A row disappears when the user stops being an admin, together
 * with their access override (former-admin revocation).
 */
export const chatAdmins = table('aegis_chat_admins', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  status: text('status').notNull(), /* creator, administrator */
  viaAegis: integer('via_aegis').notNull().default(0),
  isBot: integer('is_bot').notNull().default(0),
  rights: text('rights'),
  firstName: text('first_name'),
  username: text('username'),
  updatedAt: integer('updated_at').notNull().default(0),
}, (t) => ({
  byChatUser: uniqueIndex('idx_aegis_chat_admins_chat_user').on(t.chatId, t.userId),
  byUser: index('idx_aegis_chat_admins_user').on(t.userId),
}));

/*
 * Aegis access levels set by hand for an admin of a chat (otherwise the level follows their
 * Telegram rights — lib/engines/admins.js). Levels: 0 none, 1 view, 2 settings, 3 full.
 */
export const access = table('aegis_access', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  level: integer('level').notNull(),
  setBy: integer('set_by').notNull().default(0),
  setAt: integer('set_at').notNull().default(0),
}, (t) => ({
  byChatUser: uniqueIndex('idx_aegis_access_chat_user').on(t.chatId, t.userId),
}));

/* Every promotion, edit and demotion Aegis made (who, whom, which rights) — kept for later phases. */
export const promotions = table('aegis_promotions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  actorId: integer('actor_id').notNull(),
  kind: text('kind').notNull(), /* promote, edit, demote */
  rights: text('rights'),
  at: integer('at').notNull(),
}, (t) => ({
  byChatUser: index('idx_aegis_promotions_chat_user').on(t.chatId, t.userId, t.at),
}));

/*
 * Forced-join channels (at most MAX_JOIN_CHANNELS), in `position` order. bot_admin: last known
 * state (1 admin, 0 not admin or unreachable, -1 never checked).
 */
export const joinChannels = table('aegis_join_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id'),
  uname: text('uname').unique(), /* lowercase username, when public */
  username: text('username'),
  title: text('title'),
  inviteLink: text('invite_link'), /* for a channel without a public username */
  position: integer('position').notNull().default(0),
  botAdmin: integer('bot_admin').notNull().default(-1),
  checkedAt: integer('checked_at').notNull().default(0),
  lastError: text('last_error'),
  warnedAt: integer('warned_at').notNull().default(0),
  createdAt: integer('created_at').notNull().default(0),
}, (t) => ({
  byPosition: index('idx_aegis_join_position').on(t.position),
}));

/* Bot-wide settings and small state (key/value). Keys are listed in lib/core/kv.js. */
export const kv = table('aegis_kv', {
  key: text('key').primaryKey(),
  value: text('value'),
});

/* A multi-step input a user is in the middle of (e.g. the owner sending a broadcast). */
export const states = table('aegis_states', {
  userId: integer('user_id').primaryKey(),
  kind: text('kind').notNull(),
  data: text('data').notNull().default('{}'),
  expiresAt: integer('expires_at').notNull().default(0),
}, (t) => ({
  expires: index('idx_aegis_states_expires').on(t.expiresAt),
}));

/* Idempotency: every update_id handled (status 0 = in progress, 1 = done). Old rows are swept. */
export const updates = table('aegis_updates', {
  updateId: integer('update_id').primaryKey(),
  status: integer('status').notNull().default(0),
  at: integer('at').notNull().default(0),
}, (t) => ({
  byAt: index('idx_aegis_updates_at').on(t.at),
}));

/* Sensitive actions (append-only: no code path deletes from it). */
export const audit = table('aegis_audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  actorId: integer('actor_id').notNull().default(0), /* 0 = the system */
  chatId: integer('chat_id').notNull().default(0),
  action: text('action').notNull(),
  target: text('target'),
  details: text('details'), /* JSON */
}, (t) => ({
  byAt: index('idx_aegis_audit_at').on(t.at),
  byActor: index('idx_aegis_audit_actor').on(t.actorId, t.at),
  byChat: index('idx_aegis_audit_chat').on(t.chatId, t.at),
}));

/* Structured error log: one row per failure caught at an entry point or in background work. */
export const errors = table('aegis_errors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  source: text('source').notNull(), /* handler or job name */
  updateId: integer('update_id').notNull().default(0),
  chatId: integer('chat_id').notNull().default(0),
  userId: integer('user_id').notNull().default(0),
  code: text('code'), /* Bot API error code, or the error's name */
  message: text('message'),
  stack: text('stack'),
}, (t) => ({
  byAt: index('idx_aegis_errors_at').on(t.at),
}));

/*
 * Owner broadcasts, a queue: draft → queued/running → (paused ↔ running) → done | cancelled.
 * At most one is running or paused; queued ones start in id order. `cursor` is the last recipient
 * id handled (users: user_id; chats: chat_id), saved after every message, so sending resumes
 * exactly where it stopped. next_at_ms: not before this (pacing, or a 429's retry_after).
 * lock_until_ms: a batch in progress (expires if an invocation dies).
 */
export const broadcasts = table('aegis_broadcasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  audience: text('audience').notNull().default('users'), /* users, groups, channels */
  mode: text('mode').notNull().default('copy'), /* copy, forward */
  fromChat: integer('from_chat').notNull(),
  messageId: integer('message_id').notNull(),
  contentType: text('content_type').notNull().default('text'),
  buttons: text('buttons'), /* JSON inline_keyboard rows (copy mode only) */
  status: text('status').notNull().default('draft'),
  cursor: integer('cursor').notNull().default(-9007199254740991),
  total: integer('total').notNull().default(0),
  sent: integer('sent').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  blocked: integer('blocked').notNull().default(0),
  nextAtMs: integer('next_at_ms').notNull().default(0),
  lockUntilMs: integer('lock_until_ms').notNull().default(0),
  waitSec: integer('wait_sec').notNull().default(0), /* the last retry_after Telegram asked for */
  panelChat: integer('panel_chat').notNull().default(0),
  panelMsg: integer('panel_msg').notNull().default(0), /* the progress message */
  progressAt: integer('progress_at').notNull().default(0),
  lastError: text('last_error'),
  createdBy: integer('created_by').notNull().default(0),
  createdAt: integer('created_at').notNull().default(0),
  startedAt: integer('started_at').notNull().default(0),
  finishedAt: integer('finished_at').notNull().default(0),
}, (t) => ({
  byStatus: index('idx_aegis_broadcasts_status').on(t.status, t.id),
}));
