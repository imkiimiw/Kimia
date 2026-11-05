// All database access. Every query is served by an index (see schema.js) and LIMITed, so no update
// reads a whole table; totals for the owner's stats are counters in kv, kept up to date on writes.
// Raw SQL rows come back unconverted: integers as numbers, 0/1 flags as numbers, JSON as text.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import {
  DEFAULT_CHANNELS, FILTERED_TTL_SEC, GC_BATCH, MAX_BLOCKS, MAX_CHANNELS, STATE_TTL_SEC,
} from './config.js';
import { detectLang } from './i18n.js';
import { localDay, nowSec, parseJson } from './util.js';

/** `a, b, c` as SQL parameters, for IN (...). */
export function list(values) {
  let acc = null;
  for (const v of values) acc = acc ? sql`${acc}, ${v}` : sql`${v}`;
  return acc;
}

export const num = (v) => Number(v || 0);

// ---------- kv: settings and counters ----------

export const KV_KEYS = ['join', 'chv', 'seeded', 'bot_id', 'bot_username', 'bc', 'gc_at', 'cmds'];

export async function getKv(keys = KV_KEYS) {
  const rows = await db.all(sql`SELECT key, value FROM kv WHERE key IN (${list(keys)})`);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** kv for an update; on the very first update ever, also seeds the default channels. */
export async function loadKv() {
  const kv = await getKv();
  if (kv.seeded !== '1') await getChannels(kv);
  return kv;
}

export async function setKv(key, value) {
  await db.run(sql`
    INSERT INTO kv (key, value) VALUES (${key}, ${value == null ? null : String(value)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
}

/** Adds `delta` to an integer counter (never below 0). */
export async function bump(key, delta = 1) {
  await db.run(sql`
    INSERT INTO kv (key, value) VALUES (${key}, ${String(Math.max(0, delta))})
    ON CONFLICT(key) DO UPDATE SET value = CAST(max(0, CAST(value AS INTEGER) + ${delta}) AS TEXT)`);
}

/** Counts one whisper for today (Tehran date); the counter restarts on a new day. */
async function bumpDay() {
  const day = localDay();
  await db.run(sql`
    INSERT INTO kv (key, value) VALUES ('day', ${`${day}:1`})
    ON CONFLICT(key) DO UPDATE SET value = CASE
      WHEN substr(value, 1, 8) = ${day} THEN ${`${day}:`} || (CAST(substr(value, 10) AS INTEGER) + 1)
      ELSE ${`${day}:1`} END`);
}

/** Takes a time-based turn (e.g. lazy cleanup) if the last one is older than `everySec`. */
export async function claimTurn(key, everySec) {
  const now = nowSec();
  const r = await db.run(sql`
    INSERT INTO kv (key, value) VALUES (${key}, ${String(now)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CAST(kv.value AS INTEGER) <= ${now - everySec}`);
  return r.rowsAffected > 0;
}

// ---------- users ----------

function toUser(r) {
  if (!r) return null;
  return {
    id: num(r.user_id),
    username: r.username || null,
    usernameLc: r.username_lc || null,
    firstName: r.first_name || '',
    firstSeen: num(r.first_seen),
    lastSeen: num(r.last_seen),
    active: num(r.active) === 1,
    started: num(r.started) === 1,
    banned: num(r.banned) === 1,
    receipts: num(r.receipts) === 1,
    defExpiry: num(r.def_expiry),
    recent: parseJson(r.recent, []),
    joinUntil: num(r.join_until),
    joinOk: num(r.join_ok) === 1,
    joinVer: num(r.join_ver),
    lang: r.lang || null,
    tgLang: r.tg_lang || null,
    anonCode: r.anon_code || null,
    anonOn: num(r.anon_on) === 1,
    anonCount: num(r.anon_count),
    anonUnread: num(r.anon_unread),
    inboxSize: num(r.inbox_size),
    aFilter: num(r.a_filter) === 1,
    aLinks: num(r.a_links) === 1,
    aText: num(r.a_text) === 1,
    aSilent: num(r.a_silent) === 1,
    qMode: num(r.q_mode),
    qText: r.q_text || null,
    pName: r.p_name || null,
    pBio: r.p_bio || null,
    pPhoto: r.p_photo || null,
    showRating: num(r.show_rating) === 1,
    ratingSum: num(r.rating_sum),
    ratingCount: num(r.rating_count),
    lastAnonAt: num(r.last_anon_at),
    strikes: num(r.strikes),
    strikeAt: num(r.strike_at),
    restrictedUntil: num(r.restricted_until),
  };
}

export const USER_COLS = sql`user_id, username, username_lc, first_name, first_seen, last_seen, active, started, banned,
  lang, tg_lang, receipts, def_expiry, recent, join_until, join_ok, join_ver, anon_code, anon_on, anon_count, anon_unread,
  inbox_size, a_filter, a_links, a_text, a_silent, q_mode, q_text, p_name, p_bio, p_photo, show_rating, rating_sum,
  rating_count, last_anon_at, strikes, strike_at, restricted_until`;
export { toUser };

export async function getUser(id) {
  return toUser(await db.get(sql`SELECT ${USER_COLS} FROM users WHERE user_id = ${Number(id)}`));
}

/** The user who currently has this username, as far as the bot has seen. */
export async function getUserByUsername(lc) {
  if (!lc) return null;
  return toUser(await db.get(sql`
    SELECT ${USER_COLS} FROM users WHERE username_lc = ${lc} ORDER BY last_seen DESC LIMIT 1`));
}

/**
 * Records a user from an update's `from` and returns their row. `started` = they wrote to the bot's
 * private chat (so the bot can message them). Writes only when something changed or once a minute.
 */
export async function touchUser(from, { started = false } = {}) {
  const id = Number(from.id);
  const username = from.username ? String(from.username) : null;
  const lc = username ? username.toLowerCase() : null;
  const name = String(from.first_name || '').slice(0, 64);
  const tgLang = from.language_code ? detectLang(from.language_code) : null;
  const now = nowSec();
  const u = await getUser(id);

  if (!u) {
    const r = await db.run(sql`
      INSERT INTO users (user_id, username, username_lc, first_name, tg_lang, first_seen, last_seen, active, started)
      VALUES (${id}, ${username}, ${lc}, ${name}, ${tgLang}, ${now}, ${now}, 1, ${started ? 1 : 0})
      ON CONFLICT(user_id) DO NOTHING`);
    if (r.rowsAffected > 0) {
      await bump('n_users', 1);
      if (started) await bump('n_active', 1);
      if (lc) await releaseUsername(lc, id);
    }
    return getUser(id);
  }

  if (u.firstSeen === 0) {
    // A placeholder (banned before they ever wrote): now they count as a user.
    const r = await db.run(sql`UPDATE users SET first_seen = ${now} WHERE user_id = ${id} AND first_seen = 0`);
    if (r.rowsAffected > 0) await bump('n_users', 1);
    u.firstSeen = now;
  }
  if (started && !(u.started && u.active)) {
    const r = await db.run(sql`
      UPDATE users SET started = 1, active = 1 WHERE user_id = ${id} AND NOT (started = 1 AND active = 1)`);
    if (r.rowsAffected > 0) await bump('n_active', 1);
    u.started = true;
    u.active = true;
  }
  if (u.username !== username || u.firstName !== name || (tgLang && u.tgLang !== tgLang) || now - u.lastSeen >= 60) {
    await db.run(sql`
      UPDATE users SET username = ${username}, username_lc = ${lc}, first_name = ${name}, last_seen = ${now},
        tg_lang = COALESCE(${tgLang}, tg_lang)
      WHERE user_id = ${id}`);
    if (tgLang) u.tgLang = tgLang;
    if (lc && u.usernameLc !== lc) await releaseUsername(lc, id);
    u.username = username;
    u.usernameLc = lc;
    u.firstName = name;
    u.lastSeen = now;
  }
  return u;
}

/** A username belongs to one account: forget it on anyone else the bot remembers with it. */
async function releaseUsername(lc, ownerId) {
  await db.run(sql`
    UPDATE users SET username = NULL, username_lc = NULL WHERE username_lc = ${lc} AND user_id != ${ownerId}`);
}

/** After a 403 (the user blocked the bot): stop messaging them until they write again. */
export async function markInactive(id) {
  const r = await db.run(sql`UPDATE users SET active = 0 WHERE user_id = ${Number(id)} AND active = 1 AND started = 1`);
  if (r.rowsAffected > 0) {
    await bump('n_active', -1);
    return;
  }
  await db.run(sql`UPDATE users SET active = 0 WHERE user_id = ${Number(id)} AND active = 1`);
}

export async function setLang(id, lang) {
  await db.run(sql`UPDATE users SET lang = ${lang} WHERE user_id = ${id}`);
}

// Per-user settings that are a single column; the name is checked against this list before it goes
// into the SQL text (values are always bound parameters).
const SETTING_COLUMNS = new Set(['anon_on', 'a_filter', 'a_links', 'a_text', 'a_silent', 'show_rating', 'q_mode', 'q_text',
  'p_name', 'p_bio', 'p_photo', 'receipts', 'def_expiry']);

export async function setUserField(id, column, value) {
  if (!SETTING_COLUMNS.has(column)) throw new Error(`not a settings column: ${column}`);
  await db.run(sql`UPDATE users SET ${sql.raw(column)} = ${value} WHERE user_id = ${id}`);
}

export async function setReceipts(id, on) {
  await db.run(sql`UPDATE users SET receipts = ${on ? 1 : 0} WHERE user_id = ${id}`);
}

export async function setDefExpiry(id, sec) {
  await db.run(sql`UPDATE users SET def_expiry = ${sec} WHERE user_id = ${id}`);
}

export async function setRecent(id, recent) {
  await db.run(sql`UPDATE users SET recent = ${JSON.stringify(recent)} WHERE user_id = ${id}`);
}

export async function setJoinCache(id, ok, until, ver) {
  await db.run(sql`
    UPDATE users SET join_ok = ${ok ? 1 : 0}, join_until = ${until}, join_ver = ${ver} WHERE user_id = ${id}`);
}

/** Bans or unbans by numeric id; a user the bot has never seen gets a placeholder row. */
export async function setBanned(id, banned) {
  const now = nowSec();
  await db.run(sql`
    INSERT INTO users (user_id, first_seen, last_seen, banned) VALUES (${id}, 0, ${now}, ${banned ? 1 : 0})
    ON CONFLICT(user_id) DO UPDATE SET banned = excluded.banned`);
}

// ---------- channels ----------

function toChannel(r) {
  return {
    id: num(r.id),
    uname: r.uname,
    username: r.username,
    chatId: r.chat_id == null ? null : Number(r.chat_id),
    title: r.title || r.username,
    warnedAt: num(r.warned_at),
  };
}

/** The forced-join channels. The first time, seeds the default ones if the table is empty. */
export async function getChannels(kv) {
  if (kv.seeded !== '1') {
    const any = await db.get(sql`SELECT id FROM channels LIMIT 1`);
    if (!any) {
      const now = nowSec();
      for (const name of DEFAULT_CHANNELS) {
        await db.run(sql`
          INSERT INTO channels (uname, username, created_at) VALUES (${name.toLowerCase()}, ${name}, ${now})
          ON CONFLICT(uname) DO NOTHING`);
      }
      await bumpChannelVersion(kv);
    }
    await setKv('seeded', '1');
    kv.seeded = '1';
  }
  const rows = await db.all(sql`
    SELECT id, uname, username, chat_id, title, warned_at FROM channels ORDER BY id LIMIT ${MAX_CHANNELS}`);
  return rows.map(toChannel);
}

export async function getChannel(id) {
  const r = await db.get(sql`SELECT id, uname, username, chat_id, title, warned_at FROM channels WHERE id = ${id}`);
  return r ? toChannel(r) : null;
}

/** Adds a channel unless there are already MAX_CHANNELS or it is a duplicate: 'ok' | 'full' | 'dup'. */
export async function addChannel({ username, chatId, title }) {
  const uname = username.toLowerCase();
  const dup = await db.get(sql`SELECT id FROM channels WHERE uname = ${uname}`);
  if (dup) return 'dup';
  const r = await db.run(sql`
    INSERT INTO channels (uname, username, chat_id, title, created_at)
    SELECT ${uname}, ${username}, ${chatId}, ${title}, ${nowSec()}
    WHERE (SELECT count(*) FROM channels) < ${MAX_CHANNELS}
    ON CONFLICT(uname) DO NOTHING`);
  return r.rowsAffected > 0 ? 'ok' : 'full';
}

export async function countChannels() {
  const r = await db.get(sql`SELECT count(*) AS n FROM channels`);
  return num(r && r.n);
}

export async function removeChannel(id) {
  return (await db.run(sql`DELETE FROM channels WHERE id = ${id}`)).rowsAffected > 0;
}

/** Forced-join caches are only valid for the channel list they were made with. */
export async function bumpChannelVersion(kv) {
  const next = num(kv && kv.chv) + 1;
  await setKv('chv', next);
  if (kv) kv.chv = String(next);
}

/** True if this call may warn the owner about the channel now (at most once per interval). */
export async function claimChannelWarning(id, intervalSec) {
  const now = nowSec();
  const r = await db.run(sql`
    UPDATE channels SET warned_at = ${now} WHERE id = ${id} AND warned_at <= ${now - intervalSec}`);
  return r.rowsAffected > 0;
}

// ---------- drafts ----------

function toDraft(r) {
  if (!r) return null;
  return { senderId: num(r.sender_id), id: r.id, q: r.q, data: parseJson(r.data, {}), updatedAt: num(r.updated_at) };
}

export async function getDraft(senderId) {
  return toDraft(await db.get(sql`SELECT sender_id, id, q, data, updated_at FROM drafts WHERE sender_id = ${senderId}`));
}

export async function getDraftById(id) {
  return toDraft(await db.get(sql`SELECT sender_id, id, q, data, updated_at FROM drafts WHERE id = ${id}`));
}

/** The sender's one draft row, overwritten in place. */
export async function saveDraft(senderId, id, q, data) {
  await db.run(sql`
    INSERT INTO drafts (sender_id, id, q, data, updated_at) VALUES (${senderId}, ${id}, ${q}, ${JSON.stringify(data)}, ${nowSec()})
    ON CONFLICT(sender_id) DO UPDATE SET id = excluded.id, q = excluded.q, data = excluded.data, updated_at = excluded.updated_at`);
}

export async function touchDraft(senderId) {
  await db.run(sql`UPDATE drafts SET updated_at = ${nowSec()} WHERE sender_id = ${senderId}`);
}

export async function deleteDraft(senderId, id) {
  await db.run(sql`DELETE FROM drafts WHERE sender_id = ${senderId} AND id = ${id}`);
}

// ---------- whispers ----------

function toWhisper(r) {
  if (!r) return null;
  return {
    id: r.id,
    senderId: num(r.sender_id),
    body: r.body == null ? null : String(r.body),
    once: num(r.once) === 1,
    expiresAt: num(r.expires_at),
    state: num(r.state),
    rcount: num(r.rcount),
    snoops: num(r.snoops),
    inlineId: r.inline_id || null,
    lang: r.lang || 'fa',
    createdAt: num(r.created_at),
  };
}

function toRcpt(r) {
  return {
    whisperId: r.whisper_id,
    slot: num(r.slot),
    rid: r.rid == null ? null : Number(r.rid),
    runame: r.runame || null,
    label: r.label,
    seenAt: num(r.seen_at),
    opens: num(r.opens),
  };
}

const W_COLS = sql`id, sender_id, body, once, expires_at, state, rcount, snoops, inline_id, lang, created_at`;

/**
 * Creates a whisper and its recipients. Idempotent: if the id exists (the update came twice, or a
 * button press finalized it first) nothing is created and false is returned.
 */
export async function createWhisper({ id, senderId, body, once, expiresAt, recipients, inlineId, lang = 'fa' }) {
  const now = nowSec();
  const r = await db.run(sql`
    INSERT INTO whispers (id, sender_id, body, once, expires_at, state, rcount, snoops, inline_id, lang, created_at)
    VALUES (${id}, ${senderId}, ${body}, ${once ? 1 : 0}, ${expiresAt}, 0, ${recipients.length}, 0, ${inlineId}, ${lang}, ${now})
    ON CONFLICT(id) DO NOTHING`);
  if (r.rowsAffected === 0) {
    if (inlineId) await setInlineId(id, inlineId);
    return false;
  }
  let values = null;
  recipients.forEach((rc, slot) => {
    const row = sql`(${id}, ${slot}, ${rc.rid}, ${rc.runame}, ${rc.label}, 0, ${senderId}, ${now})`;
    values = values ? sql`${values}, ${row}` : row;
  });
  await db.run(sql`
    INSERT INTO whisper_rcpts (whisper_id, slot, rid, runame, label, seen_at, sender_id, created_at) VALUES ${values}
    ON CONFLICT(whisper_id, slot) DO NOTHING`);
  await bump('n_whispers', 1);
  await bumpDay();
  return true;
}

export async function getWhisper(id) {
  return toWhisper(await db.get(sql`SELECT ${W_COLS} FROM whispers WHERE id = ${id}`));
}

export async function getRcpts(whisperId) {
  const rows = await db.all(sql`
    SELECT whisper_id, slot, rid, runame, label, seen_at, opens FROM whisper_rcpts WHERE whisper_id = ${whisperId}
    ORDER BY slot LIMIT 3`);
  return rows.map(toRcpt);
}

export async function setInlineId(id, inlineId) {
  await db.run(sql`UPDATE whispers SET inline_id = ${inlineId} WHERE id = ${id} AND inline_id IS NULL`);
}

/** A @username recipient opened it: from now on it is theirs by numeric id. */
export async function pinRecipient(whisperId, slot, rid) {
  await db.run(sql`UPDATE whisper_rcpts SET rid = ${rid} WHERE whisper_id = ${whisperId} AND slot = ${slot} AND rid IS NULL`);
}

/** Marks a recipient's first view. True only for the one call that did it (safe under concurrency). */
export async function markSeen(whisperId, slot) {
  const r = await db.run(sql`
    UPDATE whisper_rcpts SET seen_at = ${nowSec()} WHERE whisper_id = ${whisperId} AND slot = ${slot} AND seen_at = 0`);
  return r.rowsAffected > 0;
}

/** Counts one more opening by this recipient; returns the new count. */
export async function addOpen(whisperId, slot) {
  const r = await db.run(sql`
    UPDATE whisper_rcpts SET opens = opens + 1 WHERE whisper_id = ${whisperId} AND slot = ${slot} RETURNING opens`);
  return num(r.rows && r.rows[0] && r.rows[0].opens);
}

/** Deletes the content of a one-time whisper. True if this call burned it. */
export async function burnWhisper(id) {
  return (await db.run(sql`UPDATE whispers SET body = NULL, state = 1 WHERE id = ${id} AND state = 0`)).rowsAffected > 0;
}

/** Deletes the content of an expired whisper. True if this call expired it. */
export async function expireWhisper(id) {
  return (await db.run(sql`UPDATE whispers SET body = NULL, state = 2 WHERE id = ${id} AND state = 0`)).rowsAffected > 0;
}

/** Records a snooper once per whisper; returns the new count, or null if they were already counted. */
export async function addSnoop(whisperId, from) {
  const r = await db.run(sql`
    INSERT INTO snoops (whisper_id, user_id, username, first_name, at)
    VALUES (${whisperId}, ${Number(from.id)}, ${from.username || null}, ${String(from.first_name || '').slice(0, 64)}, ${nowSec()})
    ON CONFLICT(whisper_id, user_id) DO NOTHING`);
  if (r.rowsAffected === 0) return null;
  await db.run(sql`UPDATE whispers SET snoops = snoops + 1 WHERE id = ${whisperId}`);
  const w = await db.get(sql`SELECT snoops FROM whispers WHERE id = ${whisperId}`);
  return num(w && w.snoops);
}

export async function listSnoops(whisperId, limit = 30) {
  const rows = await db.all(sql`
    SELECT user_id, username, first_name, at FROM snoops WHERE whisper_id = ${whisperId} ORDER BY at LIMIT ${limit}`);
  return rows.map((r) => ({ id: num(r.user_id), username: r.username || null, firstName: r.first_name || '', at: num(r.at) }));
}

/** The user's last `limit` sent whispers, newest first. */
export async function sentHistory(senderId, limit) {
  const rows = await db.all(sql`
    SELECT ${W_COLS} FROM whispers WHERE sender_id = ${senderId} ORDER BY created_at DESC LIMIT ${limit}`);
  return rows.map(toWhisper);
}

/** The user's last `limit` received whispers (by id, or by a @username not yet claimed), newest first. */
export async function receivedHistory(user, limit) {
  const byId = await db.all(sql`
    SELECT whisper_id, slot, rid, runame, label, seen_at, opens, created_at FROM whisper_rcpts
    WHERE rid = ${user.id} ORDER BY created_at DESC LIMIT ${limit}`);
  const byName = user.usernameLc ? await db.all(sql`
    SELECT whisper_id, slot, rid, runame, label, seen_at, opens, created_at FROM whisper_rcpts
    WHERE runame = ${user.usernameLc} AND rid IS NULL ORDER BY created_at DESC LIMIT ${limit}`) : [];
  const seen = new Set();
  const slots = [...byId, ...byName]
    .sort((a, b) => num(b.created_at) - num(a.created_at))
    .filter((r) => (seen.has(r.whisper_id) ? false : seen.add(r.whisper_id)))
    .slice(0, limit);
  if (!slots.length) return [];
  const ws = await db.all(sql`SELECT ${W_COLS} FROM whispers WHERE id IN (${list(slots.map((s) => s.whisper_id))})`);
  const byWid = new Map(ws.map((w) => [w.id, toWhisper(w)]));
  const senders = await usersByIds([...new Set(ws.map((w) => num(w.sender_id)))]);
  return slots
    .filter((s) => byWid.has(s.whisper_id))
    .map((s) => ({ whisper: byWid.get(s.whisper_id), rcpt: toRcpt(s), sender: senders.get(num(byWid.get(s.whisper_id).senderId)) || null }));
}

/** Recipients of several whispers: Map whisperId → [rcpt]. */
export async function rcptsFor(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = await db.all(sql`
    SELECT whisper_id, slot, rid, runame, label, seen_at, opens FROM whisper_rcpts WHERE whisper_id IN (${list(ids)})
    ORDER BY whisper_id, slot LIMIT ${ids.length * 3}`);
  for (const r of rows) {
    if (!out.has(r.whisper_id)) out.set(r.whisper_id, []);
    out.get(r.whisper_id).push(toRcpt(r));
  }
  return out;
}

export async function usersByIds(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = await db.all(sql`SELECT ${USER_COLS} FROM users WHERE user_id IN (${list(ids)}) LIMIT ${ids.length}`);
  for (const r of rows) out.set(num(r.user_id), toUser(r));
  return out;
}

// ---------- blocks ----------

/** Which of `userIds` block `senderId`. */
export async function blockersOf(senderId, userIds) {
  if (!userIds.length) return [];
  const rows = await db.all(sql`
    SELECT user_id FROM blocks WHERE blocked_id = ${senderId} AND user_id IN (${list(userIds)}) LIMIT ${userIds.length}`);
  return rows.map((r) => num(r.user_id));
}

export async function isBlocked(userId, senderId) {
  return !!(await db.get(sql`SELECT user_id FROM blocks WHERE user_id = ${userId} AND blocked_id = ${senderId}`));
}

/** 'ok' | 'dup' | 'full' */
export async function addBlock(userId, blockedId) {
  if (await isBlocked(userId, blockedId)) return 'dup';
  const r = await db.run(sql`
    INSERT INTO blocks (user_id, blocked_id, created_at)
    SELECT ${userId}, ${blockedId}, ${nowSec()}
    WHERE (SELECT count(*) FROM (SELECT 1 FROM blocks WHERE user_id = ${userId} LIMIT ${MAX_BLOCKS})) < ${MAX_BLOCKS}
    ON CONFLICT(user_id, blocked_id) DO NOTHING`);
  return r.rowsAffected > 0 ? 'ok' : 'full';
}

export async function removeBlock(userId, blockedId) {
  return (await db.run(sql`DELETE FROM blocks WHERE user_id = ${userId} AND blocked_id = ${blockedId}`)).rowsAffected > 0;
}

export async function listBlocks(userId) {
  const rows = await db.all(sql`
    SELECT b.blocked_id, u.username, u.first_name FROM blocks b LEFT JOIN users u ON u.user_id = b.blocked_id
    WHERE b.user_id = ${userId} ORDER BY b.created_at DESC LIMIT ${MAX_BLOCKS}`);
  return rows.map((r) => ({ id: num(r.blocked_id), username: r.username || null, firstName: r.first_name || '' }));
}

// ---------- user_state ----------

/** The pending state, or null (a state older than STATE_TTL_SEC is dropped). */
export async function getState(userId) {
  const r = await db.get(sql`SELECT state, data, updated_at FROM user_state WHERE user_id = ${userId}`);
  if (!r) return null;
  if (nowSec() - num(r.updated_at) > STATE_TTL_SEC) {
    await clearState(userId);
    return null;
  }
  return { state: r.state, data: parseJson(r.data, {}) };
}

export async function setState(userId, state, data = {}) {
  await db.run(sql`
    INSERT INTO user_state (user_id, state, data, updated_at) VALUES (${userId}, ${state}, ${JSON.stringify(data)}, ${nowSec()})
    ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`);
}

export async function clearState(userId) {
  await db.run(sql`DELETE FROM user_state WHERE user_id = ${userId}`);
}

// ---------- lazy cleanup ----------

/** Deletes up to GC_BATCH each: unsent drafts older than `ttlSec`, stale states, old filtered messages. */
export async function gcBatch(draftTtlSec) {
  const now = nowSec();
  const d = await db.run(sql`
    DELETE FROM drafts WHERE sender_id IN (
      SELECT sender_id FROM drafts WHERE updated_at < ${now - draftTtlSec} ORDER BY updated_at LIMIT ${GC_BATCH})`);
  const s = await db.run(sql`
    DELETE FROM user_state WHERE user_id IN (
      SELECT user_id FROM user_state WHERE updated_at < ${now - STATE_TTL_SEC} ORDER BY updated_at LIMIT ${GC_BATCH})`);
  // The filtered folder (messages a filter hid) empties itself; inbox and archive stay until deleted.
  const old = await db.all(sql`
    SELECT id, to_id FROM anon_msgs WHERE folder = 2 AND created_at < ${now - FILTERED_TTL_SEC}
    ORDER BY created_at LIMIT ${GC_BATCH}`);
  let anon = 0;
  for (const m of old) {
    const r = await db.run(sql`DELETE FROM anon_msgs WHERE id = ${m.id} AND folder = 2`);
    if (r.rowsAffected) {
      anon += 1;
      await db.run(sql`UPDATE users SET inbox_size = max(0, inbox_size - 1) WHERE user_id = ${m.to_id}`);
    }
  }
  return { drafts: d.rowsAffected, states: s.rowsAffected, anon };
}

// ---------- broadcasts ----------

function toBroadcast(r) {
  if (!r) return null;
  return {
    id: num(r.id),
    fromChat: Number(r.from_chat),
    messageId: num(r.message_id),
    status: r.status,
    total: num(r.total),
    lastUser: num(r.last_user),
    sent: num(r.sent),
    failed: num(r.failed),
    blocked: num(r.blocked),
    nextAt: num(r.next_at),
    lockedUntil: num(r.locked_until),
    progressChat: r.progress_chat == null ? null : Number(r.progress_chat),
    progressMsg: r.progress_msg == null ? null : num(r.progress_msg),
    progressAt: num(r.progress_at),
    createdAt: num(r.created_at),
    finishedAt: num(r.finished_at),
  };
}

const BC_COLS = sql`id, from_chat, message_id, status, total, last_user, sent, failed, blocked, next_at, locked_until,
  progress_chat, progress_msg, progress_at, created_at, finished_at`;

export async function createBroadcast(fromChat, messageId) {
  const r = await db.run(sql`
    INSERT INTO broadcasts (from_chat, message_id, status, created_at) VALUES (${fromChat}, ${messageId}, 'draft', ${nowSec()})
    RETURNING id`);
  return num((r.rows && r.rows[0] && r.rows[0].id) || r.lastInsertRowid);
}

export async function getBroadcast(id) {
  return toBroadcast(await db.get(sql`SELECT ${BC_COLS} FROM broadcasts WHERE id = ${id}`));
}

export async function runningBroadcast() {
  return toBroadcast(await db.get(sql`SELECT ${BC_COLS} FROM broadcasts WHERE status = 'running' ORDER BY id LIMIT 1`));
}

/** draft → running, only if no other broadcast is running. */
export async function startBroadcast(id, total, progressChat, progressMsg) {
  const r = await db.run(sql`
    UPDATE broadcasts SET status = 'running', total = ${total}, progress_chat = ${progressChat}, progress_msg = ${progressMsg}
    WHERE id = ${id} AND status = 'draft'
      AND NOT EXISTS (SELECT 1 FROM broadcasts WHERE status = 'running')`);
  return r.rowsAffected > 0;
}

export async function setBroadcastStatus(id, from, to) {
  const finished = to === 'draft' || to === 'running' ? 0 : nowSec();
  const r = await db.run(sql`
    UPDATE broadcasts SET status = ${to}, finished_at = ${finished}, locked_until = 0 WHERE id = ${id} AND status = ${from}`);
  return r.rowsAffected > 0;
}

/** Takes the send lock of a running broadcast (one batch at a time, even under concurrent updates). */
export async function lockBroadcast(id, lockSec) {
  const now = nowSec();
  const r = await db.run(sql`
    UPDATE broadcasts SET locked_until = ${now + lockSec}
    WHERE id = ${id} AND status = 'running' AND locked_until < ${now} AND next_at <= ${now}`);
  return r.rowsAffected > 0;
}

export async function saveBroadcastProgress(b) {
  await db.run(sql`
    UPDATE broadcasts SET last_user = ${b.lastUser}, sent = ${b.sent}, failed = ${b.failed}, blocked = ${b.blocked},
      next_at = ${b.nextAt} WHERE id = ${b.id}`);
}

export async function unlockBroadcast(id) {
  await db.run(sql`UPDATE broadcasts SET locked_until = 0 WHERE id = ${id}`);
}

export async function setBroadcastProgressMessage(id, chat, msg) {
  await db.run(sql`UPDATE broadcasts SET progress_chat = ${chat}, progress_msg = ${msg}, progress_at = ${nowSec()} WHERE id = ${id}`);
}

export async function touchBroadcastProgress(id) {
  await db.run(sql`UPDATE broadcasts SET progress_at = ${nowSec()} WHERE id = ${id}`);
}

/** The next reachable users after `afterId`, in id order (served by idx_users_reachable). */
export async function reachableAfter(afterId, limit) {
  const rows = await db.all(sql`
    SELECT user_id FROM users WHERE started = 1 AND active = 1 AND banned = 0 AND user_id > ${afterId}
    ORDER BY user_id LIMIT ${limit}`);
  return rows.map((r) => num(r.user_id));
}

// ---------- stats ----------

export async function stats() {
  const kv = await getKv(['n_users', 'n_active', 'n_whispers', 'n_anon', 'day']);
  const banned = await db.get(sql`SELECT count(*) AS n FROM users WHERE banned = 1`);
  const reports = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM reports WHERE status = 'open' LIMIT 100)`);
  const day = localDay();
  const [d, n] = String(kv.day || '').split(':');
  return {
    users: num(kv.n_users),
    active: num(kv.n_active),
    whispers: num(kv.n_whispers),
    anon: num(kv.n_anon),
    today: d === day ? num(n) : 0,
    banned: num(banned && banned.n),
    reports: num(reports && reports.n),
    channels: await countChannels(),
  };
}
