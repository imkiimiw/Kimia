import { MAX_CATEGORY_LEN } from './config.js';
import { normalizeInput, parseWhen } from './time.js';
import { utf8Length } from './utf8.js';

// \u200c (ZWNJ, "نیم‌فاصله") is part of ordinary Persian words such as خانه‌داری.
export const CATEGORY_RE = /^[\p{L}\p{M}\p{N}_ \-\u200c]+$/u;

// Category names end up in callback_data (64 bytes max, e.g. "L|c<name>|12"), so cap the UTF-8 size too.
const MAX_CATEGORY_BYTES = 40;

export function cleanCategory(raw) {
  const name = String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\u200c]+|[\s\u200c]+$/g, '');
  if (!name || !CATEGORY_RE.test(name) || Array.from(name).length > MAX_CATEGORY_LEN) return null;
  if (utf8Length(name) > MAX_CATEGORY_BYTES) return null;
  return name;
}

/**
 * "خرید نان #خانه !1 @فردا 18:00" -> { text: 'خرید نان', category: 'خانه', priority: 1, due: { ts, hasTime } }
 * Tokens that don't parse (e.g. "@ali") are left in the text.
 */
export function parseQuickAdd(input, now) {
  let s = ` ${input} `;
  let priority = 2;
  let category = null;
  let due = null;

  s = s.replace(/(\s)!([1-3۱-۳])(?=\s)/g, (_, pre, d) => {
    priority = Number(normalizeInput(d));
    return pre;
  });

  s = s.replace(/(\s)#([\p{L}\p{M}\p{N}_\u200c]+)(?=\s)/gu, (whole, pre, name) => {
    if (category) return whole;
    const c = cleanCategory(name.replace(/_/g, ' '));
    if (!c) return whole;
    category = c;
    return pre;
  });

  const at = s.match(/\s@(?=\S)/);
  if (at) {
    const start = at.index + 1;
    const words = s.slice(start + 1).trim().split(/\s+/);
    for (let k = Math.min(words.length, 6); k >= 1; k -= 1) {
      const r = parseWhen(words.slice(0, k).join(' '), now, { defaultHour: 23, defaultMinute: 59 });
      if (r) {
        due = r;
        s = `${s.slice(0, start)} ${words.slice(k).join(' ')}`;
        break;
      }
    }
  }

  return { text: s.replace(/\s+/g, ' ').trim(), priority, category, due };
}
