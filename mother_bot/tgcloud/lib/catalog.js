// The catalog of Wanger bots: queries, the seed, effective status, and the keyword search the
// assistant and the quick-access screens use. Bot keys are [a-z0-9_]{2,16}: they travel in
// callback_data, hub messages and the child bots' client config.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { MAX_BOTS } from './config.js';
import { SEED_BOTS } from './seed.js';
import { kvGet, setKv } from './store.js';
import { esc, normalize, nowSec, parseJson } from './util.js';

export const CATEGORIES = [
  { id: 'download', name: 'دانلود', emoji: '📥' },
  { id: 'music', name: 'موسیقی', emoji: '🎵' },
  { id: 'fun', name: 'سرگرمی و بازی', emoji: '🎮' },
  { id: 'social', name: 'پیام و ارتباط', emoji: '💬' },
  { id: 'group', name: 'مدیریت گروه', emoji: '🛡' },
  { id: 'tools', name: 'ابزار', emoji: '🧰' },
  { id: 'news', name: 'خبر', emoji: '📰' },
  { id: 'other', name: 'سایر', emoji: '✨' },
];
export const categoryOf = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];

export const KEY_RE = /^[a-z0-9_]{2,16}$/;
export const isBotKey = (k) => typeof k === 'string' && KEY_RE.test(k) && k !== 'mother';

/** Turns a db row into a bot object with parsed lists. */
export function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    features: parseJson(row.features, []),
    faq: parseJson(row.faq, []),
    fixes: parseJson(row.fixes, []),
  };
}

/** Writes the seed into an empty catalog, once (kv seeded). */
export async function ensureSeeded() {
  if (await kvGet('seeded')) return false;
  const now = nowSec();
  for (const b of SEED_BOTS) {
    await db.run(sql`
      INSERT INTO bots (key, name, username, emoji, category, short, description, features, faq, fixes, keywords, langs, sort, added_at)
      VALUES (${b.key}, ${b.name}, ${b.username || null}, ${b.emoji}, ${b.category}, ${b.short}, ${b.description},
        ${JSON.stringify(b.features)}, ${JSON.stringify(b.faq)}, ${JSON.stringify(b.fixes)}, ${b.keywords}, ${b.langs}, ${b.sort}, ${now - b.sort})
      ON CONFLICT(key) DO NOTHING`);
  }
  await setKv('seeded', now);
  return true;
}

export async function getBot(key) {
  if (!isBotKey(key)) return null;
  return hydrate(await db.get(sql`SELECT * FROM bots WHERE key = ${key}`));
}

/** Every bot (team view includes hidden ones), in catalog order. */
export async function listBots({ team = false } = {}) {
  const rows = team
    ? await db.all(sql`SELECT * FROM bots ORDER BY sort, key LIMIT ${MAX_BOTS}`)
    : await db.all(sql`SELECT * FROM bots WHERE hidden = 0 ORDER BY sort, key LIMIT ${MAX_BOTS}`);
  return rows.map(hydrate);
}

export async function newestBots(limit = 5) {
  const rows = await db.all(sql`SELECT * FROM bots WHERE hidden = 0 ORDER BY added_at DESC, key LIMIT ${limit}`);
  return rows.map(hydrate);
}

export async function countBots() {
  const r = await db.get(sql`SELECT count(*) AS n FROM bots`);
  return Number((r && r.n) || 0);
}

const BOT_COLUMNS = new Set([
  'name', 'username', 'emoji', 'category', 'short', 'description', 'features', 'faq', 'fixes', 'keywords', 'langs',
  'sort', 'hidden', 'token', 'tg_id', 'status', 'status_note', 'status_at', 'status_until', 'mode', 'mode_msg',
  'mode_until', 'slow_sec', 'health', 'health_note', 'health_at', 'health_alert', 'silence_min', 'cfg_ver', 'cfg_ack',
  'version', 'users_reported',
]);

/** Updates columns of a bot: `fields` maps column names to values (lists are stored as JSON). */
export async function updateBot(key, fields) {
  let set = null;
  for (const [col, raw] of Object.entries(fields)) {
    if (!BOT_COLUMNS.has(col)) throw new Error(`updateBot: ${col}`);
    const value = Array.isArray(raw) ? JSON.stringify(raw) : raw;
    const part = sql`${sql.raw(col)} = ${value}`;
    set = set ? sql`${set}, ${part}` : part;
  }
  if (!set) return;
  await db.run(sql`UPDATE bots SET ${set} WHERE key = ${key}`);
}

export async function createBot(key, name) {
  const r = await db.run(sql`
    INSERT INTO bots (key, name, emoji, category, sort, added_at, hidden, features, faq, fixes)
    VALUES (${key}, ${name}, '🤖', 'other', 500, ${nowSec()}, 1, '[]', '[]', '[]')
    ON CONFLICT(key) DO NOTHING`);
  return r.rowsAffected > 0;
}

export async function deleteBot(key) {
  await db.run(sql`DELETE FROM bots WHERE key = ${key}`);
  await db.run(sql`DELETE FROM channels WHERE scope = ${key}`);
}

export async function bumpViews(key) {
  await db.run(sql`UPDATE bots SET views = views + 1 WHERE key = ${key}`);
}

// ---------- status ----------

export const STATUS = {
  ok: { emoji: '🟢', name: 'فعال' },
  degraded: { emoji: '🟡', name: 'اختلال' },
  maint: { emoji: '🔧', name: 'در حال تعمیر' },
  down: { emoji: '🔴', name: 'قطع' },
  slow: { emoji: '⏳', name: 'محدود' },
};

