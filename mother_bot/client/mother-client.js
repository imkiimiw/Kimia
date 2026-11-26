// Wanger mother-bot client for a CHILD bot on Telegram Serverless (tgcloud).
//
// Copy this file into the child bot as tgcloud/lib/mother.js, set BOT_KEY and HUB_CHAT below, add the
// `mother_hub` table to its schema.js (see README.md next to this file), and call:
//   onHubPost(post)          first thing in handlers/channel_post.js — true = it was a hub message
//   gate(userId, { admin })  before serving a user: { ok } or { ok: false, reason, text } (ban,
//                            maintenance, slow mode) — send `text` to the user and stop
//   track(userId, isNew)     after serving a user: batched activity for the mother's statistics
//   reportError(where, err)  in catch blocks: batched errors for the team's log chat and health checks
//   reportBlocked(userId)    when sending to a user fails with 403
//   reportAbuse(userId, reason, detail)        when the bot's own spam/flood detection fires
//   reportPurchase(userId, amount, currency, code) after a successful payment (club points, code use)
//   requiredChannels()       the central forced-join channels for this bot: [{ id, u, t, inv }]
//   checkPromo(code, userId) a discount code the mother published: { p: percent, ... } or null
//
// How it travels: the hub is a private channel where the mother and this bot are admins. This bot
// posts "#wg1 {json}" messages there and reads the mother's posts as channel_post updates. Nothing
// here ever throws into the caller: a hub problem only means the mother hears less.
import { api, db } from 'sdk';
import { sql } from 'sdk/db';

// ---------- set these two ----------
export const BOT_KEY = 'change_me'; // this bot's key in the mother's catalog (/admin → 🤖 ربات‌ها)
export const HUB_CHAT = 0; // the hub channel's id, -100…; 0 = not connected (every call does nothing)
export const VERSION = '1.0.0'; // shown in the mother's panel

const PREFIX = '#wg1';
const FLUSH_SEC = 120; // buffered activity and errors are posted at most this often
const HEARTBEAT_SEC = 600;
const HELLO_SEC = 3600; // ask the mother for the config again at most this often while we have none
const USE_PER_POST = 120;
const MAX_TEXT = 3900;

const DEFAULT_TEXT = {
  ban: '⛔️ دسترسی شما به این ربات محدود شده است.',
  closed: '🔧 ربات برای تعمیر و به‌روزرسانی موقتاً در دسترس نیست. کمی بعد دوباره سر بزنید.',
  slow: '⏳ ربات الان شلوغ است؛ لطفاً {n} ثانیه دیگر دوباره امتحان کنید.',
};

const now = () => Math.floor(Date.now() / 1000);
const on = () => !!HUB_CHAT && BOT_KEY !== 'change_me';

// ---------- storage: the child's own mother_hub table (key TEXT PRIMARY KEY, value TEXT) ----------

async function get(key) {
  const r = await db.get(sql`SELECT value FROM mother_hub WHERE key = ${key}`);
  return r ? r.value : null;
}

