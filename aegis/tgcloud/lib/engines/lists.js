/*
 * The 18 per-chat lists (aegis_list_entries + append-only aegis_list_history).
 *
 * kind: user (a member, by id) · bot (@username of a bot) · word · domain · chat (@channel or -100id)
 * · sticker (sticker set name) · pattern (text found in names).
 * effect — what the list does in Phase 3:
 *   mute / restrict / quarantine / ban / blacklist: the entry mirrors a punishment (adding punishes,
 *     removing lifts it; engines/punish.js keeps them in sync, also for punishments by command);
 *   warn: a view of members with active warnings (adding warns, removing clears them);
 *   mod: members who may use Aegis's moderation commands in the group without being admins;
 *   none: stored for the locks and filters of later phases (the panel says so).
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { LIST_ADD_MAX_LINES, LIST_MAX_ENTRIES, LIST_PAGE, LIST_VALUE_MAX } from '../config.js';
import { normalizeWord, nowSec } from '../core/util.js';

export const LISTS = [
  { code: 'vip', kind: 'user', effect: 'none', icon: '⭐' },
  { code: 'tru', kind: 'user', effect: 'none', icon: '🤝' },
  { code: 'mut', kind: 'user', effect: 'mute', icon: '🔇' },
  { code: 'rst', kind: 'user', effect: 'restrict', icon: '🚧' },
  { code: 'ban', kind: 'user', effect: 'ban', icon: '⛔️' },
  { code: 'blk', kind: 'user', effect: 'blacklist', icon: '🏴' },
  { code: 'wrn', kind: 'user', effect: 'warn', icon: '⚠️' },
  { code: 'qua', kind: 'user', effect: 'quarantine', icon: '🧪' },
  { code: 'sus', kind: 'user', effect: 'none', icon: '👁' },
  { code: 'mod', kind: 'user', effect: 'mod', icon: '🛡' },
  { code: 'bot', kind: 'bot', effect: 'none', icon: '🤖' },
  { code: 'bwd', kind: 'word', effect: 'none', icon: '🚫' },
  { code: 'gwd', kind: 'word', effect: 'none', icon: '✅' },
  { code: 'aln', kind: 'domain', effect: 'none', icon: '🔗' },
  { code: 'bln', kind: 'domain', effect: 'none', icon: '⛓' },
  { code: 'fwd', kind: 'chat', effect: 'none', icon: '📢' },
  { code: 'stk', kind: 'sticker', effect: 'none', icon: '🎭' },
  { code: 'nam', kind: 'pattern', effect: 'none', icon: '🏷' },
];
const BY_CODE = new Map(LISTS.map((l) => [l.code, l]));
export const get = (code) => BY_CODE.get(code) || null;
export const MIRRORS = { mute: 'mut', restrict: 'rst', ban: 'ban', blacklist: 'blk', quarantine: 'qua' };
export const isUserKind = (def) => def.kind === 'user';

/* ---------- parsing typed entries (pure) ---------- */

