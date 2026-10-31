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
  lockNotice: integer('lock_notice').notNull().default(0), /* the last lock notice posted (deleted when the next one comes) */
  lockNoticeAt: integer('lock_notice_at').notNull().default(0),
  welcomeMsg: integer('welcome_msg').notNull().default(0), /* the last welcome (deleted when the next one comes) */
  isForum: integer('is_forum').notNull().default(0),
  adminCallAt: integer('admin_call_at').notNull().default(0),
  linkedId: integer('linked_id').notNull().default(0), /* a channel's discussion group, or a discussion group's channel */
  dmChat: integer('dm_chat').notNull().default(0), /* a channel's direct messages chat, when Aegis has seen it */
  jrHoldUntil: integer('jr_hold_until').notNull().default(0), /* a channel's join requests are left to the admins until then (a burst) */
  burstAt: integer('burst_at').notNull().default(0), /* the last «many joins at once» alert */
  lastPostAt: integer('last_post_at').notNull().default(0), /* a discussion group: when the channel's last post arrived */
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

/*
 * Per-chat settings (Phase 3+): one row per changed key; defaults live in lib/engines/settings.js.
 */
export const chatSettings = table('aegis_chat_settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  key: text('key').notNull(),
  value: text('value'),
  updatedBy: integer('updated_by').notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(0),
}, (t) => ({
  byChatKey: uniqueIndex('idx_aegis_chat_settings_chat_key').on(t.chatId, t.key),
}));

/*
 * The 18 per-chat lists (lib/engines/lists.js). ekey is the normalized key (a user id, or the
 * lowercase text); value is what is shown. expires_at: a timed entry (e.g. a 1-day mute), 0 = none.
 */
export const listEntries = table('aegis_list_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  list: text('list').notNull(),
  ekey: text('ekey').notNull(),
  value: text('value').notNull(),
  userId: integer('user_id').notNull().default(0),
  note: text('note'),
  addedBy: integer('added_by').notNull().default(0),
  addedAt: integer('added_at').notNull().default(0),
  updatedBy: integer('updated_by').notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(0),
  expiresAt: integer('expires_at').notNull().default(0),
}, (t) => ({
  byKey: uniqueIndex('idx_aegis_list_entries_key').on(t.chatId, t.list, t.ekey),
  byAdded: index('idx_aegis_list_entries_added').on(t.chatId, t.list, t.addedAt),
}));

/* Every change to a list entry (append-only). */
export const listHistory = table('aegis_list_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  list: text('list').notNull(),
  ekey: text('ekey').notNull(),
  value: text('value'),
  action: text('action').notNull(), /* add, remove, edit */
  actorId: integer('actor_id').notNull().default(0),
  at: integer('at').notNull(),
  details: text('details'),
}, (t) => ({
  byList: index('idx_aegis_list_history_list').on(t.chatId, t.list, t.at),
  byKey: index('idx_aegis_list_history_key').on(t.chatId, t.list, t.ekey, t.at),
}));

/*
 * Punishments (lib/engines/punish.js): warn, mute, restrict, quarantine, kick, ban, demote.
 * status: active, done (kick), undone, audit (Audit Mode: only recorded). until: 0 = no end.
 * source: command, panel, list, step, blacklist, betrayal. meta: JSON (e.g. a demoted admin's rights).
 */
export const punishments = table('aegis_punishments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  kind: text('kind').notNull(),
  reason: text('reason'),
  actorId: integer('actor_id').notNull().default(0),
  source: text('source').notNull().default('command'),
  status: text('status').notNull().default('active'),
  until: integer('until').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  undoneBy: integer('undone_by').notNull().default(0),
  undoneAt: integer('undone_at').notNull().default(0),
  noticeMsg: integer('notice_msg').notNull().default(0),
  meta: text('meta'),
}, (t) => ({
  byUser: index('idx_aegis_punishments_user').on(t.chatId, t.userId, t.kind, t.status),
  byChat: index('idx_aegis_punishments_chat').on(t.chatId, t.createdAt),
}));

