/*
 * Durations typed by people, in any of our languages: "30m", "2h", "1d", "1w", "45 دقیقه",
 * "۲ ساعت", "1 day", "3 дня", "2 jours", "30分钟", and "forever" words. Pure: no platform calls.
 * parseDuration(tokens) reads from the start of a token list and gives { sec, used } (sec 0 means
 * forever; used = how many tokens it took) or null when the first token isn't a duration.
 */
import { MAX_DURATION_SEC, MIN_DURATION_SEC } from '../config.js';

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
