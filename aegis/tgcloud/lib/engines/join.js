/*
 * Forced join. In the bot's private chat a user must be a member of every channel in
 * aegis_join_channels before anything else works (the language picker and the re-check stay
 * available). The owner is exempt. In groups ordinary members are never blocked by this; later
 * phases call status() only for the configuration flow.
 *
 * - Membership: getChatMember → creator/administrator/member, or restricted with is_member.
 * - A passed check is cached on the user's row for JOIN_CACHE_SEC, for the current join_rev only
 *   (every change to the list bumps join_rev). A failed check is never cached.
 * - A channel whose check fails for a channel-side reason (the bot isn't an admin there, the
 *   channel is gone, any other Telegram error) is skipped so one broken channel can't lock everyone
 *   out; it is marked bot_admin = 0 and the owner is warned at most once per JOIN_WARN_INTERVAL_SEC.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { DEFAULT_JOIN_CHANNELS, JOIN_CACHE_SEC, JOIN_WARN_INTERVAL_SEC, MAX_JOIN_CHANNELS, OWNER_ID } from '../config.js';
import * as kv from '../core/kv.js';
import { call, describeError, isApiError, send } from '../core/tg.js';
import { esc, iso, nowSec } from '../core/util.js';
import { t } from '../i18n/index.js';
import * as users from './users.js';

export const channelRef = (ch) => (ch.chat_id ? Number(ch.chat_id) : `@${ch.username}`);
export const channelUrl = (ch) => (ch.username ? `https://t.me/${ch.username}` : (ch.invite_link || null));
export const channelTitle = (ch) => ch.title || (ch.username ? `@${ch.username}` : String(ch.chat_id));

export function isMember(m) {
  if (!m) return false;
  if (m.status === 'creator' || m.status === 'administrator' || m.status === 'member') return true;
  return m.status === 'restricted' && m.is_member === true;
}

/* Errors about the user, not the channel: they mean "not a member". */
const USER_ERROR = /user not found|participant_id_invalid|user_id_invalid|user_not_participant|member not found/i;

export const enabled = (s) => s.join_enabled !== '0';

export async function list() {
  return db.all(sql`SELECT * FROM aegis_join_channels ORDER BY position, id LIMIT ${MAX_JOIN_CHANNELS + 5}`);
}

export async function get(id) {
  return db.get(sql`SELECT * FROM aegis_join_channels WHERE id = ${id}`);
}

