// Due dates: Jalali <-> Gregorian conversion, parsing what users type, and "today" in Tehran.
// Dates are kept as Gregorian 'YYYY-MM-DD' strings, which compare correctly as text.
import { TZ_OFFSET_MIN } from './config.js';
import { asciiDigits, fa } from './text.js';

// ---------- Jalali calendar (the jalaali-js algorithm, after Borkowski) ----------

const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
const div = (a, b) => ~~(a / b);
const mod = (a, b) => a - ~~(a / b) * b;

function jalCal(jy) {
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  let jump = 0;
  for (let i = 1; i < BREAKS.length; i += 1) {
    const jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

// Gregorian date <-> Julian day number.
function g2d(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j += div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

export function toGregorian(jy, jm, jd) {
  const r = jalCal(jy);
  return d2g(g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1);
}

export function toJalali(gy, gm, gd) {
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

export function jalaliMonthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return jalCal(jy).leap === 0 ? 30 : 29;
}

// ---------- ISO date strings ----------

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function parseIso(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

/** Today's date in Tehran, as YYYY-MM-DD. */
export function today(nowMs = Date.now()) {
  const t = new Date(nowMs + TZ_OFFSET_MIN * 60000);
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function addDays(isoDate, days) {
  const { y, m, d } = parseIso(isoDate);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** A stored date shown in the Jalali calendar with Persian digits, e.g. ۱۴۰۵/۰۸/۱۰. */
export function formatJalali(isoDate) {
  const { y, m, d } = parseIso(isoDate);
  const j = toJalali(y, m, d);
  return fa(`${j.jy}/${pad(j.jm)}/${pad(j.jd)}`);
}

/** Unix seconds to the Tehran date, YYYY-MM-DD. */
export function dateOf(unixSec) {
  return today(unixSec * 1000);
}

/**
 * What the user typed as a due date -> YYYY-MM-DD, or null if it isn't a real date.
 * Jalali: 1405/08/10, 1405-8-10. Gregorian: 2026-11-01, 2026/11/01. Persian digits are fine,
 * and so are the words امروز / فردا / پس‌فردا.
 */
export function parseDate(input, nowMs = Date.now()) {
  const s = asciiDigits(input).trim().replace(/‌/g, '').replace(/\s+/g, '');
  if (s === 'امروز') return today(nowMs);
  if (s === 'فردا') return addDays(today(nowMs), 1);
  if (s === 'پسفردا') return addDays(today(nowMs), 2);

  const m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;

  if (y >= 1300 && y <= 1500) {
    if (d > jalaliMonthLength(y, mo)) return null;
    const g = toGregorian(y, mo, d);
    return iso(g.gy, g.gm, g.gd);
  }
  if (y >= 1921 && y <= 2121) {
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (d > daysInMonth) return null;
    return iso(y, mo, d);
  }
  return null;
}
