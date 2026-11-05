// All database access. Every query on user data is filtered by user_id and served by a primary key
// or index (users.id, downloads idx_downloads_user, file_cache uq_file_cache, posts.id), every list
// is LIMITed, and the stats screen reads counters instead of counting tables — no update ever
// scans a whole table. Raw SQL rows come back unconverted: integers as numbers, flags as 0/1.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { DEFAULT_CHANNELS, HISTORY_KEEP, MAX_CHANNELS } from './config.js';
import { nowSec, today } from './text.js';

// SQLite's default limit is 999 bound variables per statement; a batch insert stays well under it.
const MAX_VARS = 900;

/** Inserts rows in chunks small enough for SQLite's variable limit. `columns` are trusted names. */
export async function insertChunked(tableName, columns, rows, { ignore = false } = {}) {
  if (!rows.length) return 0;
  const perChunk = Math.max(1, Math.floor(MAX_VARS / columns.length));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const values = chunk.map((row) => sql`(${joinValues(columns.map((c) => row[c]))})`);
    const r = await db.run(sql`INSERT ${sql.raw(ignore ? 'OR IGNORE ' : '')}INTO ${sql.raw(tableName)} (${sql.raw(columns.join(', '))}) VALUES ${joinSql(values)}`);
    inserted += r.rowsAffected;
  }
  return inserted;
}

function joinValues(values) {
  return joinSql(values.map((v) => sql`${v}`));
}

function joinSql(parts) {
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 1) out = sql`${out}, ${parts[i]}`;
  return out;
}

// ---------- counters & daily stats ----------

const DAILY_FIELDS = {
  downloads: 'downloads',
  cacheHits: 'cache_hits',
  newUsers: 'new_users',
  activeUsers: 'active_users',
  fxFail: 'fx_fail',
  vxFail: 'vx_fail',
  fallback: 'fallback',
};

/** Adds to today's numbers, e.g. bumpDaily({ downloads: 1, cacheHits: 1 }). */
export async function bumpDaily(fields, day = today()) {
  for (const [k, n] of Object.entries(fields)) {
    const col = DAILY_FIELDS[k];
    if (!col || !n) continue;
    await db.run(sql`
      INSERT INTO daily (day, ${sql.raw(col)}) VALUES (${day}, ${n})
      ON CONFLICT(day) DO UPDATE SET ${sql.raw(col)} = ${sql.raw(col)} + ${n}`);
  }
}

export async function bump(key, n = 1) {
  await db.run(sql`
    INSERT INTO counters (key, value) VALUES (${key}, ${n})
    ON CONFLICT(key) DO UPDATE SET value = max(0, value + ${n})`);
}

export async function getCounters() {
  const rows = await db.all(sql`
    SELECT key, value FROM counters WHERE key IN ('users_total', 'users_active', 'downloads_total')`);
  const out = { users_total: 0, users_active: 0, downloads_total: 0 };
  for (const r of rows) out[r.key] = Number(r.value || 0);
  return out;
}

function dailyRow(r, day) {
  return {
    day: r ? r.day : day,
    downloads: Number((r && r.downloads) || 0),
    cacheHits: Number((r && r.cache_hits) || 0),
    newUsers: Number((r && r.new_users) || 0),
    activeUsers: Number((r && r.active_users) || 0),
    fxFail: Number((r && r.fx_fail) || 0),
    vxFail: Number((r && r.vx_fail) || 0),
    fallback: Number((r && r.fallback) || 0),
  };
}

export async function getDaily(day = today()) {
  return dailyRow(await db.get(sql`SELECT * FROM daily WHERE day = ${day}`), day);
}

export async function recentDays(n) {
  const rows = await db.all(sql`SELECT * FROM daily ORDER BY day DESC LIMIT ${n}`);
  return rows.map((r) => dailyRow(r));
}

// ---------- users & state ----------