/* Destructive admin actions seen in chats (bans, removals, demotions) — anti-betrayal's window. */
export const adminActions = table('aegis_admin_actions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  actorId: integer('actor_id').notNull(),
  targetId: integer('target_id').notNull(),
  kind: text('kind').notNull(), /* ban, demote */
  at: integer('at').notNull(),
}, (t) => ({
  byActor: index('idx_aegis_admin_actions_actor').on(t.chatId, t.actorId, t.at),
  byAt: index('idx_aegis_admin_actions_at').on(t.at),
}));

/* Anti-betrayal incidents: who, how many, what Aegis did, which victims (JSON), undone or not. */
export const incidents = table('aegis_incidents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  actorId: integer('actor_id').notNull(),
  count: integer('count').notNull().default(0),
  action: text('action').notNull(), /* demoted, alert, audit, failed */
  victims: text('victims'),
  at: integer('at').notNull(),
  undoneBy: integer('undone_by').notNull().default(0),
  undoneAt: integer('undone_at').notNull().default(0),
}, (t) => ({
  byActor: index('idx_aegis_incidents_actor').on(t.chatId, t.actorId, t.at),
}));

/*
 * Group locks (Phase 4): one row per chat and lock that was ever configured; config is JSON
 * { on, a, d, del, n, txt, log, exT, exM, ex, s, sc } (lib/engines/locks.js validates it).
 */
export const locks = table('aegis_locks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  code: text('code').notNull(),
  enabled: integer('enabled').notNull().default(0),
  config: text('config').notNull(),
  updatedBy: integer('updated_by').notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(0),
}, (t) => ({
  byChat: uniqueIndex('idx_aegis_locks_chat_code').on(t.chatId, t.code),
  active: index('idx_aegis_locks_active').on(t.chatId).where(sql`enabled = 1`),
}));

/* When members joined a group (for locks that apply to new members only). Removed when they leave. */
export const members = table('aegis_members', {
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  joinedAt: integer('joined_at').notNull(),
}, (t) => ({
  key: uniqueIndex('idx_aegis_members_key').on(t.chatId, t.userId),
  recent: index('idx_aegis_members_recent').on(t.chatId, t.joinedAt),
}));

/* Messages a lock caught (kept 7 days): the panel's «recent hits» per lock. */
export const lockHits = table('aegis_lock_hits', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  code: text('code').notNull(),
  userId: integer('user_id').notNull().default(0),
  action: text('action').notNull(), /* deleted, kept, audit */
  punishment: text('punishment'),
  at: integer('at').notNull(),
}, (t) => ({
  byLock: index('idx_aegis_lock_hits_lock').on(t.chatId, t.code, t.at),
  byAt: index('idx_aegis_lock_hits_at').on(t.at),
}));

/*
 * Group security modules (Phase 5): one row per chat and module (antilink, antiads, flood, raid,
 * captcha, quarantine, suspicious, risk); config JSON validated in lib/engines/guards.js.
 */
export const guards = table('aegis_guards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  code: text('code').notNull(),
  enabled: integer('enabled').notNull().default(0),
  config: text('config').notNull(),
  updatedBy: integer('updated_by').notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(0),
}, (t) => ({
  byChat: uniqueIndex('idx_aegis_guards_chat_code').on(t.chatId, t.code),
}));

/* Per member and chat: the flood window, the last message's fingerprint and how often it repeated. */
export const flood = table('aegis_flood', {
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  winAt: integer('win_at').notNull().default(0),
  n: integer('n').notNull().default(0),
  lastHash: text('last_hash'),
  dupN: integer('dup_n').notNull().default(0),
  msgs: integer('msgs').notNull().default(0), /* messages seen from this member (first-message checks) */
  punishedAt: integer('punished_at').notNull().default(0),
  at: integer('at').notNull().default(0),
}, (t) => ({
  key: uniqueIndex('idx_aegis_flood_key').on(t.chatId, t.userId),
  byAt: index('idx_aegis_flood_at').on(t.at),
}));