/**
 * What users see: the team's status and access mode first, then an open incident, then the automatic
 * health check. `incident` is the bot's open incident row (or null).
 */
export function effectiveStatus(bot, incident = null) {
  if (bot.mode === 'closed') return 'maint';
  if (bot.status && bot.status !== 'ok') return bot.status;
  if (incident) return 'degraded';
  if (bot.health === 'bad') return 'degraded';
  if (bot.mode === 'slow') return 'slow';
  return 'ok';
}

export const botLink = (bot, start = 'wanger') => (bot && bot.username ? `https://t.me/${bot.username}${start ? `?start=${start}` : ''}` : null);
export const botTitle = (bot) => `${bot.emoji || '🤖'} ${esc(bot.name)}`;

// ---------- search ----------

const STOP = new Set(normalize(`از به با که را رو این اون آن برای چطور چطوری چجوری چگونه میشه می شه میتونم می تونم من ما
  یک یه ی هست هستش است چی چیه چه کدوم کدام کجا رباتی ربات بات bot باید بخوام میخوام می خوام خواستم دارم داره کنم کنه کرد
  کردن کرد میکنه می کنه the a an to of for how can i in on is with my me what which و یا هم ها های تو توی در برا لطفا سلام`).split(' '));

// Words people use for the same thing; each group is searched as one.
const SYNONYMS = [
  'دانلود دانلودر download downloader دانلودی',
  'اینستا اینستاگرام instagram insta اینستگرام',
  'توییتر توئیتر twitter x توییت tweet',
  'آهنگ اهنگ موزیک موسیقی ترانه music song mp3',
  'بازی گیم game بازیا',
  'نجوا whisper پچ',
  'ناشناس anonymous anon',
  'گروه group گروهم',
  'کانال channel',
  'میم meme',
  'خبر اخبار news',
  'تودو todo کار کارها',
  'یوتیوب youtube',
  'تیک tiktok تیکتاک',
  'ویدیو فیلم video کلیپ',
  'عکس photo تصویر',
].map((g) => normalize(g).split(' '));

export function tokens(text) {
  const out = [];
  for (const w of normalize(text).split(' ')) {
    if (w.length < 2 || STOP.has(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

function expand(word) {
  for (const g of SYNONYMS) if (g.some((s) => s === word || (s.length >= 4 && word.startsWith(s)))) return g;
  return [word];
}

/** How well one query word matches a text's words: exact 1, a prefix either way (3+ letters) 0.7. */
function wordScore(word, words) {
  let best = 0;
  for (const alt of expand(word)) {
    for (const w of words) {
      if (w === alt) return 1;
      if (alt.length >= 3 && w.length >= 3 && (w.startsWith(alt) || alt.startsWith(w))) best = Math.max(best, 0.7);
    }
  }
  return best;
}

function fieldScore(qwords, text) {
  const words = normalize(text).split(' ').filter(Boolean);
  if (!words.length) return 0;
  let s = 0;
  for (const q of qwords) s += wordScore(q, words);
  return s;
}

/**
 * Ranks bots, features and FAQ entries against a question. Returns
 * { bots: [{ bot, score }], features: [{ bot, i, f, score }], faq: [{ bot, i, f, score }], words }.
 */
export function search(question, bots) {
  const words = tokens(question);
  const out = { bots: [], features: [], faq: [], words };
  if (!words.length) return out;
  for (const bot of bots) {
    const cat = categoryOf(bot.category);
    let score = fieldScore(words, `${bot.name} ${bot.username || ''} ${bot.key}`) * 5
      + fieldScore(words, bot.keywords || '') * 3
      + fieldScore(words, cat.name) * 2
      + fieldScore(words, `${bot.short || ''} ${bot.description || ''}`);
    bot.features.forEach((f, i) => {
      const s = fieldScore(words, `${f.t} ${f.k || ''}`) * 2 + fieldScore(words, f.h || '') * 0.5;
      if (s > 0) out.features.push({ bot, i, f, score: s });
      score += s * 0.5;
    });
    bot.faq.forEach((f, i) => {
      const s = fieldScore(words, `${f.q} ${f.k || ''}`) * 2;
      if (s > 0) out.faq.push({ bot, i, f, score: s });
    });
    if (score > 0) out.bots.push({ bot, score });
  }
  const byScore = (a, b) => b.score - a.score;
  out.bots.sort(byScore);
  out.features.sort(byScore);
  out.faq.sort(byScore);
  return out;
}

/** The best troubleshooting entries of a bot for a report text. */
export function matchFixes(text, bot) {
  const words = tokens(text);
  if (!words.length || !bot) return [];
  return bot.fixes
    .map((f) => ({ f, score: fieldScore(words, `${f.p} ${f.k || ''}`) }))
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => x.f);
}

// ---------- the line format the team edits lists in ----------

/** "title | how | keywords" per line → [{ t, h, k }] (for faq: q, a, k; fixes: p, s, k). */
export function parseLines(text, kind) {
  const names = { features: ['t', 'h', 'k'], faq: ['q', 'a', 'k'], fixes: ['p', 's', 'k'] }[kind];
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    const item = { [names[0]]: parts[0].slice(0, 120), [names[1]]: parts[1].slice(0, 600) };
    if (parts[2]) item[names[2]] = parts.slice(2).join(' ').slice(0, 200);
    out.push(item);
    if (out.length >= 25) break;
  }
  return out;
}

export function formatLines(items, kind) {
  const names = { features: ['t', 'h', 'k'], faq: ['q', 'a', 'k'], fixes: ['p', 's', 'k'] }[kind];
  return items.map((x) => [x[names[0]], x[names[1]], x[names[2]]].filter(Boolean).join(' | ')).join('\n');
}
