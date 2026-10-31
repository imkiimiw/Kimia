/*
 * Times of day in a chat's time zone, without Intl (the isolate has none). Pure.
 * A time zone is a fixed offset from UTC in minutes (no daylight saving: Telegram Serverless has no
 * time-zone database); TZ_OFFSETS are the ones offered. Times of day are minutes after midnight.
 */
import { MAX_DURATION_SEC, MIN_DURATION_SEC } from '../config.js';

export const TZ_OFFSETS = [-480, -420, -360, -300, -240, -180, 0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 420, 480, 540, 570, 600, 660, 720];
const BY_LANG = { fa: 210, ru: 180, zh: 480, fr: 60, en: 0 };

export const defaultTz = (lang) => BY_LANG[lang] ?? 0;
export const tzOf = (setting, lang) => (setting === 'auto' || setting === undefined ? defaultTz(lang) : Number(setting));

export function tzLabel(min) {
  const m = Math.abs(Number(min));
  return `UTC${Number(min) < 0 ? '−' : '+'}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export const fmtTime = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/* Minutes after local midnight at unix second `now`. */
export const localMinutes = (now, tz) => (((Math.floor(now / 60) + Number(tz)) % 1440) + 1440) % 1440;

/* "3:00, 15:30" / «۳:۰۰ و ۱۵» → { times } (sorted, unique) or { error: empty | format | too_many }. */
export function parseTimes(text, max = 5) {
  const parts = asciiDigits(String(text || '')).split(/[\s,،;،و]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { error: 'empty' };
  const times = new Set();
  for (const p of parts) {
    const m = /^(\d{1,2})(?:[:.٫](\d{2}))?$/.exec(p);
    if (!m || Number(m[1]) > 23 || (m[2] && Number(m[2]) > 59)) return { error: 'format' };
    times.add(Number(m[1]) * 60 + Number(m[2] || 0));
  }
  if (times.size > max) return { error: 'too_many' };
  return { times: [...times].sort((a, b) => a - b) };
}

/* The next unix second (after `now`) at which the local time is one of `times`. */
export function nextTime(times, now, tz) {
  const local = now + Number(tz) * 60;
  const midnight = now - (((local % 86400) + 86400) % 86400);
  let best = Infinity;
  for (const t of times) {
    let at = midnight + t * 60;
    if (at <= now) at += 86400;
    if (at < best) best = at;
  }
  return best === Infinity ? 0 : best;
}

/* Is the local minute inside [from, to)? Windows may cross midnight (22:00 → 07:00). */
export function inWindow(from, to, minute) {
  if (from === to) return false;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/* ========== merged from core/duration.js ========== */
/*
 * Durations typed by people, in any of our languages: "30m", "2h", "1d", "1w", "45 دقیقه",
 * "۲ ساعت", "1 day", "3 дня", "2 jours", "30分钟", and "forever" words. Pure: no platform calls.
 * parseDuration(tokens) reads from the start of a token list and gives { sec, used } (sec 0 means
 * forever; used = how many tokens it took) or null when the first token isn't a duration.
 */
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
const WEEK = 7 * DAY;
const UNITS = new Map([
  ...['m', 'min', 'mins', 'minute', 'minutes', 'دقیقه', 'мин', 'минута', 'минуты', 'минут', '分钟', '分'].map((u) => [u, MIN]),
  ...['h', 'hr', 'hrs', 'hour', 'hours', 'ساعت', 'ч', 'час', 'часа', 'часов', '小时', '时', 'heure', 'heures'].map((u) => [u, HOUR]),
  ...['d', 'day', 'days', 'روز', 'д', 'день', 'дня', 'дней', '天', 'j', 'jour', 'jours'].map((u) => [u, DAY]),
  ...['w', 'week', 'weeks', 'هفته', 'нед', 'неделя', 'недели', 'недель', '周', '星期', 'sem', 'semaine', 'semaines'].map((u) => [u, WEEK]),
]);
const FOREVER = new Set(['forever', 'permanent', 'perm', 'دائم', 'همیشه', 'برایهمیشه', 'навсегда', '永久', 'toujours', 'définitif']);

export function asciiDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

const clean = (t) => asciiDigits(String(t || '')).replace(/[\u200C\u200F\u200E]/g, '').toLowerCase();

function clamp(sec) {
  if (sec < MIN_DURATION_SEC || sec > MAX_DURATION_SEC) return null;
  return sec;
}

export function parseDuration(tokens) {
  const a = clean(tokens[0]);
  if (!a) return null;
  if (FOREVER.has(a)) return { sec: 0, used: 1 };
  let m = /^(\d{1,4})([^\d\s]+)$/.exec(a);
  if (m && UNITS.has(m[2])) {
    const sec = clamp(Number(m[1]) * UNITS.get(m[2]));
    return sec === null ? { sec: null, used: 1, invalid: true } : { sec, used: 1 };
  }
  m = /^(\d{1,4})$/.exec(a);
  const unit = clean(tokens[1]);
  if (m && UNITS.has(unit)) {
    const sec = clamp(Number(m[1]) * UNITS.get(unit));
    return sec === null ? { sec: null, used: 2, invalid: true } : { sec, used: 2 };
  }
  return null;
}

/* A whole string as one duration ("1d", "2 ساعت", "forever"), or null. */
export function durationOf(text) {
  const tokens = String(text || '').trim().split(/\s+/);
  const r = parseDuration(tokens);
  if (!r || r.invalid || r.used !== tokens.length) return null;
  return r.sec;
}