export async function count() {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_join_channels`)).n);
}

export async function bumpRev(ctx) {
  return kv.incr(ctx, 'join_rev');
}

/* Data migration 1: the default channels, once. */
export async function seedDefaults() {
  let pos = 0;
  for (const username of DEFAULT_JOIN_CHANNELS) {
    pos += 1;
    await db.run(sql`INSERT INTO aegis_join_channels (uname, username, position, created_at)
      VALUES (${username.toLowerCase()}, ${username}, ${pos}, ${nowSec()}) ON CONFLICT(uname) DO NOTHING`);
  }
}

async function checkOne(ctx, ch, userId) {
  try {
    const m = await call(ctx, 'getChatMember', { chat_id: channelRef(ch), user_id: userId }, 'join-check');
    return isMember(m) ? 'joined' : 'missing';
  } catch (err) {
    if (isApiError(err) && err.code === 400 && USER_ERROR.test(err.description)) return 'missing';
    ch.error = describeError(err);
    return 'skipped';
  }
}

async function warnOwner(ctx, ch) {
  const now = nowSec();
  await db.run(sql`UPDATE aegis_join_channels SET bot_admin = 0, last_error = ${ch.error || null}, checked_at = ${now} WHERE id = ${ch.id}`);
  const owner = await users.get(OWNER_ID);
  if (!owner || !Number(owner.started) || Number(owner.blocked)) return; /* warn once the owner can be messaged */
  const claimed = await db.run(sql`UPDATE aegis_join_channels SET warned_at = ${now} WHERE id = ${ch.id} AND warned_at <= ${now - JOIN_WARN_INTERVAL_SEC}`);
  if (!claimed.rowsAffected) return;
  await send(ctx, OWNER_ID, t(owner.lang, 'join.owner_warn', { title: iso(channelTitle(ch)), error: esc(ch.error || '') }), null, 'join-warn');
}

/*
 * { ok: true } or { ok: false, missing: [{ title, url }] }. force: skip the cache (the
 * "✅ I joined" button).
 */
export async function status(ctx, userId, { force = false } = {}) {
  if (userId === OWNER_ID) return { ok: true };
  const s = await kv.all(ctx);
  if (!enabled(s)) return { ok: true };
  const rev = Number(s.join_rev || 0);
  const now = nowSec();
  if (!force) {
    const u = await users.get(userId);
    if (u && Number(u.join_ok_at) > now - JOIN_CACHE_SEC && Number(u.join_rev) === rev) return { ok: true };
  }
  const chans = await list();
  if (!chans.length) return { ok: true };
  const results = await Promise.all(chans.map((ch) => checkOne(ctx, ch, userId)));
  const missing = [];
  for (let i = 0; i < chans.length; i += 1) {
    if (results[i] === 'skipped') await warnOwner(ctx, chans[i]);
    else if (results[i] === 'missing') missing.push({ title: channelTitle(chans[i]), url: channelUrl(chans[i]) });
  }
  if (!missing.length) {
    await users.setJoinOk(userId, now, rev);
    return { ok: true };
  }
  return { ok: false, missing };
}

/*
 * Checks whether the bot is an admin in `ch` and refreshes what we know about the channel
 * (chat id, title, username). Gives { admin, error }.
 */
export async function refreshChannel(ctx, ch, botId) {
  const now = nowSec();
  let admin = false;
  let error = null;
  try {
    const chat = await call(ctx, 'getChat', { chat_id: channelRef(ch) }, 'join-chat');
    ch.chat_id = chat.id;
    ch.title = chat.title || ch.title;
    if (chat.username) ch.username = chat.username;
    const m = await call(ctx, 'getChatMember', { chat_id: chat.id, user_id: botId }, 'join-bot-admin');
    admin = m.status === 'administrator' || m.status === 'creator';
    if (!admin) error = 'not admin';
  } catch (err) {
    error = describeError(err);
  }
  await db.run(sql`UPDATE aegis_join_channels SET chat_id = ${ch.chat_id || null}, title = ${ch.title || null}, username = ${ch.username || null},
    bot_admin = ${admin ? 1 : 0}, checked_at = ${now}, last_error = ${error} WHERE id = ${ch.id}`);
  ch.bot_admin = admin ? 1 : 0;
  ch.last_error = error;
  return { admin, error };
}

export async function findDuplicate(chatId, username) {
  const uname = username ? username.toLowerCase() : null;
  return db.get(sql`SELECT * FROM aegis_join_channels WHERE chat_id = ${chatId} OR (uname IS NOT NULL AND uname = ${uname}) LIMIT 1`);
}

export async function add({ chatId, username, title, inviteLink, botAdmin }) {
  const last = await db.get(sql`SELECT COALESCE(MAX(position), 0) AS p FROM aegis_join_channels`);
  const r = await db.run(sql`INSERT INTO aegis_join_channels (chat_id, uname, username, title, invite_link, position, bot_admin, checked_at, created_at)
    VALUES (${chatId}, ${username ? username.toLowerCase() : null}, ${username || null}, ${title || null}, ${inviteLink || null},
      ${Number(last.p) + 1}, ${botAdmin ? 1 : 0}, ${nowSec()}, ${nowSec()})
    ON CONFLICT(uname) DO NOTHING RETURNING id`);
  return r.rows.length ? Number(r.rows[0].id) : null;
}

export async function remove(id) {
  await db.run(sql`DELETE FROM aegis_join_channels WHERE id = ${id}`);
}

/* Swaps the channel with its neighbour (dir -1 up, +1 down). False at either end. */
export async function move(id, dir) {
  const chans = await list();
  const i = chans.findIndex((c) => Number(c.id) === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= chans.length) return false;
  chans.forEach((c, k) => { c.position = k + 1; });
  const a = chans[i];
  const b = chans[j];
  [a.position, b.position] = [b.position, a.position];
  for (const c of chans) await db.run(sql`UPDATE aegis_join_channels SET position = ${c.position} WHERE id = ${c.id}`);
  return true;
}
