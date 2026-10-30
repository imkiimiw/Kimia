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
