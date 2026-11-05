// Parses an inline query into a whisper:
//   [!]text @user [@user2 @user3] [30m|1h|2d]   — recipients/expiry at the end (any order), or
//   @user [...] text                             — recipients at the start.
// Recipients are @usernames or numeric ids; "!" at the start makes it one-time.
// Returns { empty } | { error, ... } | { text, once, expiry, recipients: [{ id } | { username }] }.
import { MAX_EXPIRY_SEC, MAX_RECIPIENTS } from './config.js';
import { toAsciiDigits } from './util.js';

const USERNAME = /^@([A-Za-z][A-Za-z0-9_]{3,31})$/;
const NUMERIC_ID = /^[1-9][0-9]{4,15}$/;
const EXPIRY = /^([0-9]{1,5})(m|min|h|d)$/i;
const UNIT_SEC = { m: 60, min: 60, h: 3600, d: 86400 };

function recipientOf(token) {
  const t = toAsciiDigits(token);
  const u = USERNAME.exec(t);
  if (u) return { username: u[1] };
  if (NUMERIC_ID.test(t)) return { id: Number(t) };
  return null;
}

/** Expiry token → seconds; null if it isn't one; -1 if it is out of range. */
export function expiryOf(token) {
  const m = EXPIRY.exec(toAsciiDigits(token));
  if (!m) return null;
  const sec = Number(m[1]) * UNIT_SEC[m[2].toLowerCase()];
  return sec >= 60 && sec <= MAX_EXPIRY_SEC ? sec : -1;
}

const key = (r) => (r.id ? `#${r.id}` : `@${r.username.toLowerCase()}`);

export function parseQuery(raw) {
  const query = String(raw || '');
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(query))) tokens.push({ t: m[0], start: m.index, end: m.index + m[0].length });
  if (!tokens.length) return { empty: true };

  let first = 0;
  let last = tokens.length - 1;
  const recipients = [];
  let expiry = null;

  // Trailing recipients / expiry, in any order.
  while (last >= first) {
    const tok = tokens[last].t;
    const r = recipientOf(tok);
    if (r) {
      recipients.unshift(r);
      last -= 1;
      continue;
    }
    const e = expiryOf(tok);
    if (e !== null && expiry === null) {
      if (e < 0) return { error: 'bad_expiry' };
      expiry = e;
      last -= 1;
      continue;
    }
    break;
  }
  // Otherwise, leading recipients.
  if (!recipients.length) {
    while (first <= last) {
      const r = recipientOf(tokens[first].t);
      if (!r) break;
      recipients.push(r);
      first += 1;
    }
  }

  let text = first <= last ? query.slice(tokens[first].start, tokens[last].end) : '';
  let once = false;
  if (text.startsWith('!')) {
    once = true;
    text = text.slice(1).trim();
  }

  const unique = [];
  const seen = new Set();
  for (const r of recipients) {
    if (seen.has(key(r))) continue;
    seen.add(key(r));
    unique.push(r);
  }
  if (unique.length > MAX_RECIPIENTS) return { error: 'too_many', count: unique.length };
  if (!text) return { error: 'no_text', recipients: unique, once, expiry };
  return { text, once, expiry, recipients: unique };
}