function oneEntry(kind, raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > LIST_VALUE_MAX) return null;
  if (kind === 'word' || kind === 'pattern') {
    const key = normalizeWord(s);
    return key ? { ekey: key, value: s } : null;
  }
  if (kind === 'domain') {
    const host = s.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
    if (!/^(?=.{3,120}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
    return { ekey: host, value: host };
  }
  if (kind === 'chat') {
    let m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i.exec(s) || /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(s);
    if (m) return { ekey: m[1].toLowerCase(), value: `@${m[1]}` };
    m = /^-100\d{6,16}$/.exec(s);
    return m ? { ekey: s, value: s } : null;
  }
  if (kind === 'bot') {
    const m = /^@?([A-Za-z][A-Za-z0-9_]{2,31}bot)$/i.exec(s);
    return m ? { ekey: m[1].toLowerCase(), value: `@${m[1]}` } : null;
  }
  if (kind === 'sticker') {
    const m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/addstickers\/([A-Za-z0-9_]{1,64})\/?$/i.exec(s) || /^([A-Za-z0-9_]{1,64})$/.exec(s);
    return m ? { ekey: m[1].toLowerCase(), value: m[1] } : null;
  }
  return null;
}

/* One entry per line. Gives { entries, bad: [line numbers], tooMany }. */
export function parseEntries(kind, text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const entries = [];
  const bad = [];
  const seen = new Set();
  lines.slice(0, LIST_ADD_MAX_LINES).forEach((line, i) => {
    const e = oneEntry(kind, line);
    if (!e) bad.push(i + 1);
    else if (!seen.has(e.ekey)) {
      seen.add(e.ekey);
      entries.push(e);
    }
  });
  return { entries, bad, tooMany: lines.length > LIST_ADD_MAX_LINES };
}

export const parseOne = (kind, text) => oneEntry(kind, text);

/* A sticker message → its set; a forwarded channel post → the channel. */
export function entryFromMessage(def, message) {
  if (def.kind === 'sticker' && message.sticker && message.sticker.set_name) return oneEntry('sticker', message.sticker.set_name);
  if (def.kind === 'chat') {
    const o = message.forward_origin;
    if (o && o.type === 'channel' && o.chat) {
      return o.chat.username ? { ekey: o.chat.username.toLowerCase(), value: `@${o.chat.username}` } : { ekey: String(o.chat.id), value: String(o.chat.id) };
    }
  }
  return null;
}

/* ---------- storage ---------- */

async function history(chatId, code, ekey, value, action, actorId, details = null) {
  await db.run(sql`INSERT INTO aegis_list_history (chat_id, list, ekey, value, action, actor_id, at, details)
    VALUES (${chatId}, ${code}, ${ekey}, ${value}, ${action}, ${actorId}, ${nowSec()}, ${details ? JSON.stringify(details) : null})`);
}

const live = (now) => sql`(expires_at = 0 OR expires_at > ${now})`;

export async function count(chatId, code) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_list_entries WHERE chat_id = ${chatId} AND list = ${code} AND ${live(nowSec())}`)).n);
}

export async function counts(chatId) {
  const rows = await db.all(sql`SELECT list, count(*) AS n FROM aegis_list_entries WHERE chat_id = ${chatId} AND ${live(nowSec())} GROUP BY list LIMIT 50`);
  const out = {};
  for (const r of rows) out[r.list] = Number(r.n);
  return out;
}

export async function page(chatId, code, p) {
  const total = await count(chatId, code);
  const rows = await db.all(sql`SELECT * FROM aegis_list_entries WHERE chat_id = ${chatId} AND list = ${code} AND ${live(nowSec())}
    ORDER BY added_at DESC, id DESC LIMIT ${LIST_PAGE} OFFSET ${p * LIST_PAGE}`);
  return { rows, total };
}

export async function entry(chatId, code, id) {
  return db.get(sql`SELECT * FROM aegis_list_entries WHERE chat_id = ${chatId} AND list = ${code} AND id = ${id}`);
}

export async function byKey(chatId, code, ekey) {
  const r = await db.get(sql`SELECT * FROM aegis_list_entries WHERE chat_id = ${chatId} AND list = ${code} AND ekey = ${String(ekey)}`);
  if (r && Number(r.expires_at) && Number(r.expires_at) <= nowSec()) return null;
  return r;
}

export const has = async (chatId, code, ekey) => !!(await byKey(chatId, code, ekey));

/*
 * Adds (or refreshes) an entry. Gives 'added', 'updated' or 'full' (the list reached LIST_MAX_ENTRIES).
 * e: { ekey, value, userId?, note?, expiresAt? }.
 */
export async function upsert(chatId, code, e, actorId) {
  const t = nowSec();
  const before = await db.get(sql`SELECT * FROM aegis_list_entries WHERE chat_id = ${chatId} AND list = ${code} AND ekey = ${String(e.ekey)}`);
  if (!before && await count(chatId, code) >= LIST_MAX_ENTRIES) return 'full';
  await db.run(sql`INSERT INTO aegis_list_entries (chat_id, list, ekey, value, user_id, note, added_by, added_at, updated_by, updated_at, expires_at)
    VALUES (${chatId}, ${code}, ${String(e.ekey)}, ${e.value}, ${e.userId || 0}, ${e.note || null}, ${actorId}, ${t}, ${actorId}, ${t}, ${e.expiresAt || 0})
    ON CONFLICT(chat_id, list, ekey) DO UPDATE SET value = excluded.value, note = COALESCE(excluded.note, aegis_list_entries.note),
      updated_by = excluded.updated_by, updated_at = excluded.updated_at, expires_at = excluded.expires_at,
      added_by = CASE WHEN aegis_list_entries.expires_at > 0 AND aegis_list_entries.expires_at <= ${t} THEN excluded.added_by ELSE aegis_list_entries.added_by END,
      added_at = CASE WHEN aegis_list_entries.expires_at > 0 AND aegis_list_entries.expires_at <= ${t} THEN excluded.added_at ELSE aegis_list_entries.added_at END`);
  const fresh = !before || (Number(before.expires_at) && Number(before.expires_at) <= t);
  await history(chatId, code, String(e.ekey), e.value, fresh ? 'add' : 'edit', actorId, { note: e.note || null, expiresAt: e.expiresAt || 0 });
  return fresh ? 'added' : 'updated';
}

export async function remove(chatId, code, ekey, actorId, details = null) {
  const before = await db.get(sql`SELECT * FROM aegis_list_entries WHERE chat_id = ${chatId} AND list = ${code} AND ekey = ${String(ekey)}`);
  if (!before) return false;
  await db.run(sql`DELETE FROM aegis_list_entries WHERE id = ${before.id}`);
  await history(chatId, code, String(ekey), before.value, 'remove', actorId, details);
  return true;
}

export async function setNote(chatId, code, id, note, actorId) {
  const before = await entry(chatId, code, id);
  if (!before) return false;
  await db.run(sql`UPDATE aegis_list_entries SET note = ${note || null}, updated_by = ${actorId}, updated_at = ${nowSec()} WHERE id = ${id}`);
  await history(chatId, code, before.ekey, before.value, 'edit', actorId, { note: { from: before.note, to: note || null } });
  return true;
}

/* A text entry's new value. Gives 'ok', 'gone' or 'exists'. */
export async function setValue(chatId, code, id, e, actorId) {
  const before = await entry(chatId, code, id);
  if (!before) return 'gone';
  if (e.ekey !== before.ekey && await db.get(sql`SELECT id FROM aegis_list_entries WHERE chat_id = ${chatId} AND list = ${code} AND ekey = ${e.ekey}`)) return 'exists';
  await db.run(sql`UPDATE aegis_list_entries SET ekey = ${e.ekey}, value = ${e.value}, updated_by = ${actorId}, updated_at = ${nowSec()} WHERE id = ${id}`);
  await history(chatId, code, e.ekey, e.value, 'edit', actorId, { value: { from: before.value, to: e.value } });
  return 'ok';
}

export async function search(chatId, code, q) {
  const like = `%${String(q).toLowerCase().replace(/[%_]/g, '')}%`;
  return db.all(sql`SELECT * FROM aegis_list_entries WHERE chat_id = ${chatId} AND list = ${code} AND ${live(nowSec())}
    AND (lower(value) LIKE ${like} OR ekey LIKE ${like} OR lower(COALESCE(note, '')) LIKE ${like}) ORDER BY added_at DESC LIMIT 20`);
}

export async function historyOf(chatId, code, ekey = null, limit = 15) {
  if (ekey !== null) {
    return db.all(sql`SELECT * FROM aegis_list_history WHERE chat_id = ${chatId} AND list = ${code} AND ekey = ${String(ekey)} ORDER BY at DESC, id DESC LIMIT ${limit}`);
  }
  return db.all(sql`SELECT * FROM aegis_list_history WHERE chat_id = ${chatId} AND list = ${code} ORDER BY at DESC, id DESC LIMIT ${limit}`);
}

export async function all(chatId, code, limit) {
  return db.all(sql`SELECT * FROM aegis_list_entries WHERE chat_id = ${chatId} AND list = ${code} AND ${live(nowSec())} ORDER BY added_at, id LIMIT ${limit}`);
}

/* A group became a supergroup: its lists and their history move with it. */
export async function migrate(oldId, newId) {
  await db.run(sql`DELETE FROM aegis_list_entries WHERE chat_id = ${newId}`);
  await db.run(sql`UPDATE aegis_list_entries SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
  await db.run(sql`UPDATE aegis_list_history SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}