function userRow(r) {
  let data = {};
  if (r.data) {
    try {
      data = JSON.parse(r.data) || {};
    } catch {
      data = {};
    }
  }
  return {
    id: Number(r.id),
    firstName: r.first_name || '',
    username: r.username || null,
    firstSeen: Number(r.first_seen || 0),
    lastSeen: Number(r.last_seen || 0),
    active: Number(r.active) === 1,
    banned: Number(r.banned) === 1,
    quality: ['auto', 'best', 'low'].includes(r.quality) ? r.quality : 'auto',
    capText: Number(r.cap_text) !== 0,
    capAuthor: Number(r.cap_author) !== 0,
    capLink: Number(r.cap_link) !== 0,
    day: r.day || null,
    dayCount: Number(r.day_count || 0),
    total: Number(r.total || 0),
    seenDay: r.seen_day || null,
    state: r.state || null,
    stateData: data,
    stateAt: Number(r.state_at || 0),
  };
}

/** The user's row plus any pending state, in one query; null for someone new. */
export async function loadUser(userId) {
  const r = await db.get(sql`
    SELECT u.*, s.state, s.data, s.updated_at AS state_at
    FROM users u LEFT JOIN user_state s ON s.user_id = u.id
    WHERE u.id = ${userId}`);
  return r ? userRow(r) : null;
}

/** Records a new user (first message or /start). Returns the row. */
export async function createUser(from) {
  const now = nowSec();
  const day = today();
  const r = await db.run(sql`
    INSERT INTO users (id, first_name, username, first_seen, last_seen, active, seen_day)
    VALUES (${from.id}, ${from.first_name || null}, ${from.username || null}, ${now}, ${now}, 1, ${day})
    ON CONFLICT(id) DO NOTHING`);
  if (r.rowsAffected > 0) {
    await bump('users_total', 1);
    await bump('users_active', 1);
    await bumpDaily({ newUsers: 1, activeUsers: 1 }, day);
  }
  return loadUser(from.id);
}

/**
 * Bookkeeping for every update: last_seen, "active today", a blocked user coming back
 * (active again), and a pre-banned id that writes for the first time (now a real user).
 */
export async function touchUser(user, from) {
  const now = nowSec();
  const day = today();
  if (user.firstSeen === 0) {
    const r = await db.run(sql`
      UPDATE users SET first_seen = ${now}, last_seen = ${now}, seen_day = ${day}, active = 1,
        first_name = ${from.first_name || null}, username = ${from.username || null}
      WHERE id = ${user.id} AND first_seen = 0`);
    if (r.rowsAffected > 0) {
      await bump('users_total', 1);
      await bump('users_active', 1);
      await bumpDaily({ newUsers: 1, activeUsers: 1 }, day);
    }
    Object.assign(user, { firstSeen: now, lastSeen: now, seenDay: day, active: true });
    return;
  }
  if (!user.active) {
    const r = await db.run(sql`UPDATE users SET active = 1 WHERE id = ${user.id} AND active = 0`);
    if (r.rowsAffected > 0) await bump('users_active', 1);
    user.active = true;
  }
  if (user.seenDay !== day) {
    const r = await db.run(sql`
      UPDATE users SET seen_day = ${day}, last_seen = ${now},
        first_name = ${from.first_name || null}, username = ${from.username || null}
      WHERE id = ${user.id} AND (seen_day IS NULL OR seen_day <> ${day})`);
    if (r.rowsAffected > 0) await bumpDaily({ activeUsers: 1 }, day);
    user.seenDay = day;
  } else if (now - user.lastSeen >= 60) {
    await db.run(sql`UPDATE users SET last_seen = ${now} WHERE id = ${user.id}`);
  }
  user.lastSeen = now;
}

/** After a 403 from Telegram: the user blocked the bot. Never messaged again until they come back. */
export async function markInactive(userId) {
  const r = await db.run(sql`UPDATE users SET active = 0 WHERE id = ${userId} AND active = 1`);
  if (r.rowsAffected > 0) await bump('users_active', -1);
  return r.rowsAffected > 0;
}

