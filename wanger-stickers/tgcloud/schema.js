// Wanger Stickers database schema (Phase 1). Brief §11 plus docs/DECISIONS.md D11/D13.
// No foreign keys (the platform forbids them): parent ids are plain columns, integrity is kept in
// code. Timestamps are unix seconds. Every lookup column has an index; every query is LIMITed.
// Phase 2+ tables (jobs, uploads, upload_chunks, job_chunks, payments, gallery) come with their phase.
import { table, integer, text, real, index, uniqueIndex, primaryKey, sql } from 'sdk/db';

export const users = table('users', {
  tg_id: integer('tg_id').primaryKey(),
  first_name: text('first_name'),
  username: text('username'),
  lang: text('lang'), // null until the user picked a language
  lang_code: text('lang_code'), // Telegram's language_code at the last contact
  joined_at: integer('joined_at').notNull().default(0),
  last_active_at: integer('last_active_at').notNull().default(0),
  blocked_bot: integer('blocked_bot').notNull().default(0),
  banned: integer('banned').notNull().default(0),
  ban_reason: text('ban_reason'),
  ban_scope: text('ban_scope'), // 'bot' | 'ecosystem'
  plan: text('plan').notNull().default('free'),
  plan_until: integer('plan_until').notNull().default(0),
  points: integer('points').notNull().default(0),
  wanger_id: text('wanger_id'),
  referrer_id: integer('referrer_id'),
  pack_counter: integer('pack_counter').notNull().default(0), // n in ws_<id>_<n>_by_<bot>, never reused
  publish_banned: integer('publish_banned').notNull().default(0),
}, (t) => ({
  activeIdx: index('idx_users_active').on(t.last_active_at),
  joinedIdx: index('idx_users_joined').on(t.joined_at),
  usernameIdx: index('idx_users_username').on(sql`lower(username)`),
}));

export const usage_daily = table('usage_daily', {
  tg_id: integer('tg_id').notNull(),
  day: integer('day').notNull(), // YYYYMMDD (Tehran)
  feature: text('feature').notNull(),
  count: integer('count').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.tg_id, t.day, t.feature] }),
  dayIdx: index('idx_usage_day').on(t.day),
})).withoutRowid();

export const channels = table('channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chat_id: integer('chat_id').notNull().unique(),
  username: text('username'),
  title: text('title'),
  invite_link: text('invite_link'),
  position: integer('position').notNull().default(0),
  enabled: integer('enabled').notNull().default(1),
  added_at: integer('added_at').notNull().default(0),
  health: text('health').notNull().default('ok'), // ok | bot_not_admin | not_found | error
  checked_at: integer('checked_at').notNull().default(0),
}, (t) => ({
  posIdx: index('idx_channels_pos').on(t.position, t.id),
}));

export const membership_cache = table('membership_cache', {
  tg_id: integer('tg_id').primaryKey(),
  ok_until: integer('ok_until').notNull().default(0),
  version: integer('version').notNull().default(0), // gate list version when the pass was granted
}, (t) => ({
  untilIdx: index('idx_membership_until').on(t.ok_until),
}));

export const user_state = table('user_state', {
  tg_id: integer('tg_id').primaryKey(),
  step: text('step').notNull(),
  payload: text('payload'), // JSON
  expires_at: integer('expires_at').notNull(),
}, (t) => ({
  expIdx: index('idx_state_expires').on(t.expires_at),
}));

export const pending_actions = table('pending_actions', {
  tg_id: integer('tg_id').primaryKey(),
  action: text('action').notNull(), // JSON: { kind: 'message'|'callback'|'start', … }
  expires_at: integer('expires_at').notNull(),
}, (t) => ({
  expIdx: index('idx_pending_expires').on(t.expires_at),
}));

export const packs = table('packs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tg_id: integer('tg_id').notNull(),
  platform: text('platform').notNull().default('telegram'),
  tg_name: text('tg_name'),
  title: text('title').notNull(),
  kind: text('kind').notNull().default('mixed'),
  publisher: text('publisher'),
  wa_identifier: text('wa_identifier'),
  sticker_count: integer('sticker_count').notNull().default(0),
  is_public: integer('is_public').notNull().default(0),
  created_at: integer('created_at').notNull().default(0),
  updated_at: integer('updated_at').notNull().default(0),
}, (t) => ({
  userIdx: index('idx_packs_user').on(t.tg_id, t.id),
  nameIdx: uniqueIndex('uidx_packs_name').on(t.tg_name),
}));

export const pack_items = table('pack_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pack_id: integer('pack_id').notNull(),
  position: integer('position').notNull().default(0),
  file_id: text('file_id').notNull(),
  file_unique_id: text('file_unique_id').notNull(),
  format: text('format').notNull(), // static | video | animated
  emojis: text('emojis'), // JSON array
  keywords: text('keywords'), // JSON array
  origin: text('origin').notNull().default('made'), // made | import | copy (D11: shown to reviewers)
}, (t) => ({
  packPosIdx: index('idx_items_pack').on(t.pack_id, t.position),
  uniq: uniqueIndex('uidx_items_pack_fuid').on(t.pack_id, t.file_unique_id),
}));