/* Captchas: in the group (a muted newcomer presses a button) or in private (a join request). */
export const captchas = table('aegis_captchas', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  kind: text('kind').notNull(), /* group, request */
  answer: integer('answer').notNull(),
  options: text('options').notNull(), /* JSON: the buttons */
  question: text('question'),
  msgChat: integer('msg_chat').notNull().default(0),
  msgId: integer('msg_id').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  status: text('status').notNull().default('pending'), /* pending, passed, failed, expired, approved, removed */
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, (t) => ({
  byUser: index('idx_aegis_captchas_user').on(t.chatId, t.userId, t.status),
  pending: index('idx_aegis_captchas_pending').on(t.expiresAt).where(sql`status = 'pending'`),
}));

/* Emergency lock, read-only mode and raid mode: the chat's earlier permissions, restored at the end. */
export const lockdowns = table('aegis_lockdowns', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  kind: text('kind').notNull(), /* emergency, readonly, raid */
  active: integer('active').notNull().default(1),
  saved: text('saved'), /* ChatPermissions JSON before the lock */
  reason: text('reason'),
  byId: integer('by_id').notNull().default(0),
  startedAt: integer('started_at').notNull(),
  until: integer('until').notNull().default(0), /* 0 = until ended by hand */
  endedAt: integer('ended_at').notNull().default(0),
  endedBy: integer('ended_by').notNull().default(0),
}, (t) => ({
  byChat: index('idx_aegis_lockdowns_chat').on(t.chatId, t.active),
  due: index('idx_aegis_lockdowns_due').on(t.until).where(sql`active = 1 AND until > 0`),
}));

/* Risk alerts: the score, the reasons, what was done, and the admins' feedback. */
export const riskEvents = table('aegis_risk_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  score: integer('score').notNull(),
  reasons: text('reasons').notNull(), /* JSON [[signal, points]] */
  action: text('action').notNull(), /* alert, acted, audit */
  punishId: integer('punish_id').notNull().default(0),
  at: integer('at').notNull(),
  feedback: text('feedback'), /* right, wrong */
  feedbackBy: integer('feedback_by').notNull().default(0),
}, (t) => ({
  byChat: index('idx_aegis_risk_events_chat').on(t.chatId, t.at),
}));

/* Media seen recently (duplicate media, in one chat or across chats). Kept a day. */
export const mediaSeen = table('aegis_media_seen', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fileUid: text('file_uid').notNull(),
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  at: integer('at').notNull(),
}, (t) => ({
  byFile: index('idx_aegis_media_seen_file').on(t.fileUid, t.at),
  byAt: index('idx_aegis_media_seen_at').on(t.at),
}));

/* Fingerprints of ad-like messages (links, @usernames, phones): the same text in several groups. Kept a day. */
export const msgHashes = table('aegis_msg_hashes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  hash: text('hash').notNull(),
  chatId: integer('chat_id').notNull(),
  at: integer('at').notNull(),
}, (t) => ({
  byUser: index('idx_aegis_msg_hashes_user').on(t.userId, t.hash, t.at),
  byAt: index('idx_aegis_msg_hashes_at').on(t.at),
}));

/* Federations: groups that share one ban list. */
export const feds = table('aegis_feds', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  ownerId: integer('owner_id').notNull(),
  code: text('code').notNull(), /* the join code the owner hands out */
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  byCode: uniqueIndex('idx_aegis_feds_code').on(t.code),
  byOwner: index('idx_aegis_feds_owner').on(t.ownerId),
}));

