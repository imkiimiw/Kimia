// Database tables of the mother bot. Deploy with `npx tgcloud push`, then create them with
// `npx tgcloud migrate --safe`. No foreign keys (the platform forbids them): rows that belong together
// share an id and the lib/ modules keep them consistent. Every query is served by an index below and
// LIMITed. Times are unix seconds; flags are 0/1 integers; JSON is kept in TEXT columns.
import { table, integer, text, index, uniqueIndex, sql } from 'sdk/db';

// Everyone who opened the mother bot (or was reported by a child bot and then opened it).
export const users = table('users', {
  userId: integer('user_id').primaryKey(),
  username: text('username'),
  usernameLc: text('username_lc'),
  firstName: text('first_name'),
  firstSeen: integer('first_seen').notNull().default(0),
  lastSeen: integer('last_seen').notNull().default(0),
  started: integer('started').notNull().default(0), // opened the private chat: the bot may write to them
  blocked: integer('blocked').notNull().default(0), // a message to them failed with 403
  role: integer('role').notNull().default(0), // 0 user, 1 team (support + moderation); the owner is in config
  state: text('state'), // what the next message is for (a flow step), NULL = free text → the assistant
  stateData: text('state_data'), // JSON for that step
  stateAt: integer('state_at').notNull().default(0),
  newsKinds: integer('news_kinds').notNull().default(15), // bitmask of news kinds they want (lib/news.js)
  club: integer('club').notNull().default(0), // customer club member
  clubSince: integer('club_since').notNull().default(0),
  points: integer('points').notNull().default(0),
  pointDay: integer('point_day').notNull().default(0), // last local day an activity point was given
  refBy: integer('ref_by').notNull().default(0), // who invited them (club referral), 0 = nobody
  refCount: integer('ref_count').notNull().default(0),
  warns: integer('warns').notNull().default(0),
  note: text('note'), // the team's note about this user
  msgWin: integer('msg_win').notNull().default(0), // anti-spam window start
  msgCount: integer('msg_count').notNull().default(0),
  mutedUntil: integer('muted_until').notNull().default(0),
  aiDay: integer('ai_day').notNull().default(0),
  aiCount: integer('ai_count').notNull().default(0),
}, (t) => ({
  byUsername: index('idx_users_username').on(t.usernameLc),
  reachable: index('idx_users_reachable').on(t.userId).where(sql`started = 1 AND blocked = 0`),
  clubbers: index('idx_users_club').on(t.userId).where(sql`club = 1 AND started = 1 AND blocked = 0`),
  team: index('idx_users_team').on(t.userId).where(sql`role > 0`),
}));