/** D11: publishing a pack to the community channel (manual approval by owner or reviewers). */
export const pack_posts = table('pack_posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pack_id: integer('pack_id').notNull(),
  tg_id: integer('tg_id').notNull(),
  chat_id: integer('chat_id'), // destination channel at approval time
  status: text('status').notNull(), // pending | approved | posting | published | rejected | withdrawn | removed | failed
  show_name: integer('show_name').notNull().default(0),
  show_username: integer('show_username').notNull().default(0),
  message_id: integer('message_id'),
  reason: text('reason'),
  requested_at: integer('requested_at').notNull(),
  decided_at: integer('decided_at'),
  decided_by: integer('decided_by'),
  published_at: integer('published_at'),
  removed_at: integer('removed_at'),
  lease_until: integer('lease_until'),
  review_msgs: text('review_msgs'), // JSON [[chat_id, message_id], …] — review cards to update
}, (t) => ({
  statusIdx: index('idx_posts_status').on(t.status, t.id),
  userIdx: index('idx_posts_user').on(t.tg_id, t.requested_at),
  packIdx: index('idx_posts_pack').on(t.pack_id, t.id),
}));

/** Reviewers the owner added (Kimi's request 2026-11-12). The owner is never stored here. */
export const staff = table('staff', {
  tg_id: integer('tg_id').primaryKey(),
  role: text('role').notNull(), // reviewer
  added_by: integer('added_by').notNull(),
  added_at: integer('added_at').notNull(),
});

/** Bulk pack operations that take several invocations (copy, merge, duplicate, import). */
export const pack_ops = table('pack_ops', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tg_id: integer('tg_id').notNull(),
  kind: text('kind').notNull(), // copy | import | duplicate | merge
  src: text('src'), // source set name
  dst_pack_id: integer('dst_pack_id'),
  items: text('items'), // JSON [{file_id, file_unique_id, format, emojis, keywords}]
  cursor: integer('cursor').notNull().default(0),
  total: integer('total').notNull().default(0),
  done: integer('done').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  status: text('status').notNull(), // running | done | cancelled | failed
  title: text('title'), // title of the pack to create (duplicate / import into new)
  delete_src: integer('delete_src').notNull().default(0), // merge: delete the source pack afterwards
  progress_chat_id: integer('progress_chat_id'),
  progress_message_id: integer('progress_message_id'),
  lease_until: integer('lease_until'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
}, (t) => ({
  userIdx: index('idx_ops_user').on(t.tg_id, t.status),
  statusIdx: index('idx_ops_status').on(t.status, t.id),
}));

export const broadcasts = table('broadcasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  created_by: integer('created_by').notNull(),
  source_chat_id: integer('source_chat_id').notNull(),
  source_message_id: integer('source_message_id').notNull(),
  mode: text('mode').notNull().default('copy'), // copy | forward
  audience: text('audience').notNull().default('all'), // all | fa | en | active30 | pro
  status: text('status').notNull(), // draft | running | paused | done | cancelled
  cursor_tg_id: integer('cursor_tg_id').notNull().default(0),
  // the recipient being sent to right now; if an invocation dies mid-send this stays set and that
  // recipient is skipped as "uncertain" — never sent twice (brief §7: no one gets a message twice)
  inflight_tg_id: integer('inflight_tg_id'),
  uncertain: integer('uncertain').notNull().default(0),
  total: integer('total').notNull().default(0),
  sent: integer('sent').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  blocked: integer('blocked').notNull().default(0),
  created_at: integer('created_at').notNull(),
  started_at: integer('started_at'),
  finished_at: integer('finished_at'),
  progress_chat_id: integer('progress_chat_id'),
  progress_message_id: integer('progress_message_id'),
  lease_until: integer('lease_until'),
}, (t) => ({
  statusIdx: index('idx_broadcasts_status').on(t.status, t.id),
}));

export const settings = table('settings', {
  key: text('key').primaryKey(),
  value: text('value'), // JSON
  updated_at: integer('updated_at').notNull().default(0),
  updated_by: integer('updated_by').notNull().default(0),
});

export const secrets = table('secrets', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updated_at: integer('updated_at').notNull(),
});

export const rate_limits = table('rate_limits', {
  tg_id: integer('tg_id').notNull(),
  bucket: text('bucket').notNull(),
  tokens: real('tokens').notNull(),
  updated_at: integer('updated_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.tg_id, t.bucket] }),
  updatedIdx: index('idx_rate_updated').on(t.updated_at),
})).withoutRowid();

export const errors = table('errors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  tg_id: integer('tg_id'),
  scope: text('scope').notNull(), // handler / feature
  code: text('code').notNull(),
  message: text('message'),
});

export const stats_daily = table('stats_daily', {
  day: integer('day').notNull(),
  metric: text('metric').notNull(),
  value: integer('value').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.day, t.metric] }),
})).withoutRowid();

/** Update de-duplication (a webhook update may be delivered twice). */
export const processed_updates = table('processed_updates', {
  update_id: integer('update_id').primaryKey(),
  created_at: integer('created_at').notNull(),
}, (t) => ({
  createdIdx: index('idx_processed_created').on(t.created_at),
}));

/** Throttle for owner alerts: one row per alert key. */
export const alerts = table('alerts', {
  key: text('key').primaryKey(),
  last_sent_at: integer('last_sent_at').notNull(),
  count: integer('count').notNull().default(0),
});

/** Owner and reviewer actions (who changed what). */
export const audit_log = table('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  actor_id: integer('actor_id').notNull(),
  action: text('action').notNull(),
  target: text('target'),
  details: text('details'),
});