export const fedChats = table('aegis_fed_chats', {
  fedId: integer('fed_id').notNull(),
  chatId: integer('chat_id').notNull(),
  joinedBy: integer('joined_by').notNull().default(0),
  joinedAt: integer('joined_at').notNull(),
}, (t) => ({
  byChat: uniqueIndex('idx_aegis_fed_chats_chat').on(t.chatId),
  byFed: index('idx_aegis_fed_chats_fed').on(t.fedId),
}));

export const fedAdmins = table('aegis_fed_admins', {
  fedId: integer('fed_id').notNull(),
  userId: integer('user_id').notNull(),
  addedBy: integer('added_by').notNull().default(0),
  addedAt: integer('added_at').notNull(),
}, (t) => ({
  key: uniqueIndex('idx_aegis_fed_admins_key').on(t.fedId, t.userId),
  byUser: index('idx_aegis_fed_admins_user').on(t.userId),
}));

export const fedBans = table('aegis_fed_bans', {
  fedId: integer('fed_id').notNull(),
  userId: integer('user_id').notNull(),
  name: text('name'),
  reason: text('reason'),
  byId: integer('by_id').notNull().default(0),
  at: integer('at').notNull(),
}, (t) => ({
  key: uniqueIndex('idx_aegis_fed_bans_key').on(t.fedId, t.userId),
  byFed: index('idx_aegis_fed_bans_fed').on(t.fedId, t.at),
}));

/*
 * Messages Aegis saw in chats that use scheduled cleanup or self-destructing media/notices (kept
 * 48 h — Telegram lets a bot delete messages only that long). del_at > 0: delete at that time.
 */
export const msgLog = table('aegis_msg_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  msgId: integer('msg_id').notNull(),
  userId: integer('user_id').notNull().default(0),
  kind: text('kind').notNull(), /* text, media, service, aegis */
  at: integer('at').notNull(),
  delAt: integer('del_at').notNull().default(0),
}, (t) => ({
  byChat: index('idx_aegis_msg_log_chat').on(t.chatId, t.at),
  due: index('idx_aegis_msg_log_due').on(t.delAt).where(sql`del_at > 0`),
}));

/* Timed jobs of a chat (night lock, scheduled cleanup): done lazily when next_at has passed. */
export const schedules = table('aegis_schedules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  kind: text('kind').notNull(), /* night, cleanup */
  nextAt: integer('next_at').notNull(),
  lastAt: integer('last_at').notNull().default(0),
}, (t) => ({
  key: uniqueIndex('idx_aegis_schedules_key').on(t.chatId, t.kind),
  due: index('idx_aegis_schedules_due').on(t.nextAt),
}));

/* Members' reports of messages (/report), and what the admins did. */
export const reports = table('aegis_reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  reporterId: integer('reporter_id').notNull(),
  targetId: integer('target_id').notNull().default(0),
  msgId: integer('msg_id').notNull().default(0),
  snippet: text('snippet'),
  reason: text('reason'),
  status: text('status').notNull().default('open'), /* open, deleted, muted, banned, dismissed */
  handledBy: integer('handled_by').notNull().default(0),
  handledAt: integer('handled_at').notNull().default(0),
  at: integer('at').notNull(),
}, (t) => ({
  byChat: index('idx_aegis_reports_chat').on(t.chatId, t.at),
  byReporter: index('idx_aegis_reports_reporter').on(t.chatId, t.reporterId, t.at),
}));

/* Per member and chat: forced join passed at, members added (forced add), last message (slow mode). */
export const memberFlags = table('aegis_member_flags', {
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  fjOkAt: integer('fj_ok_at').notNull().default(0),
  adds: integer('adds').notNull().default(0),
  lastAt: integer('last_at').notNull().default(0),
}, (t) => ({
  key: uniqueIndex('idx_aegis_member_flags_key').on(t.chatId, t.userId),
}));