export async function setQuality(userId, quality) {
  await db.run(sql`UPDATE users SET quality = ${quality} WHERE id = ${userId}`);
}

const CAPTION_COLUMNS = { t: 'cap_text', a: 'cap_author', l: 'cap_link' };

/** Flips one caption option; returns its new value (true = included). */
export async function toggleCaption(userId, which) {
  const col = CAPTION_COLUMNS[which];
  if (!col) return null;
  const r = await db.run(sql`
    UPDATE users SET ${sql.raw(col)} = 1 - ${sql.raw(col)} WHERE id = ${userId}
    RETURNING ${sql.raw(col)} AS v`);
  return r.rows.length ? Number(r.rows[0].v) === 1 : null;
}

/** Downloads left today (Infinity for unlimited). */
export function quotaLeft(user, limit, unlimited) {
  if (unlimited) return Infinity;
  const used = user.day === today() ? user.dayCount : 0;
  return Math.max(0, limit - used);
}

/**
 * Claims the user for one download job: refused while another job runs (busy) or within the
 * cooldown after the previous request. Atomic, so two quick messages can't both start.
 */
export async function acquireJob(userId, { cooldown, busy }) {
  const now = nowSec();
  const r = await db.run(sql`
    UPDATE users SET busy_until = ${now + busy}, last_req = ${now}
    WHERE id = ${userId} AND busy_until <= ${now} AND last_req <= ${now - cooldown}`);
  if (r.rowsAffected > 0) return { ok: true };
  const row = await db.get(sql`SELECT busy_until, last_req FROM users WHERE id = ${userId}`);
  if (row && Number(row.busy_until) > now) return { ok: false, why: 'busy' };
  const wait = row ? Math.max(1, Number(row.last_req) + cooldown - now) : cooldown;
  return { ok: false, why: 'cooldown', wait };
}

export async function releaseJob(userId) {
  await db.run(sql`UPDATE users SET busy_until = 0 WHERE id = ${userId}`);
}

/**
 * Counts one delivered post: history row (pruned to HISTORY_KEEP), the user's daily and total
 * counts, the bot-wide totals. Returns the user's count for today.
 */
export async function recordDownload(userId, { postId, author, kind, snippet, fromCache }) {
  const now = nowSec();
  const day = today();
  await db.run(sql`
    INSERT INTO downloads (user_id, post_id, author, kind, snippet, created_at)
    VALUES (${userId}, ${postId}, ${author || null}, ${kind}, ${snippet || null}, ${now})`);
  await db.run(sql`
    DELETE FROM downloads WHERE user_id = ${userId} AND id < (
      SELECT id FROM downloads WHERE user_id = ${userId} ORDER BY id DESC LIMIT 1 OFFSET ${HISTORY_KEEP - 1})`);
  const r = await db.run(sql`
    UPDATE users SET
      day_count = CASE WHEN day = ${day} THEN day_count + 1 ELSE 1 END,
      day = ${day},
      total = total + 1
    WHERE id = ${userId}
    RETURNING day_count`);
  await bump('downloads_total', 1);
  await bumpDaily(fromCache ? { downloads: 1, cacheHits: 1 } : { downloads: 1 }, day);
  return r.rows.length ? Number(r.rows[0].day_count) : 0;
}

export async function listDownloads(userId, limit) {
  const rows = await db.all(sql`
    SELECT id, post_id, author, kind, snippet, created_at FROM downloads
    WHERE user_id = ${userId} ORDER BY id DESC LIMIT ${limit}`);
  return rows.map((r) => ({
    id: Number(r.id),
    postId: String(r.post_id),
    author: r.author || null,
    kind: r.kind || '',
    snippet: r.snippet || '',
    createdAt: Number(r.created_at || 0),
  }));
}