// Bot-wide values and counters (lib/store.js): hub_chat, log_chat, seeded, bc (running broadcast), ...
export const kv = table('kv', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// The catalog: every Wanger bot the mother knows about. `key` is the short id used everywhere (callback
// data, hub messages, the child's client config).
export const bots = table('bots', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  username: text('username'), // without @; empty = not public yet
  emoji: text('emoji'),
  category: text('category'), // lib/catalog.js CATEGORIES
  short: text('short'), // one line
  description: text('description'),
  features: text('features'), // JSON [{ t: title, h: how to use it, k: keywords }]
  faq: text('faq'), // JSON [{ q, a, k }]
  fixes: text('fixes'), // JSON [{ p: problem, s: what the user should do, k }]: user-side troubleshooting
  keywords: text('keywords'), // extra search words, space separated
  langs: text('langs'), // e.g. "فارسی، English"
  sort: integer('sort').notNull().default(100),
  hidden: integer('hidden').notNull().default(0), // 1 = only the team sees it (being built)
  addedAt: integer('added_at').notNull().default(0),
  // the child bot's token (owner-entered, never shown again) and what getMe said
  token: text('token'),
  tgId: integer('tg_id').notNull().default(0),
  // status set by the team: ok | degraded | maint | down
  status: text('status').notNull().default('ok'),
  statusNote: text('status_note'),
  statusAt: integer('status_at').notNull().default(0),
  statusUntil: integer('status_until').notNull().default(0), // 0 = until the team changes it
  // access restriction pushed to the child through the hub: off | slow | closed
  mode: text('mode').notNull().default('off'),
  modeMsg: text('mode_msg'),
  modeUntil: integer('mode_until').notNull().default(0),
  slowSec: integer('slow_sec').notNull().default(30),
  // automatic health (lib/health.js): ok | warn | bad | unknown
  health: text('health').notNull().default('unknown'),
  healthNote: text('health_note'),
  healthAt: integer('health_at').notNull().default(0), // last check
  healthAlert: text('health_alert'), // the state the team was last alerted about
  silenceMin: integer('silence_min').notNull().default(0), // alert when no hub event for this long (0 = off)
  lastEventAt: integer('last_event_at').notNull().default(0),
  errWin: integer('err_win').notNull().default(0), // start of the current error-counting window
  errCount: integer('err_count').notNull().default(0), // errors the child reported in that window
  version: text('version'),
  usersKnown: integer('users_known').notNull().default(0), // distinct users the hub told us about
  usersReported: integer('users_reported').notNull().default(0), // the child's own total (heartbeat)
  blockedKnown: integer('blocked_known').notNull().default(0),
  views: integer('views').notNull().default(0), // bot card opened in the mother
  cfgVer: integer('cfg_ver').notNull().default(0), // config version posted to the hub
  cfgAck: integer('cfg_ack').notNull().default(0), // the version the child said it applied
}, (t) => ({
  bySort: index('idx_bots_sort').on(t.sort, t.key),
  byTgId: index('idx_bots_tg').on(t.tgId),
}));

// One row per user and bot: activity reported by the child bot, card views and the news subscription.
// bot_key '*' is the "all Wanger news" subscription.
export const userBots = table('user_bots', {
  userId: integer('user_id').notNull(),
  botKey: text('bot_key').notNull(),
  uses: integer('uses').notNull().default(0),
  views: integer('views').notNull().default(0),
  firstAt: integer('first_at').notNull().default(0),
  lastAt: integer('last_at').notNull().default(0),
  lastDay: integer('last_day').notNull().default(0),
  blocked: integer('blocked').notNull().default(0), // the child bot can't write to them any more
  sub: integer('sub').notNull().default(0), // wants this bot's news
}, (t) => ({
  pk: uniqueIndex('uq_user_bots').on(t.userId, t.botKey),
  // broadcast through the child bot: its users in user_id order
  reach: index('idx_user_bots_reach').on(t.botKey, t.userId).where(sql`blocked = 0 AND uses > 0`),
  subs: index('idx_user_bots_subs').on(t.botKey, t.userId).where(sql`sub = 1`),
  top: index('idx_user_bots_top').on(t.userId, t.uses),
}));

// Per bot and local day: what the hub reported.
export const botDaily = table('bot_daily', {
  botKey: text('bot_key').notNull(),
  day: integer('day').notNull(), // YYYYMMDD, Tehran
  active: integer('active').notNull().default(0),
  newUsers: integer('new_users').notNull().default(0),
  uses: integer('uses').notNull().default(0),
  errors: integer('errors').notNull().default(0),
  reports: integer('reports').notNull().default(0),
  blocked: integer('blocked').notNull().default(0),
}, (t) => ({
  pk: uniqueIndex('uq_bot_daily').on(t.botKey, t.day),
}));

// Central forced-join channels: scope '*' = every bot (and the mother, if switched on), or one bot key.
export const channels = table('channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scope: text('scope').notNull(),
  chatId: integer('chat_id').notNull(),
  username: text('username'),
  title: text('title'),
  invite: text('invite'), // invite link for a private channel
  addedAt: integer('added_at').notNull().default(0),
}, (t) => ({
  byScope: index('idx_channels_scope').on(t.scope, t.id),
}));