/* Forum topics Aegis knows of (the Bot API can't list them): name, state, read-only for members. */
export const topics = table('aegis_topics', {
  chatId: integer('chat_id').notNull(),
  threadId: integer('thread_id').notNull(),
  name: text('name').notNull(),
  color: integer('color').notNull().default(0),
  closed: integer('closed').notNull().default(0),
  readonly: integer('readonly').notNull().default(0),
  createdAt: integer('created_at').notNull().default(0),
  lastAt: integer('last_at').notNull().default(0),
}, (t) => ({
  key: uniqueIndex('idx_aegis_topics_key').on(t.chatId, t.threadId),
}));

/* A command sent by an anonymous admin, waiting for a real admin to confirm it with a button. */
export const anonCmds = table('aegis_anon_cmds', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  message: text('message').notNull(), /* the message JSON (text, entities, reply) */
  status: text('status').notNull().default('pending'),
  byId: integer('by_id').notNull().default(0),
  at: integer('at').notNull(),
}, (t) => ({
  byChat: index('idx_aegis_anon_cmds_chat').on(t.chatId, t.at),
}));

/* ---------- Phase 7: channels ---------- */

/* Join requests Aegis received (the Bot API can't list pending requests): what was decided, by whom. */
export const joinRequests = table('aegis_join_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  name: text('name'),
  username: text('username'),
  bio: text('bio'),
  link: text('link'), /* the invite link's name or its visible part */
  query: text('query'), /* the join request query id, when Aegis is the chat's guard bot */
  status: text('status').notNull().default('pending'), /* pending, captcha, approved, declined, expired */
  reason: text('reason'), /* why Aegis decided: blacklist, name, flood, captcha, mode, admin */
  byId: integer('by_id').notNull().default(0),
  at: integer('at').notNull(),
  decidedAt: integer('decided_at').notNull().default(0),
}, (t) => ({
  byChat: index('idx_aegis_join_requests_chat').on(t.chatId, t.status, t.at),
  byUser: index('idx_aegis_join_requests_user').on(t.chatId, t.userId),
}));

/* Invite links created through Aegis (bots can't list other links), with what they brought in. */
export const inviteLinks = table('aegis_invite_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  link: text('link').notNull(),
  name: text('name'),
  createdBy: integer('created_by').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  expireAt: integer('expire_at').notNull().default(0),
  memberLimit: integer('member_limit').notNull().default(0),
  requests: integer('requests').notNull().default(0), /* 1 = joining needs approval */
  revoked: integer('revoked').notNull().default(0),
  joins: integer('joins').notNull().default(0),
  asked: integer('asked').notNull().default(0), /* join requests through it */
}, (t) => ({
  byChat: index('idx_aegis_invite_links_chat').on(t.chatId, t.createdAt),
  byLink: uniqueIndex('idx_aegis_invite_links_link').on(t.link),
}));

/* A channel's subscribers per day (count when Aegis looked) and the joins and leaves it saw. */
export const channelStats = table('aegis_channel_stats', {
  chatId: integer('chat_id').notNull(),
  day: integer('day').notNull(), /* days since 1970 (UTC) */
  members: integer('members').notNull().default(0),
  joins: integer('joins').notNull().default(0),
  leaves: integer('leaves').notNull().default(0),
}, (t) => ({
  key: uniqueIndex('idx_aegis_channel_stats_key').on(t.chatId, t.day),
}));

/* Channel posts Aegis saw or published (archive), the current content and how many versions. */
export const posts = table('aegis_posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  msgId: integer('msg_id').notNull(),
  kind: text('kind').notNull(), /* text, photo, video, animation, document, audio, voice, other */
  content: text('content').notNull(), /* JSON: text/caption, entities, file_id */
  signature: text('signature'),
  album: text('album'),
  viaAegis: integer('via_aegis').notNull().default(0),
  versions: integer('versions').notNull().default(1),
  reactions: integer('reactions').notNull().default(0), /* total reactions (message_reaction_count) */
  comments: integer('comments').notNull().default(0), /* replies in the discussion group */
  postedAt: integer('posted_at').notNull(),
  editedAt: integer('edited_at').notNull().default(0),
}, (t) => ({
  key: uniqueIndex('idx_aegis_posts_key').on(t.chatId, t.msgId),
  byChat: index('idx_aegis_posts_chat').on(t.chatId, t.postedAt),
}));

