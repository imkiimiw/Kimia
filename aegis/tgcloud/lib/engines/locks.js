/*
 * The 42 group locks (aegis_locks): what each one catches, its settings, and matching a message.
 *
 * Settings of one lock (config JSON, defaults in DEFAULT):
 *   on   1 = active                      a    punishment: none, warn, mute, restrict, kick, ban
 *   d    punishment duration (s, 0 = until lifted; mute, restrict, ban)
 *   del  1 = delete the message, 0 = keep it (only punish / warn / log)
 *   n    notice in the group: default, custom (txt), off
 *   log  1 = post hits to the log channel (category «locks»)
 *   exT, exM   trusted-list / moderator-list members are exempt
 *   ex   up to LOCK_EXEMPT_MAX member ids exempt from this lock
 *   s    sensitivity low / medium / high (only locks with `sens`; meaning per lock below)
 *   sc   scope: all members, or only new members (joined within the chat's new_window)
 * Always exempt (lib/ui/enforce.js): admins, Aegis, VIP-list members, the anonymous admin, the
 * linked channel's own posts. The service-message lock applies to every service message.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { LOCK_DURATIONS, LOCK_EXEMPT_MAX, LOCK_TEXT_MAX } from '../config.js';
import * as audit from '../core/audit.js';
import {
  EMOJI_MAX, LONG_MAX, RUN_MAX, WORD_RUN_MAX, bannedHit, charCount, commandTarget, deceptive, domainsOf, emojiCount, hostsOf, isInvite, langHit,
  linksOf, longestRun, repeatedWords, scripts, wordsText,
} from '../core/msgscan.js';
import { normalizeWord, nowSec, parseJson } from '../core/util.js';
import * as lists from './lists.js';

const L = (code, cat, icon, extra = {}) => ({ code, cat, icon, sens: false, punish: true, ...extra });
export const LOCKS = [
  L('photo', 'media', '🖼'), L('video', 'media', '🎬'), L('gif', 'media', '🎞'), L('sticker', 'media', '🧸'), L('anim_sticker', 'media', '✨'),
  L('file', 'media', '📎'), L('music', 'media', '🎵'), L('voice', 'media', '🎤'), L('round', 'media', '⭕️'), L('contact', 'media', '👤'),
  L('location', 'media', '📍'), L('poll', 'media', '📊'), L('dice', 'media', '🎲'), L('story', 'media', '📖'),
  L('text', 'text', '💬'), L('link', 'text', '🔗', { sens: true, allow: 'aln' }), L('invite', 'text', '📨'), L('masked', 'text', '🕶', { sens: true }),
  L('username', 'text', '🏷'), L('mention', 'text', '👋'), L('hashtag', 'text', '#️⃣'), L('command', 'text', '⌨️', { sens: true }), L('email', 'text', '📧'),
  L('phone', 'text', '☎️'), L('format', 'text', '🅱️'), L('spoiler', 'text', '🫥'), L('custom_emoji', 'text', '💎'),
  L('badword', 'content', '🚫', { sens: true, source: 'bwd', allow: 'gwd' }), L('blocklink', 'content', '⛓', { sens: true, source: 'bln' }),
  L('emoji', 'content', '😀', { sens: true }), L('long', 'content', '📏', { sens: true }), L('repeat', 'content', '🔁', { sens: true }),
  L('lang_fa', 'content', 'ف', { sens: true, script: 'fa' }), L('lang_latin', 'content', 'A', { sens: true, script: 'latin' }),
  L('lang_cyrillic', 'content', 'Я', { sens: true, script: 'cyrillic' }), L('lang_cjk', 'content', '字', { sens: true, script: 'cjk' }),
  L('forward', 'behavior', '↪️', { sens: true, allow: 'fwd' }), L('via_bot', 'behavior', '🧩'), L('as_channel', 'behavior', '📢', { punish: false }),
  L('bots', 'behavior', '🦾', { allow: 'bot' }), L('service', 'behavior', '🔔', { punish: false }), L('edit', 'behavior', '✏️'),
];
export const CATEGORIES = ['media', 'text', 'content', 'behavior'];
const BY_CODE = new Map(LOCKS.map((l) => [l.code, l]));
export const get = (code) => BY_CODE.get(code) || null;

export const ACTIONS = ['none', 'warn', 'mute', 'restrict', 'kick', 'ban'];
export const TIMED_ACTIONS = new Set(['mute', 'restrict', 'ban']);
export const SEVERITY = { none: 0, warn: 1, mute: 2, restrict: 3, kick: 4, ban: 5 };
export const NOTICES = ['default', 'custom', 'off'];
export const SENS = ['low', 'medium', 'high'];
export const SCOPES = ['all', 'new'];
export const DEFAULT = { on: 0, a: 'none', d: 0, del: 1, n: 'default', txt: null, log: 1, exT: 1, exM: 1, ex: [], s: 'medium', sc: 'all' };

/* A stored config made complete and safe (unknown or bad values fall back to the default). */
export function normalize(raw) {
  const c = { ...DEFAULT, ...(raw && typeof raw === 'object' ? raw : {}) };
  const bit = (v, d) => (v === 0 || v === 1 ? v : d);
  return {
    on: bit(c.on, 0),
    a: ACTIONS.includes(c.a) ? c.a : 'none',
    d: LOCK_DURATIONS.includes(c.d) ? c.d : 0,
    del: bit(c.del, 1),
    n: NOTICES.includes(c.n) ? c.n : 'default',
    txt: typeof c.txt === 'string' && c.txt.trim() ? [...c.txt].slice(0, LOCK_TEXT_MAX).join('') : null,
    log: bit(c.log, 1),
    exT: bit(c.exT, 1),
    exM: bit(c.exM, 1),
    ex: Array.isArray(c.ex) ? c.ex.filter((x) => Number.isSafeInteger(x) && x > 0).slice(0, LOCK_EXEMPT_MAX) : [],
    s: SENS.includes(c.s) ? c.s : 'medium',
    sc: SCOPES.includes(c.sc) ? c.sc : 'all',
  };
}