// Error reports, questions for the team and reports about abusive users.
export const tickets = table('tickets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  botKey: text('bot_key'),
  kind: text('kind').notNull().default('report'), // report | question | abuse
  body: text('body'),
  fileId: text('file_id'),
  fileKind: text('file_kind'),
  verdict: text('verdict'), // bot | user | unclear | known | maint
  signals: text('signals'), // JSON: what the triage saw
  status: text('status').notNull().default('open'), // open | answered | user_side | resolved | closed
  incidentId: integer('incident_id').notNull().default(0),
  targetUser: integer('target_user').notNull().default(0), // abuse: the reported user
  createdAt: integer('created_at').notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(0),
}, (t) => ({
  byUser: index('idx_tickets_user').on(t.userId, t.id),
  byStatus: index('idx_tickets_status').on(t.status, t.id),
  byBot: index('idx_tickets_bot').on(t.botKey, t.createdAt),
  byTarget: index('idx_tickets_target').on(t.targetUser, t.id).where(sql`target_user > 0`),
}));

export const ticketMsgs = table('ticket_msgs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ticketId: integer('ticket_id').notNull(),
  fromTeam: integer('from_team').notNull().default(0),
  authorId: integer('author_id').notNull().default(0),
  body: text('body'),
  at: integer('at').notNull().default(0),
}, (t) => ({
  byTicket: index('idx_ticket_msgs').on(t.ticketId, t.id),
}));

// A confirmed problem with a bot. Users who reported it (or asked) are told when it is resolved.
export const incidents = table('incidents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  botKey: text('bot_key').notNull(),
  title: text('title'),
  status: text('status').notNull().default('open'), // open | resolved
  source: text('source'), // reports | health | manual | errors
  reports: integer('reports').notNull().default(0),
  startedAt: integer('started_at').notNull().default(0),
  resolvedAt: integer('resolved_at').notNull().default(0),
}, (t) => ({
  byBot: index('idx_incidents_bot').on(t.botKey, t.status, t.id),
  byStatus: index('idx_incidents_status').on(t.status, t.id),
}));

// Who wants to hear when a bot works again: kind 'inc' (an incident id) or 'bot' (maintenance end).
export const watchers = table('watchers', {
  kind: text('kind').notNull(),
  ref: text('ref').notNull(),
  userId: integer('user_id').notNull(),
  at: integer('at').notNull().default(0),
}, (t) => ({
  pk: uniqueIndex('uq_watchers').on(t.kind, t.ref, t.userId),
}));

// Errors the child bots reported, folded by signature.
export const errors = table('errors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  botKey: text('bot_key').notNull(),
  sig: text('sig').notNull(),
  body: text('body'),
  count: integer('count').notNull().default(0),
  firstAt: integer('first_at').notNull().default(0),
  lastAt: integer('last_at').notNull().default(0),
  alertedAt: integer('alerted_at').notNull().default(0),
}, (t) => ({
  pk: uniqueIndex('uq_errors').on(t.botKey, t.sig),
  recent: index('idx_errors_recent').on(t.botKey, t.lastAt),
  latest: index('idx_errors_latest').on(t.lastAt),
}));

// Abuse flags: from child bots (spam detection), from users (reports) and from the team.
export const abuse = table('abuse', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  botKey: text('bot_key'),
  source: text('source').notNull(), // bot | user | team
  reason: text('reason'),
  detail: text('detail'),
  reporterId: integer('reporter_id').notNull().default(0),
  at: integer('at').notNull().default(0),
  reviewed: integer('reviewed').notNull().default(0),
}, (t) => ({
  queue: index('idx_abuse_queue').on(t.id).where(sql`reviewed = 0`),
  byUser: index('idx_abuse_user').on(t.userId, t.id),
}));