/* Every earlier version of a post (edit history); source: edit, restore, revert. */
export const postVersions = table('aegis_post_versions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  postId: integer('post_id').notNull(),
  n: integer('n').notNull(),
  content: text('content').notNull(),
  source: text('source').notNull().default('edit'),
  at: integer('at').notNull(),
}, (t) => ({
  byPost: index('idx_aegis_post_versions_post').on(t.postId, t.n),
}));

/* Posts waiting to be published: for approval, or at a set time (no scheduler: published lazily). */
export const postQueue = table('aegis_post_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  kind: text('kind').notNull(), /* text, photo, … (as in aegis_posts) */
  content: text('content').notNull(),
  options: text('options'), /* JSON: silent, protect */
  authorId: integer('author_id').notNull().default(0),
  origin: text('origin').notNull().default('aegis'), /* aegis (sent to Aegis), channel (held from the channel) */
  status: text('status').notNull().default('pending'), /* pending, scheduled, published, rejected, failed */
  publishAt: integer('publish_at').notNull().default(0),
  decidedBy: integer('decided_by').notNull().default(0),
  decidedAt: integer('decided_at').notNull().default(0),
  resultMsg: integer('result_msg').notNull().default(0),
  at: integer('at').notNull(),
}, (t) => ({
  byChat: index('idx_aegis_post_queue_chat').on(t.chatId, t.status, t.at),
  due: index('idx_aegis_post_queue_due').on(t.publishAt).where(sql`status = 'scheduled'`),
}));

/* A channel's crisis mode: what was done and saved so it can be undone. */
export const crises = table('aegis_crises', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  byId: integer('by_id').notNull(),
  saved: text('saved').notNull(), /* JSON: settings before, demoted admins with their rights */
  report: text('report'), /* JSON: what each step did */
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at').notNull().default(0),
  endedBy: integer('ended_by').notNull().default(0),
}, (t) => ({
  byChat: index('idx_aegis_crises_chat').on(t.chatId, t.startedAt),
}));

/* Copying a channel's older posts into its backup chat, a batch at a time. */
export const backupJobs = table('aegis_backup_jobs', {
  chatId: integer('chat_id').primaryKey(),
  target: integer('target').notNull(),
  nextId: integer('next_id').notNull().default(1),
  lastId: integer('last_id').notNull().default(0),
  copied: integer('copied').notNull().default(0),
  status: text('status').notNull().default('running'), /* running, paused, done, failed */
  error: text('error'),
  retryAt: integer('retry_at').notNull().default(0),
  byId: integer('by_id').notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(0),
}, (t) => ({
  running: index('idx_aegis_backup_jobs_running').on(t.retryAt).where(sql`status = 'running'`),
}));

/* A channel's direct messages chat (a supergroup Telegram creates for it) → the channel. */
export const dmChats = table('aegis_dm_chats', {
  dmChatId: integer('dm_chat_id').primaryKey(),
  channelId: integer('channel_id').notNull(),
  at: integer('at').notNull(),
}, (t) => ({
  byChannel: index('idx_aegis_dm_chats_channel').on(t.channelId),
}));

/* ---------- Phase 8: reports, stats and social features ---------- */