/* ---------- storage ---------- */

export async function all(chatId) {
  const rows = await db.all(sql`SELECT code, config FROM aegis_locks WHERE chat_id = ${chatId} LIMIT 60`);
  const out = new Map();
  for (const r of rows) if (BY_CODE.has(r.code)) out.set(r.code, normalize(parseJson(r.config, {})));
  return out;
}

/* Only the locks that are on (one indexed query per group message). */
export async function active(chatId) {
  const rows = await db.all(sql`SELECT code, config FROM aegis_locks WHERE chat_id = ${chatId} AND enabled = 1 LIMIT 60`);
  const out = new Map();
  for (const r of rows) {
    const c = normalize(parseJson(r.config, {}));
    if (BY_CODE.has(r.code) && c.on) out.set(r.code, c);
  }
  return out;
}

export async function config(chatId, code) {
  const r = await db.get(sql`SELECT config FROM aegis_locks WHERE chat_id = ${chatId} AND code = ${code}`);
  return normalize(r ? parseJson(r.config, {}) : {});
}

/* Changes some settings of one lock (validated); logged with what changed. Gives the new config. */
export async function update(chatId, code, patch, actorId) {
  if (!BY_CODE.has(code)) return null;
  const before = await config(chatId, code);
  const next = normalize({ ...before, ...patch });
  const changed = Object.keys(patch).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
  if (!changed.length) return next;
  await db.run(sql`INSERT INTO aegis_locks (chat_id, code, enabled, config, updated_by, updated_at)
    VALUES (${chatId}, ${code}, ${next.on}, ${JSON.stringify(next)}, ${actorId}, ${nowSec()})
    ON CONFLICT(chat_id, code) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  const details = {};
  for (const k of changed) details[k] = k === 'txt' ? '…' : next[k];
  await audit.log(actorId, 'lock.set', { chatId, target: code, details });
  return next;
}

/* Every lock off at once (their other settings are kept). Gives how many were on. */
export async function allOff(chatId, actorId) {
  const on = await active(chatId);
  for (const code of on.keys()) await update(chatId, code, { on: 0 }, actorId);
  return on.size;
}

export async function countOn(chatId) {
  const rows = await db.all(sql`SELECT code FROM aegis_locks WHERE chat_id = ${chatId} AND enabled = 1 LIMIT 60`);
  const out = {};
  for (const c of CATEGORIES) out[c] = 0;
  for (const r of rows) if (BY_CODE.has(r.code)) out[BY_CODE.get(r.code).cat] += 1;
  return out;
}

export async function recordHit(chatId, code, userId, action, punishment) {
  await db.run(sql`INSERT INTO aegis_lock_hits (chat_id, code, user_id, action, punishment, at) VALUES (${chatId}, ${code}, ${userId || 0}, ${action}, ${punishment || null}, ${nowSec()})`);
}

export async function hits(chatId, code, limit = 10) {
  return db.all(sql`SELECT * FROM aegis_lock_hits WHERE chat_id = ${chatId} AND code = ${code} ORDER BY at DESC, id DESC LIMIT ${limit}`);
}

export async function hitCount(chatId, code, since) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_lock_hits WHERE chat_id = ${chatId} AND code = ${code} AND at >= ${since}`)).n);
}

export async function sweepHits(now, keepSec) {
  const r = await db.run(sql`DELETE FROM aegis_lock_hits WHERE id IN (SELECT id FROM aegis_lock_hits WHERE at < ${now - keepSec} ORDER BY at LIMIT 500)`);
  return r.rowsAffected;
}