// Bans: scope '*' = every bot and the mother, 'mother' = only the mother, or one bot key.
export const bans = table('bans', {
  userId: integer('user_id').notNull(),
  scope: text('scope').notNull(),
  until: integer('until').notNull().default(0), // 0 = permanent
  reason: text('reason'),
  byId: integer('by_id').notNull().default(0),
  at: integer('at').notNull().default(0),
}, (t) => ({
  pk: uniqueIndex('uq_bans').on(t.userId, t.scope),
  byScope: index('idx_bans_scope').on(t.scope, t.userId),
}));

// Queued sending: broadcasts, news, "it works again" notices and club offers (lib/broadcast.js).
export const broadcasts = table('broadcasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(), // broadcast | news | notice | club
  title: text('title'),
  status: text('status').notNull().default('draft'), // draft | running | done | stopped
  content: text('content'), // JSON, lib/broadcast.js
  audiences: text('audiences'), // JSON list of audience ids
  aidx: integer('aidx').notNull().default(0),
  cursor: integer('cursor').notNull().default(0),
  sent: integer('sent').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  blocked: integer('blocked').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  createdBy: integer('created_by').notNull().default(0),
  createdAt: integer('created_at').notNull().default(0),
  finishedAt: integer('finished_at').notNull().default(0),
  nextAt: integer('next_at').notNull().default(0),
  lockUntil: integer('lock_until').notNull().default(0),
  progressChat: integer('progress_chat').notNull().default(0),
  progressMsg: integer('progress_msg').notNull().default(0),
  progressAt: integer('progress_at').notNull().default(0),
}, (t) => ({
  running: index('idx_broadcasts_running').on(t.id).where(sql`status = 'running'`),
  byStatus: index('idx_broadcasts_status').on(t.status, t.id),
}));

// One row per user reached by a broadcast, so a user of several targeted bots gets it once.
export const bcSent = table('bc_sent', {
  bcId: integer('bc_id').notNull(),
  userId: integer('user_id').notNull(),
}, (t) => ({
  pk: uniqueIndex('uq_bc_sent').on(t.bcId, t.userId),
}));

// Customer club discount campaigns (lib/club.js).
export const campaigns = table('campaigns', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  code: text('code'), // the shared code; NULL for personal codes
  personal: integer('personal').notNull().default(1),
  pct: integer('pct').notNull().default(10),
  bots: text('bots'), // JSON list of bot keys, or '*'
  minLevel: integer('min_level').notNull().default(0),
  startsAt: integer('starts_at').notNull().default(0),
  endsAt: integer('ends_at').notNull().default(0),
  maxUses: integer('max_uses').notNull().default(0), // 0 = no limit (shared code)
  uses: integer('uses').notNull().default(0),
  claims: integer('claims').notNull().default(0),
  status: text('status').notNull().default('active'), // active | stopped
  monthly: text('monthly'), // Jalali year-month it was made for automatically, e.g. "1405-09"
  createdAt: integer('created_at').notNull().default(0),
}, (t) => ({
  byStatus: index('idx_campaigns_status').on(t.status, t.id),
  byMonth: uniqueIndex('uq_campaigns_month').on(t.monthly),
}));

export const codes = table('codes', {
  code: text('code').primaryKey(),
  campaignId: integer('campaign_id').notNull(),
  userId: integer('user_id').notNull().default(0), // 0 = the shared code of the campaign
  createdAt: integer('created_at').notNull().default(0),
  usedAt: integer('used_at').notNull().default(0),
  usedBot: text('used_bot'),
  amount: integer('amount').notNull().default(0),
}, (t) => ({
  byUser: index('idx_codes_user').on(t.userId, t.createdAt),
  claim: uniqueIndex('uq_codes_claim').on(t.campaignId, t.userId),
}));

// Who used which code (a shared code is used by many people, a personal one once).
export const redeems = table('redeems', {
  code: text('code').notNull(),
  userId: integer('user_id').notNull(),
  botKey: text('bot_key'),
  amount: integer('amount').notNull().default(0),
  at: integer('at').notNull().default(0),
}, (t) => ({
  pk: uniqueIndex('uq_redeems').on(t.code, t.userId),
}));