/* A member's activity in a group: messages, points (levels come from points), thanks, daily streak. */
export const memberStats = table('aegis_member_stats', {
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  messages: integer('messages').notNull().default(0),
  points: integer('points').notNull().default(0),
  thanksGot: integer('thanks_got').notNull().default(0),
  thanksGiven: integer('thanks_given').notNull().default(0),
  streak: integer('streak').notNull().default(0), /* days in a row with a message */
  lastDay: integer('last_day').notNull().default(0), /* days since 1970 (UTC) */
  firstAt: integer('first_at').notNull().default(0),
  lastAt: integer('last_at').notNull().default(0),
  pointAt: integer('point_at').notNull().default(0), /* the last message that earned points */
  thankAt: integer('thank_at').notNull().default(0), /* the last thanks this member gave */
}, (t) => ({
  key: uniqueIndex('idx_aegis_member_stats_key').on(t.chatId, t.userId),
  byPoints: index('idx_aegis_member_stats_points').on(t.chatId, t.points),
  byMessages: index('idx_aegis_member_stats_messages').on(t.chatId, t.messages),
}));

/* A group's activity per day. active = members who wrote that day. */
export const statsDay = table('aegis_stats_day', {
  chatId: integer('chat_id').notNull(),
  day: integer('day').notNull(),
  messages: integer('messages').notNull().default(0),
  media: integer('media').notNull().default(0),
  active: integer('active').notNull().default(0),
  joins: integer('joins').notNull().default(0),
  leaves: integer('leaves').notNull().default(0),
}, (t) => ({
  key: uniqueIndex('idx_aegis_stats_day_key').on(t.chatId, t.day),
}));

/* Messages per hour of the day (in the chat's time zone), all time: the busiest hours. */
export const statsHour = table('aegis_stats_hour', {
  chatId: integer('chat_id').notNull(),
  hour: integer('hour').notNull(),
  messages: integer('messages').notNull().default(0),
}, (t) => ({
  key: uniqueIndex('idx_aegis_stats_hour_key').on(t.chatId, t.hour),
}));

/* Badges members earned (automatic codes) or were given by admins (custom: code c<def id>). */
export const badges = table('aegis_badges', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  code: text('code').notNull(),
  givenBy: integer('given_by').notNull().default(0),
  at: integer('at').notNull(),
}, (t) => ({
  key: uniqueIndex('idx_aegis_badges_key').on(t.chatId, t.userId, t.code),
}));

/* A group's own badges, made by its admins. */
export const badgeDefs = table('aegis_badge_defs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  emoji: text('emoji').notNull(),
  name: text('name').notNull(),
  createdBy: integer('created_by').notNull().default(0),
  at: integer('at').notNull(),
}, (t) => ({
  byChat: index('idx_aegis_badge_defs_chat').on(t.chatId),
}));

/* Contests: a raffle (members join with a button), the most active members, or a quiz (first right answer). */
export const contests = table('aegis_contests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  kind: text('kind').notNull(), /* raffle, activity, quiz */
  title: text('title').notNull(),
  winners: integer('winners').notNull().default(1),
  endsAt: integer('ends_at').notNull(),
  status: text('status').notNull().default('draft'), /* draft, running, ended, cancelled */
  msgId: integer('msg_id').notNull().default(0),
  question: text('question'),
  answer: text('answer'),
  result: text('result'), /* JSON: winner ids */
  createdBy: integer('created_by').notNull().default(0),
  at: integer('at').notNull(),
  endedAt: integer('ended_at').notNull().default(0),
}, (t) => ({
  byChat: index('idx_aegis_contests_chat').on(t.chatId, t.status, t.at),
  due: index('idx_aegis_contests_due').on(t.endsAt).where(sql`status = 'running'`),
}));

/* Who takes part in a contest, and how much (messages for an activity contest). */
export const contestEntries = table('aegis_contest_entries', {
  contestId: integer('contest_id').notNull(),
  userId: integer('user_id').notNull(),
  n: integer('n').notNull().default(0),
  at: integer('at').notNull(),
}, (t) => ({
  key: uniqueIndex('idx_aegis_contest_entries_key').on(t.contestId, t.userId),
  byCount: index('idx_aegis_contest_entries_count').on(t.contestId, t.n),
}));