async function set(key, value) {
  await db.run(sql`INSERT INTO mother_hub (key, value) VALUES (${key}, ${value == null ? null : String(value)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
}

async function remove(key) {
  await db.run(sql`DELETE FROM mother_hub WHERE key = ${key}`);
}

/** Compare-and-set on a time key: true for one caller per `every` seconds. */
async function claim(key, every) {
  const t = now();
  const r = await db.run(sql`INSERT INTO mother_hub (key, value) VALUES (${key}, ${String(t)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(COALESCE(mother_hub.value, '0') AS INTEGER) <= ${t - every}`);
  return r.rowsAffected > 0;
}

function parse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

// ---------- posting ----------

async function post(kind, d) {
  if (!on()) return false;
  const text = `${PREFIX} ${JSON.stringify({ b: BOT_KEY, k: kind, to: 'mother', t: now(), d })}`;
  if (text.length > MAX_TEXT) return false;
  try {
    await api.sendMessage({ chat_id: HUB_CHAT, text, disable_notification: true, link_preview_options: { is_disabled: true } });
    return true;
  } catch (err) {
    console.warn(`mother hub post (${kind}) failed: ${String((err && err.description) || err)}`);
    return false;
  }
}

/** Asks the mother for this bot's config, bans and codes (once an hour while we have no config). */
async function helloIfNeeded() {
  if (await get('cfg')) return;
  if (await claim('hello_at', HELLO_SEC)) await post('hello', { v: VERSION });
}

// ---------- reading the mother's posts ----------

/** Call first in handlers/channel_post.js. Returns true if the post was a hub message (stop there). */
export async function onHubPost(p) {
  try {
    if (!on() || !p || !p.chat || Number(p.chat.id) !== Number(HUB_CHAT)) return false;
    const s = String(p.text || '');
    if (!s.startsWith(`${PREFIX} `)) return true; // other posts in the hub (the mother's wakes): ignore
    const doc = parse(s.slice(PREFIX.length + 1), null);
    if (!doc || doc.b !== 'mother' || (doc.to !== BOT_KEY && doc.to !== '*')) return true;
    const d = doc.d || {};
    if (doc.k === 'cfg') {
      await set('cfg', JSON.stringify(d));
      await post('ack', { v: d.v });
    } else if (doc.k === 'ban') {
      for (const uid of Array.isArray(d.u) ? d.u : []) await set(`ban:${uid}`, String(Number(d.until) || 0));
    } else if (doc.k === 'unban') {
      for (const uid of Array.isArray(d.u) ? d.u : []) await remove(`ban:${uid}`);
    } else if (doc.k === 'promo' || doc.k === 'promos') {
      for (const p of doc.k === 'promos' ? (Array.isArray(d.l) ? d.l : []) : [d]) {
        const bots = p.bots;
        if (p.c && (bots === '*' || (Array.isArray(bots) && bots.includes(BOT_KEY)))) await set(`promo:${String(p.c).toUpperCase()}`, JSON.stringify(p));
      }
    } else if (doc.k === 'promo_off') {
      for (const c of [d.c, ...(Array.isArray(d.cs) ? d.cs : [])]) if (c) await remove(`promo:${String(c).toUpperCase()}`);
    }
    return true;
  } catch (err) {
    console.warn(`mother hub read failed: ${String((err && err.message) || err)}`);
    return true;
  }
}

/** The config the mother posted for this bot: { v, mode, msg, until, slow, join } or null. */
export async function config() {
  return parse(await get('cfg'), null);
}

// ---------- gate ----------

/**
 * Should this user be served now? { ok: true } or { ok: false, reason: 'ban'|'closed'|'slow', text }.
 * `admin`: the bot's own admins pass maintenance and slow mode (never a ban check for them either).
 */
export async function gate(userId, { admin = false } = {}) {
  try {
    if (!on()) return { ok: true };
    await helloIfNeeded();
    if (admin) return { ok: true };
    const t = now();
    const ban = await get(`ban:${Number(userId)}`);
    if (ban !== null && (Number(ban) === 0 || Number(ban) > t)) return { ok: false, reason: 'ban', text: DEFAULT_TEXT.ban };
    const cfg = await config();
    if (!cfg) return { ok: true };
    const active = !Number(cfg.until) || Number(cfg.until) > t;
    if (cfg.mode === 'closed' && active) return { ok: false, reason: 'closed', text: cfg.msg ? `🔧 ${cfg.msg}` : DEFAULT_TEXT.closed };
    if (cfg.mode === 'slow' && active) {
      const every = Math.max(5, Number(cfg.slow) || 30);
      if (!(await claim(`slow:${Number(userId)}`, every))) {
        return { ok: false, reason: 'slow', text: cfg.msg ? `⏳ ${cfg.msg}` : DEFAULT_TEXT.slow.replace('{n}', String(every)) };
      }
    }
    return { ok: true };
  } catch (err) {
    console.warn(`mother gate failed: ${String((err && err.message) || err)}`);
    return { ok: true };
  }
}

/** Central forced-join channels for this bot: [{ id, u (username), t (title), inv (invite link) }]. */
export async function requiredChannels() {
  try {
    const cfg = await config();
    return cfg && Array.isArray(cfg.join) ? cfg.join : [];
  } catch {
    return [];
  }
}

/** A discount code published by the mother, valid now for this user: { c, p, until, uid, ... } or null. */
export async function checkPromo(code, userId) {
  try {
    const p = parse(await get(`promo:${String(code || '').trim().toUpperCase()}`), null);
    if (!p) return null;
    if (Number(p.until) && Number(p.until) <= now()) return null;
    if (Number(p.uid) && Number(p.uid) !== Number(userId)) return null;
    return p;
  } catch {
    return null;
  }
}

// ---------- reporting ----------

/** Counts a served request; activity is posted in batches (every FLUSH_SEC at most). */
export async function track(userId, isNew = false) {
  try {
    if (!on()) return;
    const uid = Number(userId);
    await db.run(sql`INSERT INTO mother_hub (key, value) VALUES (${`u:${uid}`}, ${isNew ? '1|1' : '1|0'})
      ON CONFLICT(key) DO UPDATE SET value = (CAST(substr(mother_hub.value, 1, instr(mother_hub.value, '|') - 1) AS INTEGER) + 1)
        || '|' || MAX(CAST(substr(mother_hub.value, instr(mother_hub.value, '|') + 1) AS INTEGER), ${isNew ? 1 : 0})`);
    await flush();
  } catch (err) {
    console.warn(`mother track failed: ${String((err && err.message) || err)}`);
  }
}

/** Counts an error under a signature (where + message); posted in batches. */
export async function reportError(where, err) {
  try {
    if (!on()) return;
    const msg = String((err && (err.description || err.message)) || err || 'error').replace(/\d{6,}/g, 'N').slice(0, 300);
    const sig = `${String(where || '').slice(0, 40)}: ${msg.slice(0, 70)}`;
    await db.run(sql`INSERT INTO mother_hub (key, value) VALUES (${`e:${sig}`}, ${`1|${msg}`})
      ON CONFLICT(key) DO UPDATE SET value = (CAST(substr(mother_hub.value, 1, instr(mother_hub.value, '|') - 1) AS INTEGER) + 1)
        || substr(mother_hub.value, instr(mother_hub.value, '|'))`);
    await flush();
  } catch (e) {
    console.warn(`mother reportError failed: ${String((e && e.message) || e)}`);
  }
}

export async function reportBlocked(userId) {
  try {
    if (!on()) return;
    await set(`b:${Number(userId)}`, '1');
    await flush();
  } catch {
    // never mind
  }
}

export async function reportAbuse(userId, reason, detail = '') {
  if (!on()) return false;
  return post('abuse', { u: Number(userId), r: String(reason || '').slice(0, 100), d: String(detail || '').slice(0, 500) });
}

/** A successful payment. `currency` 'XTR' for Telegram Stars; `code` the discount code used, if any. */
export async function reportPurchase(userId, amount, currency = 'XTR', code = null) {
  if (!on()) return false;
  const d = { u: Number(userId), amt: Number(amount) || 0, cur: String(currency || '') };
  if (code) {
    d.code = String(code).toUpperCase();
    const p = parse(await get(`promo:${d.code}`), null);
    if (p && Number(p.uid)) await remove(`promo:${d.code}`); // a personal code is single use
  }
  return post('buy', d);
}

async function takeRange(prefix, limit) {
  const rows = await db.all(sql`SELECT key, value FROM mother_hub WHERE key >= ${prefix} AND key < ${`${prefix.slice(0, -1)};`} ORDER BY key LIMIT ${limit}`);
  for (const r of rows) await remove(r.key);
  return rows;
}

/**
 * Posts what is buffered (activity, errors, blocked users) and a heartbeat when due. Runs at most
 * once per FLUSH_SEC (`force` skips that). `stats` (optional): { users } — the bot's own total.
 */
export async function flush({ force = false, stats = null } = {}) {
  try {
    if (!on()) return false;
    if (!force && !(await claim('flush_at', FLUSH_SEC))) return false;
    const uses = await takeRange('u:', USE_PER_POST);
    if (uses.length) {
      await post('use', { u: uses.map((r) => {
        const [n, fresh] = String(r.value).split('|');
        return [Number(r.key.slice(2)), Number(n) || 1, Number(fresh) ? 1 : 0];
      }) });
    }
    const errs = await takeRange('e:', 20);
    if (errs.length) {
      await post('err', { e: errs.map((r) => {
        const i = String(r.value).indexOf('|');
        return [r.key.slice(2), String(r.value).slice(i + 1).slice(0, 300), Number(String(r.value).slice(0, i)) || 1];
      }) });
    }
    const blocked = await takeRange('b:', 200);
    if (blocked.length) await post('blk', { u: blocked.map((r) => Number(r.key.slice(2))) });
    if (force || (await claim('hb_at', HEARTBEAT_SEC))) {
      const d = { v: VERSION };
      if (stats && Number(stats.users) > 0) d.users = Number(stats.users);
      await post('hb', d);
    }
    return true;
  } catch (err) {
    console.warn(`mother flush failed: ${String((err && err.message) || err)}`);
    return false;
  }
}
