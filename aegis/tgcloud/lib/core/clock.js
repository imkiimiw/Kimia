/*
 * Times of day in a chat's time zone, without Intl (the isolate has none). Pure.
 * A time zone is a fixed offset from UTC in minutes (no daylight saving: Telegram Serverless has no
 * time-zone database); TZ_OFFSETS are the ones offered. Times of day are minutes after midnight.
 */
import { asciiDigits } from './duration.js';

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