/* Polls Aegis sent (Telegram's native polls) and their results. */
export const polls = table('aegis_polls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  msgId: integer('msg_id').notNull().default(0),
  pollId: text('poll_id'),
  question: text('question').notNull(),
  options: text('options').notNull(), /* JSON list of texts */
  counts: text('counts'), /* JSON list of vote counts */
  total: integer('total').notNull().default(0),
  anonymous: integer('anonymous').notNull().default(1),
  multiple: integer('multiple').notNull().default(0),
  correct: integer('correct').notNull().default(-1), /* a quiz's right option, -1 = a normal poll */
  closesAt: integer('closes_at').notNull().default(0),
  status: text('status').notNull().default('open'), /* open, closed */
  createdBy: integer('created_by').notNull().default(0),
  at: integer('at').notNull(),
}, (t) => ({
  byChat: index('idx_aegis_polls_chat').on(t.chatId, t.at),
  byPoll: uniqueIndex('idx_aegis_polls_poll').on(t.pollId),
  closing: index('idx_aegis_polls_closing').on(t.closesAt).where(sql`status = 'open' AND closes_at > 0`),
}));

/* Votes in polls that aren't anonymous (poll_answer). */
export const pollVotes = table('aegis_poll_votes', {
  pollId: integer('poll_id').notNull(),
  userId: integer('user_id').notNull(),
  options: text('options').notNull(), /* JSON list of option indexes */
  at: integer('at').notNull(),
}, (t) => ({
  key: uniqueIndex('idx_aegis_poll_votes_key').on(t.pollId, t.userId),
}));

/* Members' private questions to the admins, and anonymous questions (anon = 1) moderated before posting. */
export const questions = table('aegis_questions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  anon: integer('anon').notNull().default(0),
  text: text('text').notNull(),
  status: text('status').notNull().default('open'), /* open, answered, published, rejected, closed */
  answer: text('answer'),
  answeredBy: integer('answered_by').notNull().default(0),
  answeredAt: integer('answered_at').notNull().default(0),
  msgId: integer('msg_id').notNull().default(0), /* the published message */
  at: integer('at').notNull(),
}, (t) => ({
  byChat: index('idx_aegis_questions_chat').on(t.chatId, t.status, t.at),
  byUser: index('idx_aegis_questions_user').on(t.chatId, t.userId, t.at),
}));

/* Senders an admin blocked from asking anonymous questions in a chat (their identity stays hidden). */
export const qaBlocks = table('aegis_qa_blocks', {
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  byId: integer('by_id').notNull(),
  at: integer('at').notNull(),
}, (t) => ({
  key: uniqueIndex('idx_aegis_qa_blocks_key').on(t.chatId, t.userId),
}));

/* A punished member's appeal, one per punishment. */
export const appeals = table('aegis_appeals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  punishId: integer('punish_id').notNull(),
  userId: integer('user_id').notNull(),
  text: text('text').notNull(),
  status: text('status').notNull().default('open'), /* open, accepted, rejected */
  decidedBy: integer('decided_by').notNull().default(0),
  decidedAt: integer('decided_at').notNull().default(0),
  at: integer('at').notNull(),
}, (t) => ({
  byPunish: uniqueIndex('idx_aegis_appeals_punish').on(t.punishId),
  byChat: index('idx_aegis_appeals_chat').on(t.chatId, t.status, t.at),
}));

/* A senior admin's review of a moderation decision: upheld or overturned. */
export const reviews = table('aegis_reviews', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  punishId: integer('punish_id').notNull(),
  byId: integer('by_id').notNull(),
  verdict: text('verdict').notNull(), /* upheld, overturned */
  at: integer('at').notNull(),
}, (t) => ({
  byPunish: uniqueIndex('idx_aegis_reviews_punish').on(t.punishId),
  byChat: index('idx_aegis_reviews_chat').on(t.chatId, t.at),
}));