/* A group became a supergroup: its locks and their hits move with it. */
export async function migrate(oldId, newId) {
  await db.run(sql`DELETE FROM aegis_locks WHERE chat_id = ${newId}`);
  await db.run(sql`UPDATE aegis_locks SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
  await db.run(sql`UPDATE aegis_lock_hits SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}

/* ---------- matching ---------- */

/* List lookups for one message, cached. */
export function listEnv(chatId) {
  const keys = new Map();
  return {
    async keys(code) {
      if (!keys.has(code)) keys.set(code, (await lists.all(chatId, code, 2000)).map((e) => e.ekey));
      return keys.get(code);
    },
    async anyIn(code, candidates) {
      for (const k of candidates) if (await lists.has(chatId, code, String(k).toLowerCase())) return true;
      return false;
    },
  };
}

function forwardKeys(origin) {
  const c = origin.chat || origin.sender_chat;
  if (c) return [c.username, String(c.id)].filter(Boolean);
  if (origin.sender_user) return [origin.sender_user.username, String(origin.sender_user.id)].filter(Boolean);
  return [];
}

function forwardCounts(origin, sens) {
  if (sens === 'high') return true;
  if (origin.type === 'channel') return true;
  if (sens === 'low') return false;
  return origin.type === 'chat' || (origin.type === 'user' && !!origin.sender_user && origin.sender_user.is_bot);
}

/*
 * Which of the active locks the scanned message `f` breaks: [{ code, cfg }]. env: listEnv(); bot:
 * Aegis's user; own: Aegis's own command names; edited: an edit of an earlier message.
 */
export async function evaluate(f, on, { env, bot, own, edited = false }) {
  const out = [];
  let langStats = null;
  const hit = (code) => out.push({ code, cfg: on.get(code) });
  for (const def of LOCKS) {
    const cfg = on.get(def.code);
    if (!cfg) continue;
    const s = cfg.s;
    const c = def.code;
    if (def.cat === 'media') {
      if (f.kinds.has(c)) hit(c);
      continue;
    }
    if (def.script) {
      if (!f.text) continue;
      langStats = langStats || scripts(wordsText(f));
      if (langHit(langStats, def.script, s)) hit(c);
      continue;
    }
    switch (c) {
      case 'text': if (f.kinds.has('text')) hit(c); break;
      case 'link': {
        const hosts = hostsOf(linksOf(f, s));
        for (const h of hosts) {
          if (!(await env.anyIn('aln', domainsOf(h)))) {
            hit(c);
            break;
          }
        }
        break;
      }
      case 'invite': if (linksOf(f, 'medium').some(isInvite)) hit(c); break;
      case 'masked': if (f.hidden.some((h) => (s === 'low' ? deceptive(h) : true))) hit(c); break;
      case 'username': if (f.types.has('mention')) hit(c); break;
      case 'mention': if (f.types.has('text_mention')) hit(c); break;
      case 'hashtag': if (f.types.has('hashtag') || f.types.has('cashtag')) hit(c); break;
      case 'command': {
        const me = String(bot.username || '').toLowerCase();
        const counts = (cmd) => {
          const target = commandTarget(cmd);
          if (target) return target !== me;
          if (s === 'low') return false;
          return !own.has(String(cmd).slice(1).toLowerCase());
        };
        if (f.commands.some(counts)) hit(c);
        break;
      }
      case 'email': if (f.types.has('email')) hit(c); break;
      case 'phone': if (f.types.has('phone_number')) hit(c); break;
      case 'format': if (f.format) hit(c); break;
      case 'spoiler': if (f.types.has('spoiler')) hit(c); break;
      case 'custom_emoji': if (f.types.has('custom_emoji')) hit(c); break;
      case 'badword': {
        if (!f.text) break;
        const banned = await env.keys('bwd');
        if (banned.length && bannedHit(f.text, banned, await env.keys('gwd'), normalizeWord, s)) hit(c);
        break;
      }
      case 'blocklink': {
        for (const h of hostsOf(linksOf(f, s))) {
          if (await env.anyIn('bln', domainsOf(h))) {
            hit(c);
            break;
          }
        }
        break;
      }
      case 'emoji': if (emojiCount(f) > EMOJI_MAX[s]) hit(c); break;
      case 'long': if (charCount(f.text) > LONG_MAX[s]) hit(c); break;
      case 'repeat': if (f.text && (longestRun(f.text) >= RUN_MAX[s] || repeatedWords(f.text) >= WORD_RUN_MAX[s])) hit(c); break;
      case 'forward': {
        const o = f.forward;
        if (o && forwardCounts(o, s) && !(await env.anyIn('fwd', forwardKeys(o)))) hit(c);
        break;
      }
      case 'via_bot': if (f.viaBot && f.viaBot.id !== bot.id) hit(c); break;
      case 'as_channel': if (f.senderChat && !f.automatic) hit(c); break;
      case 'edit': if (edited) hit(c); break;
      default: break; /* bots and service: lib/ui/enforce.js handles them on service messages */
    }
  }
  return out;
}

/* Bots in a join message that the bots lock removes (not Aegis, not on the allowed-bots list). */
export async function unwantedBots(f, env, bot) {
  const out = [];
  for (const u of f.newMembers) {
    if (!u.is_bot || u.id === bot.id) continue;
    if (u.username && await env.anyIn('bot', [u.username])) continue;
    out.push(u);
  }
  return out;
}