/** One history row, only if it belongs to the user. */
export async function getDownload(userId, id) {
  const r = await db.get(sql`SELECT id, post_id, author FROM downloads WHERE id = ${id} AND user_id = ${userId}`);
  return r ? { id: Number(r.id), postId: String(r.post_id), author: r.author || null } : null;
}

export async function setState(userId, state, data = {}) {
  await db.run(sql`
    INSERT INTO user_state (user_id, state, data, updated_at)
    VALUES (${userId}, ${state}, ${JSON.stringify(data)}, ${nowSec()})
    ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`);
}

export async function clearState(userId) {
  await db.run(sql`DELETE FROM user_state WHERE user_id = ${userId}`);
}

// ---------- bans ----------

/** Bans an id. Someone who never used the bot gets a placeholder row (first_seen = 0). */
export async function banUser(userId) {
  const r = await db.run(sql`UPDATE users SET banned = 1 WHERE id = ${userId}`);
  if (r.rowsAffected > 0) return { known: true };
  await db.run(sql`
    INSERT INTO users (id, first_seen, last_seen, active, banned) VALUES (${userId}, 0, 0, 0, 1)
    ON CONFLICT(id) DO UPDATE SET banned = 1`);
  return { known: false };
}

export async function unbanUser(userId) {
  const r = await db.run(sql`UPDATE users SET banned = 0 WHERE id = ${userId} AND banned = 1`);
  return r.rowsAffected > 0;
}

/** Banned ids, newest id first (idx_users_banned is a partial index over banned rows only). */
export async function listBanned(limit) {
  const rows = await db.all(sql`
    SELECT id, first_name, username FROM users WHERE banned = 1 ORDER BY id DESC LIMIT ${limit}`);
  return rows.map((r) => ({ id: Number(r.id), firstName: r.first_name || '', username: r.username || null }));
}

// ---------- settings ----------

