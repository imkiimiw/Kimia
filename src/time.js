import { DEFAULT_TZ_OFFSET_MINUTES } from './config.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

let offsetMs = DEFAULT_TZ_OFFSET_MINUTES * MINUTE;

export function setTzOffset(minutes) {
  if (Number.isFinite(Number(minutes))) offsetMs = Number(minutes) * MINUTE;
}

// ---------- local (bot timezone) calendar helpers ----------

export function localParts(ts) {
  const d = new Date(ts + offsetMs);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    dow: d.getUTCDay(), // 0 = Sunday
  };
}

export function fromLocal(y, m, d, hh = 0, mm = 0) {
  return Date.UTC(y, m - 1, d, hh, mm) - offsetMs;
}

export function startOfLocalDay(ts) {
  const p = localParts(ts);
  return fromLocal(p.y, p.m, p.d);
}

export function localDateKey(ts) {
  const p = localParts(ts);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// ---------- Jalali (Persian) calendar, after the jalaali-js algorithm ----------

const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
const div = (a, b) => ~~(a / b);
const mod = (a, b) => a - ~~(a / b) * b;

function jalCal(jy) {
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  let jump = 0;
  if (jy < jp || jy >= BREAKS[BREAKS.length - 1]) throw new RangeError(`Invalid Jalali year ${jy}`);
  for (let i = 1; i < BREAKS.length; i += 1) {
    const jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

export function g2j(gy, gm, gd) {
  const jdn = g2d(gy, gm, gd);
  let jy = d2g(jdn).gy - 621;
  const r = jalCal(jy);
  let k = jdn - g2d(r.gy, 3, r.march);
  if (k >= 0) {
    if (k <= 185) return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

export function j2g(jy, jm, jd) {
  const r = jalCal(jy);
  return d2g(g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1);
}

export function jalaliMonthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return jalCal(jy).leap === 0 ? 30 : 29;
}

export function toJalali(ts) {
  const p = localParts(ts);
  return { ...g2j(p.y, p.m, p.d), hh: p.hh, mm: p.mm, dow: p.dow };
}

// ---------- formatting ----------

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export const fa = (v) => String(v).replace(/\d/g, (d) => FA_DIGITS[d]);

export const WEEKDAYS = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];
export const JMONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

const pad2 = (n) => String(n).padStart(2, '0');

export function formatTime(ts) {
  const p = localParts(ts);
  return fa(`${pad2(p.hh)}:${pad2(p.mm)}`);
}

export function formatDate(ts, { time = true, now = Date.now() } = {}) {
  const j = toJalali(ts);
  const year = j.jy === toJalali(now).jy ? '' : ` ${fa(j.jy)}`;
  let out = `${WEEKDAYS[j.dow]} ${fa(j.jd)} ${JMONTHS[j.jm - 1]}${year}`;
  if (time) out += `، ساعت ${formatTime(ts)}`;
  return out;
}

export function formatShortDate(ts) {
  const j = toJalali(ts);
  return fa(`${j.jy}/${pad2(j.jm)}/${pad2(j.jd)}`);
}

export function relativeDay(ts, now = Date.now()) {
  const diff = Math.round((startOfLocalDay(ts) - startOfLocalDay(now)) / DAY);
  if (diff === 0) return 'امروز';
  if (diff === 1) return 'فردا';
  if (diff === 2) return 'پس‌فردا';
  if (diff === -1) return 'دیروز';
  return diff > 0 ? `${fa(diff)} روز دیگر` : `${fa(-diff)} روز پیش`;
}

// ---------- parsing user-typed dates and times ----------

export function toLatinDigits(s) {
  return String(s || '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

export function normalizeInput(s) {
  return toLatinDigits(s)
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[‌‏‎]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const DAY_WORDS = {
  'امروز': 0, today: 0,
  'فردا': 1, tomorrow: 1,
  'پسفردا': 2,
  'هفتهبعد': 7, 'هفتهدیگر': 7, 'هفتهدیگه': 7, 'هفتهآینده': 7, nextweek: 7,
};

const WEEKDAY_WORDS = {
  'یکشنبه': 0, 'دوشنبه': 1, 'سهشنبه': 2, 'چهارشنبه': 3, 'پنجشنبه': 4, 'جمعه': 5, 'شنبه': 6,
};

const UNIT_MS = [
  [/^(m|min|mins|minute|minutes|دقیقه)$/, MINUTE],
  [/^(h|hr|hrs|hour|hours|ساعت)$/, HOUR],
  [/^(d|day|days|روز)$/, DAY],
  [/^(w|week|weeks|هفته)$/, 7 * DAY],
];

function validLocal(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Parses things like "فردا"، "فردا ساعت 9"، "18:30"، "1405/08/02 10:00"، "2026-11-01"،
 * "+3"، "30 دقیقه دیگر"، "2h"، "شنبه". Returns { ts, hasTime } or null.
 * Date-only input is placed at defaultHour:defaultMinute local time.
 */
export function parseWhen(raw, now = Date.now(), { defaultHour = 9, defaultMinute = 0 } = {}) {
  let s = normalizeInput(raw);
  if (!s) return null;

  // Relative offsets: "+30m", "30 دقیقه دیگر", "in 2h", "+3" (days).
  const rel = s.match(/^(?:\+|in\s+)?\s*(\d{1,4})\s*([a-z؀-ۿ]*)\s*(?:دیگر|دیگه|بعد|later)?$/);
  if (rel && (s.startsWith('+') || s.startsWith('in ') || rel[2])) {
    const n = Number(rel[1]);
    const unit = rel[2] || 'd';
    const found = UNIT_MS.find(([re]) => re.test(unit));
    if (found) {
      const ms = found[1];
      if (ms < DAY) return { ts: now + n * ms, hasTime: true };
      const p = localParts(now + n * ms);
      return { ts: fromLocal(p.y, p.m, p.d, defaultHour, defaultMinute), hasTime: false };
    }
  }

  // Time of day.
  let hh = null;
  let mm = 0;
  const timeMatch =
    s.match(/(?:ساعت\s*)?(\d{1,2}):(\d{2})/) ||
    s.match(/(?:ساعت|at)\s*(\d{1,2})(?!\d|\/|-)/) ||
    s.match(/(?<![\d/\-.])(\d{1,2})\s*(?=صبح|ظهر|عصر|شب|بعد ?از ?ظهر|am|pm)/);
  if (timeMatch) {
    hh = Number(timeMatch[1]);
    mm = timeMatch[2] ? Number(timeMatch[2]) : 0;
    s = (s.slice(0, timeMatch.index) + ' ' + s.slice(timeMatch.index + timeMatch[0].length)).trim();
  }
  if (hh !== null) {
    if (/(بعد ?از ?ظهر|عصر|شب|pm)/.test(s) && hh >= 1 && hh < 12) hh += 12;
    else if (/شب/.test(s) && hh === 12) hh = 0;
    else if (/ظهر/.test(s) && hh >= 1 && hh <= 5) hh += 12;
  }
  s = s.replace(/(بعد ?از ?ظهر|عصر|شب|ظهر|صبح|pm|am)/g, ' ').replace(/\s+/g, ' ').trim();
  if (hh !== null && (hh > 23 || mm > 59)) return null;

  const today = localParts(now);
  let date = null; // {y, m, d} Gregorian local

  if (!s) {
    if (hh === null) return null;
    let ts = fromLocal(today.y, today.m, today.d, hh, mm);
    if (ts <= now) ts += DAY;
    return { ts, hasTime: true };
  }

  const key = s.replace(/\s+/g, '');
  if (key in DAY_WORDS) {
    const p = localParts(now + DAY_WORDS[key] * DAY);
    date = { y: p.y, m: p.m, d: p.d };
  } else if (key in WEEKDAY_WORDS) {
    let ahead = (WEEKDAY_WORDS[key] - today.dow + 7) % 7;
    if (ahead === 0) ahead = 7;
    const p = localParts(now + ahead * DAY);
    date = { y: p.y, m: p.m, d: p.d };
  } else {
    let m3 = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
    const m2 = s.match(/^(\d{1,2})[/\-.](\d{1,2})$/);
    if (!m3 && m2) {
      // Month/day in the current Jalali year (or next year if already past).
      const tj = g2j(today.y, today.m, today.d);
      let jy = tj.jy;
      const jm = Number(m2[1]);
      const jd = Number(m2[2]);
      if (jm < tj.jm || (jm === tj.jm && jd < tj.jd)) jy += 1;
      m3 = [null, String(jy), m2[1], m2[2]];
    }
    if (!m3) return null;
    const y = Number(m3[1]);
    const mo = Number(m3[2]);
    const d = Number(m3[3]);
    if (y >= 1900 && y <= 2200) {
      if (!validLocal(y, mo, d)) return null;
      date = { y, m: mo, d };
    } else if (y >= 1300 && y <= 1600) {
      if (mo < 1 || mo > 12 || d < 1 || d > jalaliMonthLength(y, mo)) return null;
      const g = j2g(y, mo, d);
      date = { y: g.gy, m: g.gm, d: g.gd };
    } else {
      return null;
    }
  }

  if (hh === null) return { ts: fromLocal(date.y, date.m, date.d, defaultHour, defaultMinute), hasTime: false };
  return { ts: fromLocal(date.y, date.m, date.d, hh, mm), hasTime: true };
}

// ---------- recurrence ----------

export const REPEAT_LABELS = { d: 'روزانه', w: 'هفتگی', m: 'ماهانه' };

export function addRepeat(ts, repeat) {
  if (repeat === 'd') return ts + DAY;
  if (repeat === 'w') return ts + 7 * DAY;
  if (repeat === 'm') {
    const p = localParts(ts);
    const j = g2j(p.y, p.m, p.d);
    let jy = j.jy;
    let jm = j.jm + 1;
    if (jm > 12) {
      jm = 1;
      jy += 1;
    }
    const g = j2g(jy, jm, Math.min(j.jd, jalaliMonthLength(jy, jm)));
    return fromLocal(g.gy, g.gm, g.gd, p.hh, p.mm);
  }
  return ts;
}

/** Next occurrence strictly after `after`, starting from `ts`. */
export function nextOccurrence(ts, repeat, after) {
  let next = addRepeat(ts, repeat);
  for (let i = 0; next <= after && i < 2000; i += 1) next = addRepeat(next, repeat);
  return next;
}