export async function getSettings() {
  const rows = await db.all(sql`SELECT key, value FROM settings WHERE key IN ('join', 'seeded')`);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setSetting(key, value) {
  await db.run(sql`
    INSERT INTO settings (key, value) VALUES (${key}, ${value})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
}

// ---------- channels ----------

function channelRow(r) {
  return {
    id: Number(r.id),
    username: r.username,
    chatId: r.chat_id === null || r.chat_id === undefined ? null : Number(r.chat_id),
    title: r.title || null,
    warnedAt: Number(r.warned_at || 0),
  };
}

/**
 * The mandatory channels. On the very first run (empty table, never seeded) the default channels
 * are inserted first. Once seeded, an empty list stays empty (the owner removed them all).
 */
export async function getChannels(settings) {
  const rows = await db.all(sql`SELECT * FROM channels ORDER BY id LIMIT ${MAX_CHANNELS + 5}`);
  if (rows.length || settings.seeded === '1') return rows.map(channelRow);
  const now = nowSec();
  await insertChunked('channels', ['uname', 'username', 'created_at'],
    DEFAULT_CHANNELS.map((u) => ({ uname: u.toLowerCase(), username: u, created_at: now })), { ignore: true });
  await setSetting('seeded', '1');
  settings.seeded = '1';
  const seeded = await db.all(sql`SELECT * FROM channels ORDER BY id LIMIT ${MAX_CHANNELS + 5}`);
  return seeded.map(channelRow);
}

export async function getChannel(id) {
  const r = await db.get(sql`SELECT * FROM channels WHERE id = ${id}`);
  return r ? channelRow(r) : null;
}

export async function findChannelByName(username) {
  const r = await db.get(sql`SELECT * FROM channels WHERE uname = ${username.toLowerCase()}`);
  return r ? channelRow(r) : null;
}

export async function countChannels() {
  const r = await db.get(sql`SELECT count(*) AS n FROM channels`);
  return Number((r && r.n) || 0);
}

/** Inserts a channel unless the list already has it or is full; false when nothing was added. */
export async function insertChannel({ username, chatId, title }) {
  const r = await db.run(sql`
    INSERT OR IGNORE INTO channels (uname, username, chat_id, title, created_at)
    SELECT ${username.toLowerCase()}, ${username}, ${chatId}, ${title || null}, ${nowSec()}
    WHERE (SELECT count(*) FROM channels) < ${MAX_CHANNELS}`);
  return r.rowsAffected > 0;
}

export async function deleteChannel(id) {
  const r = await db.run(sql`DELETE FROM channels WHERE id = ${id}`);
  return r.rowsAffected > 0;
}

/** Claims the right to warn the owner about a channel; false if someone did within `intervalSec`. */
export async function claimChannelWarning(id, intervalSec) {
  const now = nowSec();
  const r = await db.run(sql`
    UPDATE channels SET warned_at = ${now}
    WHERE id = ${id} AND warned_at <= ${now - intervalSec}`);
  return r.rowsAffected > 0;
}

// ---------- posts & file cache ----------

export async function getPost(id) {
  const r = await db.get(sql`SELECT * FROM posts WHERE id = ${id}`);
  if (!r) return null;
  let media = [];
  try {
    media = JSON.parse(r.media) || [];
  } catch {
    return null;
  }
  return {
    id: String(r.id),
    author: r.author || null,
    authorName: r.author_name || null,
    text: r.text || '',
    sensitive: Number(r.sensitive) === 1,
    fromQuote: Number(r.from_quote) === 1,
    media,
    source: r.source,
    fetchedAt: Number(r.fetched_at || 0),
  };
}

export async function savePost(post) {
  await db.run(sql`
    INSERT INTO posts (id, author, author_name, text, sensitive, from_quote, media, source, fetched_at)
    VALUES (${post.id}, ${post.author}, ${post.authorName}, ${post.text}, ${post.sensitive ? 1 : 0},
            ${post.fromQuote ? 1 : 0}, ${JSON.stringify(post.media)}, ${post.source}, ${nowSec()})
    ON CONFLICT(id) DO UPDATE SET author = excluded.author, author_name = excluded.author_name,
      text = excluded.text, sensitive = excluded.sensitive, from_quote = excluded.from_quote,
      media = excluded.media, source = excluded.source, fetched_at = excluded.fetched_at`);
}

/** Saves probed sizes back into the stored media list. */
export async function updatePostMedia(id, media) {
  await db.run(sql`UPDATE posts SET media = ${JSON.stringify(media)} WHERE id = ${id}`);
}

/** Every cached file of a post: Map "item:q" -> { fileId, kind, size }. */
export async function getCachedFiles(postId) {
  const rows = await db.all(sql`
    SELECT item, q, file_id, kind, size FROM file_cache WHERE post_id = ${postId} LIMIT 100`);
  const out = new Map();
  for (const r of rows) out.set(`${r.item}:${r.q}`, { fileId: r.file_id, kind: r.kind, size: Number(r.size || 0) });
  return out;
}

export async function putCachedFile(postId, item, q, { fileId, kind, size }) {
  await db.run(sql`
    INSERT INTO file_cache (post_id, item, q, file_id, kind, size, created_at)
    VALUES (${postId}, ${item}, ${q}, ${fileId}, ${kind}, ${size || null}, ${nowSec()})
    ON CONFLICT(post_id, item, q) DO UPDATE SET file_id = excluded.file_id, kind = excluded.kind, size = excluded.size`);
}

/** A cached file_id Telegram no longer accepts. */
export async function dropCachedFile(postId, item, q) {
  await db.run(sql`DELETE FROM file_cache WHERE post_id = ${postId} AND item = ${item} AND q = ${q}`);
}

// ---------- broadcasts ----------

function broadcastRow(r) {
  return {
    id: Number(r.id),
    fromChat: Number(r.from_chat),
    messageId: Number(r.message_id),
    status: r.status,
    total: Number(r.total || 0),
    cursor: Number(r.cursor || 0),
    sent: Number(r.sent || 0),
    failed: Number(r.failed || 0),
    blocked: Number(r.blocked || 0),
    progressChat: r.progress_chat === null || r.progress_chat === undefined ? null : Number(r.progress_chat),
    progressMsg: r.progress_msg === null || r.progress_msg === undefined ? null : Number(r.progress_msg),
    lockedUntil: Number(r.locked_until || 0),
    retryAt: Number(r.retry_at || 0),
    createdAt: Number(r.created_at || 0),
    startedAt: Number(r.started_at || 0),
    finishedAt: Number(r.finished_at || 0),
  };
}

export async function getBroadcast(id) {
  const r = await db.get(sql`SELECT * FROM broadcasts WHERE id = ${id}`);
  return r ? broadcastRow(r) : null;
}

/** The running broadcast, if any (at most one runs at a time). */
export async function runningBroadcast() {
  const r = await db.get(sql`SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id DESC LIMIT 1`);
  return r ? broadcastRow(r) : null;
}

/** Creates a draft (cancelling older drafts) and returns its id. */
export async function createBroadcast(fromChat, messageId) {
  await db.run(sql`UPDATE broadcasts SET status = 'stopped' WHERE status = 'draft'`);
  const r = await db.run(sql`
    INSERT INTO broadcasts (from_chat, message_id, status, created_at)
    VALUES (${fromChat}, ${messageId}, 'draft', ${nowSec()})
    RETURNING id`);
  return Number(r.rows[0].id);
}

/** draft -> running, only if no other broadcast is running. */
export async function startBroadcast(id, { total, progressChat, progressMsg }) {
  const r = await db.run(sql`
    UPDATE broadcasts SET status = 'running', total = ${total}, started_at = ${nowSec()},
      progress_chat = ${progressChat}, progress_msg = ${progressMsg}
    WHERE id = ${id} AND status = 'draft'
      AND NOT EXISTS (SELECT 1 FROM broadcasts WHERE status = 'running')`);
  return r.rowsAffected > 0;
}

export async function stopBroadcast(id) {
  const r = await db.run(sql`
    UPDATE broadcasts SET status = 'stopped', locked_until = 0, finished_at = ${nowSec()}
    WHERE id = ${id} AND status IN ('draft', 'running')`);
  return r.rowsAffected > 0;
}

/** Claims the next batch, so two updates can't send it twice; false while another batch is going out or after a 429. */
export async function lockBroadcast(id, seconds) {
  const now = nowSec();
  const r = await db.run(sql`
    UPDATE broadcasts SET locked_until = ${now + seconds}
    WHERE id = ${id} AND status = 'running' AND locked_until < ${now} AND retry_at <= ${now}`);
  return r.rowsAffected > 0;
}

export async function saveBroadcastProgress(id, { cursor, sent, failed, blocked, done, retryAt }) {
  const now = nowSec();
  await db.run(sql`
    UPDATE broadcasts
    SET cursor = ${cursor}, sent = ${sent}, failed = ${failed}, blocked = ${blocked}, locked_until = 0,
        retry_at = ${retryAt || 0},
        status = CASE WHEN ${done ? 1 : 0} = 1 AND status = 'running' THEN 'done' ELSE status END,
        finished_at = CASE WHEN ${done ? 1 : 0} = 1 AND status = 'running' THEN ${now} ELSE finished_at END
    WHERE id = ${id}`);
}

export async function setBroadcastProgressMessage(id, chatId, messageId) {
  await db.run(sql`UPDATE broadcasts SET progress_chat = ${chatId}, progress_msg = ${messageId} WHERE id = ${id}`);
}

/** Broadcast recipients after `afterId` in id order: reachable (not blocked), not banned, real users. */
export async function recipientsAfter(afterId, limit, excludeId) {
  const rows = await db.all(sql`
    SELECT id FROM users
    WHERE id > ${afterId} AND active = 1 AND banned = 0 AND first_seen > 0 AND id <> ${excludeId}
    ORDER BY id LIMIT ${limit}`);
  return rows.map((r) => Number(r.id));
}
