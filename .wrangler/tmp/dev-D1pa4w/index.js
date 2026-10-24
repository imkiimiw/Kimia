var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/config.js
var DEFAULT_OWNER_ID = 5557901897;
var MAX_CHANNELS = 10;
var DEFAULT_CHANNELS = ["@HIDE_i_SEEK", "@Nepenthw_ir", "@wangerBots"];
var DEFAULT_TZ_OFFSET_MINUTES = 210;
var PAGE_SIZE = 8;
var MAX_TASK_LEN = 300;
var MAX_NOTE_LEN = 1e3;
var MAX_CATEGORY_LEN = 20;
var CRON_BUDGET = { reminders: 20, digests: 10, broadcast: 15 };
var JOIN_CACHE_MS = 6e4;
function ownerId(env) {
  return Number(env.OWNER_ID || DEFAULT_OWNER_ID);
}
__name(ownerId, "ownerId");

// src/time.js
var MINUTE = 6e4;
var HOUR = 60 * MINUTE;
var DAY = 24 * HOUR;
var offsetMs = DEFAULT_TZ_OFFSET_MINUTES * MINUTE;
function setTzOffset(minutes) {
  if (Number.isFinite(Number(minutes))) offsetMs = Number(minutes) * MINUTE;
}
__name(setTzOffset, "setTzOffset");
function localParts(ts) {
  const d = new Date(ts + offsetMs);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    dow: d.getUTCDay()
    // 0 = Sunday
  };
}
__name(localParts, "localParts");
function fromLocal(y, m, d, hh = 0, mm = 0) {
  return Date.UTC(y, m - 1, d, hh, mm) - offsetMs;
}
__name(fromLocal, "fromLocal");
function startOfLocalDay(ts) {
  const p = localParts(ts);
  return fromLocal(p.y, p.m, p.d);
}
__name(startOfLocalDay, "startOfLocalDay");
function localDateKey(ts) {
  const p = localParts(ts);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
__name(localDateKey, "localDateKey");
var BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
var div = /* @__PURE__ */ __name((a, b) => ~~(a / b), "div");
var mod = /* @__PURE__ */ __name((a, b) => a - ~~(a / b) * b, "mod");
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
__name(jalCal, "jalCal");
function g2d(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}
__name(g2d, "g2d");
function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}
__name(d2g, "d2g");
function g2j(gy, gm, gd) {
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
__name(g2j, "g2j");
function j2g(jy, jm, jd) {
  const r = jalCal(jy);
  return d2g(g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1);
}
__name(j2g, "j2g");
function jalaliMonthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return jalCal(jy).leap === 0 ? 30 : 29;
}
__name(jalaliMonthLength, "jalaliMonthLength");
function toJalali(ts) {
  const p = localParts(ts);
  return { ...g2j(p.y, p.m, p.d), hh: p.hh, mm: p.mm, dow: p.dow };
}
__name(toJalali, "toJalali");
var FA_DIGITS = "\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9";
var fa = /* @__PURE__ */ __name((v) => String(v).replace(/\d/g, (d) => FA_DIGITS[d]), "fa");
var WEEKDAYS = ["\u06CC\u06A9\u0634\u0646\u0628\u0647", "\u062F\u0648\u0634\u0646\u0628\u0647", "\u0633\u0647\u200C\u0634\u0646\u0628\u0647", "\u0686\u0647\u0627\u0631\u0634\u0646\u0628\u0647", "\u067E\u0646\u062C\u0634\u0646\u0628\u0647", "\u062C\u0645\u0639\u0647", "\u0634\u0646\u0628\u0647"];
var JMONTHS = ["\u0641\u0631\u0648\u0631\u062F\u06CC\u0646", "\u0627\u0631\u062F\u06CC\u0628\u0647\u0634\u062A", "\u062E\u0631\u062F\u0627\u062F", "\u062A\u06CC\u0631", "\u0645\u0631\u062F\u0627\u062F", "\u0634\u0647\u0631\u06CC\u0648\u0631", "\u0645\u0647\u0631", "\u0622\u0628\u0627\u0646", "\u0622\u0630\u0631", "\u062F\u06CC", "\u0628\u0647\u0645\u0646", "\u0627\u0633\u0641\u0646\u062F"];
var pad2 = /* @__PURE__ */ __name((n) => String(n).padStart(2, "0"), "pad2");
function formatTime(ts) {
  const p = localParts(ts);
  return fa(`${pad2(p.hh)}:${pad2(p.mm)}`);
}
__name(formatTime, "formatTime");
function formatDate(ts, { time = true, now = Date.now() } = {}) {
  const j = toJalali(ts);
  const year = j.jy === toJalali(now).jy ? "" : ` ${fa(j.jy)}`;
  let out = `${WEEKDAYS[j.dow]} ${fa(j.jd)} ${JMONTHS[j.jm - 1]}${year}`;
  if (time) out += `\u060C \u0633\u0627\u0639\u062A ${formatTime(ts)}`;
  return out;
}
__name(formatDate, "formatDate");
function formatShortDate(ts) {
  const j = toJalali(ts);
  return fa(`${j.jy}/${pad2(j.jm)}/${pad2(j.jd)}`);
}
__name(formatShortDate, "formatShortDate");
function relativeDay(ts, now = Date.now()) {
  const diff = Math.round((startOfLocalDay(ts) - startOfLocalDay(now)) / DAY);
  if (diff === 0) return "\u0627\u0645\u0631\u0648\u0632";
  if (diff === 1) return "\u0641\u0631\u062F\u0627";
  if (diff === 2) return "\u067E\u0633\u200C\u0641\u0631\u062F\u0627";
  if (diff === -1) return "\u062F\u06CC\u0631\u0648\u0632";
  return diff > 0 ? `${fa(diff)} \u0631\u0648\u0632 \u062F\u06CC\u06AF\u0631` : `${fa(-diff)} \u0631\u0648\u0632 \u067E\u06CC\u0634`;
}
__name(relativeDay, "relativeDay");
function toLatinDigits(s) {
  return String(s || "").replace(/[۰-۹]/g, (d) => String("\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9".indexOf(d))).replace(/[٠-٩]/g, (d) => String("\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669".indexOf(d)));
}
__name(toLatinDigits, "toLatinDigits");
function normalizeInput(s) {
  return toLatinDigits(s).replace(/ي/g, "\u06CC").replace(/ك/g, "\u06A9").replace(/[‌‏‎]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}
__name(normalizeInput, "normalizeInput");
var DAY_WORDS = {
  "\u0627\u0645\u0631\u0648\u0632": 0,
  today: 0,
  "\u0641\u0631\u062F\u0627": 1,
  tomorrow: 1,
  "\u067E\u0633\u0641\u0631\u062F\u0627": 2,
  "\u0647\u0641\u062A\u0647\u0628\u0639\u062F": 7,
  "\u0647\u0641\u062A\u0647\u062F\u06CC\u06AF\u0631": 7,
  "\u0647\u0641\u062A\u0647\u062F\u06CC\u06AF\u0647": 7,
  "\u0647\u0641\u062A\u0647\u0622\u06CC\u0646\u062F\u0647": 7,
  nextweek: 7
};
var WEEKDAY_WORDS = {
  "\u06CC\u06A9\u0634\u0646\u0628\u0647": 0,
  "\u062F\u0648\u0634\u0646\u0628\u0647": 1,
  "\u0633\u0647\u0634\u0646\u0628\u0647": 2,
  "\u0686\u0647\u0627\u0631\u0634\u0646\u0628\u0647": 3,
  "\u067E\u0646\u062C\u0634\u0646\u0628\u0647": 4,
  "\u062C\u0645\u0639\u0647": 5,
  "\u0634\u0646\u0628\u0647": 6
};
var UNIT_MS = [
  [/^(m|min|mins|minute|minutes|دقیقه)$/, MINUTE],
  [/^(h|hr|hrs|hour|hours|ساعت)$/, HOUR],
  [/^(d|day|days|روز)$/, DAY],
  [/^(w|week|weeks|هفته)$/, 7 * DAY]
];
function validLocal(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
__name(validLocal, "validLocal");
function parseWhen(raw, now = Date.now(), { defaultHour = 9, defaultMinute = 0 } = {}) {
  let s = normalizeInput(raw);
  if (!s) return null;
  const rel = s.match(/^(?:\+|in\s+)?\s*(\d{1,4})\s*([a-z؀-ۿ]*)\s*(?:دیگر|دیگه|بعد|later)?$/);
  if (rel && (s.startsWith("+") || s.startsWith("in ") || rel[2])) {
    const n = Number(rel[1]);
    const unit = rel[2] || "d";
    const found = UNIT_MS.find(([re]) => re.test(unit));
    if (found) {
      const ms = found[1];
      if (ms < DAY) return { ts: now + n * ms, hasTime: true };
      const p = localParts(now + n * ms);
      return { ts: fromLocal(p.y, p.m, p.d, defaultHour, defaultMinute), hasTime: false };
    }
  }
  let hh = null;
  let mm = 0;
  const timeMatch = s.match(/(?:ساعت\s*)?(\d{1,2}):(\d{2})/) || s.match(/(?:ساعت|at)\s*(\d{1,2})(?!\d|\/|-)/) || s.match(/(?<![\d/\-.])(\d{1,2})\s*(?=صبح|ظهر|عصر|شب|بعد ?از ?ظهر|am|pm)/);
  if (timeMatch) {
    hh = Number(timeMatch[1]);
    mm = timeMatch[2] ? Number(timeMatch[2]) : 0;
    s = (s.slice(0, timeMatch.index) + " " + s.slice(timeMatch.index + timeMatch[0].length)).trim();
  }
  if (hh !== null) {
    if (/(بعد ?از ?ظهر|عصر|شب|pm)/.test(s) && hh >= 1 && hh < 12) hh += 12;
    else if (/شب/.test(s) && hh === 12) hh = 0;
    else if (/ظهر/.test(s) && hh >= 1 && hh <= 5) hh += 12;
  }
  s = s.replace(/(بعد ?از ?ظهر|عصر|شب|ظهر|صبح|pm|am)/g, " ").replace(/\s+/g, " ").trim();
  if (hh !== null && (hh > 23 || mm > 59)) return null;
  const today = localParts(now);
  let date = null;
  if (!s) {
    if (hh === null) return null;
    let ts = fromLocal(today.y, today.m, today.d, hh, mm);
    if (ts <= now) ts += DAY;
    return { ts, hasTime: true };
  }
  const key = s.replace(/\s+/g, "");
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
      const tj = g2j(today.y, today.m, today.d);
      let jy = tj.jy;
      const jm = Number(m2[1]);
      const jd = Number(m2[2]);
      if (jm < tj.jm || jm === tj.jm && jd < tj.jd) jy += 1;
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
__name(parseWhen, "parseWhen");
var REPEAT_LABELS = { d: "\u0631\u0648\u0632\u0627\u0646\u0647", w: "\u0647\u0641\u062A\u06AF\u06CC", m: "\u0645\u0627\u0647\u0627\u0646\u0647" };
function addRepeat(ts, repeat) {
  if (repeat === "d") return ts + DAY;
  if (repeat === "w") return ts + 7 * DAY;
  if (repeat === "m") {
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
__name(addRepeat, "addRepeat");
function nextOccurrence(ts, repeat, after) {
  let next = addRepeat(ts, repeat);
  for (let i = 0; next <= after && i < 2e3; i += 1) next = addRepeat(next, repeat);
  return next;
}
__name(nextOccurrence, "nextOccurrence");

// src/db.js
var SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    first_name TEXT,
    username TEXT,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    task_seq INTEGER NOT NULL DEFAULT 0,
    state TEXT,
    digest_hour INTEGER,
    digest_last TEXT,
    blocked INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    num INTEGER NOT NULL,
    text TEXT NOT NULL,
    note TEXT,
    priority INTEGER NOT NULL DEFAULT 2,
    category TEXT,
    due_at INTEGER,
    due_time INTEGER NOT NULL DEFAULT 0,
    remind_at INTEGER,
    repeat TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    done_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, num)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks (user_id, done)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_remind ON tasks (remind_at) WHERE remind_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat TEXT NOT NULL UNIQUE,
    title TEXT,
    link TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_chat INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    cursor INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',
    created_at INTEGER NOT NULL
  )`
];
var schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  const seeded = await db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('seeded', '1')`).run();
  if (seeded.meta.changes) {
    const now = Date.now();
    await db.batch(
      DEFAULT_CHANNELS.map(
        (chat) => db.prepare(`INSERT OR IGNORE INTO channels (chat, link, created_at) VALUES (?, ?, ?)`).bind(chat, `https://t.me/${chat.slice(1)}`, now)
      )
    );
  }
  schemaReady = true;
}
__name(ensureSchema, "ensureSchema");
async function touchUser(db, from, now) {
  const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(from.id).first();
  const name = from.first_name || "";
  const username = from.username || null;
  if (!user) {
    await db.prepare(`INSERT INTO users (id, first_name, username, created_at, last_seen) VALUES (?, ?, ?, ?, ?)`).bind(from.id, name, username, now, now).run();
    return { id: from.id, first_name: name, username, created_at: now, last_seen: now, task_seq: 0, state: null, digest_hour: null, digest_last: null, blocked: 0, isNew: true };
  }
  if (user.first_name !== name || user.username !== username || user.blocked || now - user.last_seen > 10 * 6e4) {
    await db.prepare(`UPDATE users SET first_name = ?, username = ?, last_seen = ?, blocked = 0 WHERE id = ?`).bind(name, username, now, from.id).run();
  }
  return user;
}
__name(touchUser, "touchUser");
function parseState(user) {
  try {
    return user.state ? JSON.parse(user.state) : null;
  } catch {
    return null;
  }
}
__name(parseState, "parseState");
function setState(db, userId, state) {
  return db.prepare(`UPDATE users SET state = ? WHERE id = ?`).bind(state ? JSON.stringify(state) : null, userId).run();
}
__name(setState, "setState");
function setDigest(db, userId, hour, lastKey) {
  return db.prepare(`UPDATE users SET digest_hour = ?, digest_last = ? WHERE id = ?`).bind(hour, lastKey, userId).run();
}
__name(setDigest, "setDigest");
function markBlocked(db, userId) {
  return db.prepare(`UPDATE users SET blocked = 1 WHERE id = ?`).bind(userId).run();
}
__name(markBlocked, "markBlocked");
var EDITABLE = /* @__PURE__ */ new Set(["text", "note", "priority", "category", "due_at", "due_time", "remind_at", "repeat", "done", "done_at"]);
async function addTask(db, userId, fields, now) {
  const seq = await db.prepare(`UPDATE users SET task_seq = task_seq + 1 WHERE id = ? RETURNING task_seq`).bind(userId).first();
  const num = seq.task_seq;
  await db.prepare(
    `INSERT INTO tasks (user_id, num, text, note, priority, category, due_at, due_time, remind_at, repeat, done, done_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    userId,
    num,
    fields.text,
    fields.note ?? null,
    fields.priority ?? 2,
    fields.category ?? null,
    fields.due_at ?? null,
    fields.due_time ?? 0,
    fields.remind_at ?? null,
    fields.repeat ?? null,
    fields.done ?? 0,
    fields.done_at ?? null,
    now
  ).run();
  return getTask(db, userId, num);
}
__name(addTask, "addTask");
function getTask(db, userId, num) {
  return db.prepare(`SELECT * FROM tasks WHERE user_id = ? AND num = ?`).bind(userId, num).first();
}
__name(getTask, "getTask");
function updateTask(db, userId, num, fields) {
  const keys = Object.keys(fields).filter((k) => EDITABLE.has(k));
  if (!keys.length) return null;
  return db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE user_id = ? AND num = ?`).bind(...keys.map((k) => fields[k] ?? null), userId, num).run();
}
__name(updateTask, "updateTask");
function deleteTask(db, userId, num) {
  return db.prepare(`DELETE FROM tasks WHERE user_id = ? AND num = ?`).bind(userId, num).run();
}
__name(deleteTask, "deleteTask");
var PENDING_ORDER = `priority ASC, due_at IS NULL, due_at ASC, num ASC`;
function filterSql(filter, now) {
  if (filter === "d") return { where: `done = 1`, order: `done_at DESC`, args: [] };
  if (filter === "t") return { where: `done = 0 AND due_at IS NOT NULL AND due_at < ?`, order: `due_at ASC, priority ASC`, args: [startOfLocalDay(now) + DAY] };
  if (filter === "a") return { where: `1 = 1`, order: `done ASC, ${PENDING_ORDER}`, args: [] };
  if (filter.startsWith("c")) return { where: `category = ?`, order: `done ASC, ${PENDING_ORDER}`, args: [filter.slice(1)] };
  return { where: `done = 0`, order: PENDING_ORDER, args: [] };
}
__name(filterSql, "filterSql");
async function listTasks(db, userId, filter, page, now) {
  const f = filterSql(filter, now);
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND ${f.where}`).bind(userId, ...f.args),
    db.prepare(`SELECT * FROM tasks WHERE user_id = ? AND ${f.where} ORDER BY ${f.order} LIMIT ? OFFSET ?`).bind(userId, ...f.args, PAGE_SIZE, page * PAGE_SIZE)
  ]);
  return { total: count.results[0].n, rows: rows.results };
}
__name(listTasks, "listTasks");
async function searchTasks(db, userId, query) {
  const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { results } = await db.prepare(
    `SELECT * FROM tasks WHERE user_id = ?1 AND (text LIKE ?2 ESCAPE '\\' OR note LIKE ?2 ESCAPE '\\' OR category LIKE ?2 ESCAPE '\\')
       ORDER BY done ASC, ${PENDING_ORDER} LIMIT 10`
  ).bind(userId, like).all();
  return results;
}
__name(searchTasks, "searchTasks");
async function listCategories(db, userId) {
  const { results } = await db.prepare(
    `SELECT category, SUM(done = 0) AS pending, COUNT(*) AS total FROM tasks
       WHERE user_id = ? AND category IS NOT NULL GROUP BY category ORDER BY pending DESC, category LIMIT 30`
  ).bind(userId).all();
  return results;
}
__name(listCategories, "listCategories");
async function userStats(db, userId, now) {
  const today = startOfLocalDay(now);
  const row = await db.prepare(
    `SELECT COUNT(*) AS total,
         COALESCE(SUM(done = 1), 0) AS done,
         COALESCE(SUM(done = 0), 0) AS pending,
         COALESCE(SUM(done = 0 AND due_at IS NOT NULL AND due_at < ?2), 0) AS overdue,
         COALESCE(SUM(done = 0 AND due_at >= ?3 AND due_at < ?4), 0) AS today,
         COALESCE(SUM(done = 1 AND done_at >= ?5), 0) AS week,
         COALESCE(SUM(done = 1 AND done_at >= ?3), 0) AS done_today,
         COALESCE(SUM(done = 0 AND priority = 1), 0) AS p1,
         COALESCE(SUM(done = 0 AND priority = 2), 0) AS p2,
         COALESCE(SUM(done = 0 AND priority = 3), 0) AS p3,
         COALESCE(SUM(done = 0 AND repeat IS NOT NULL), 0) AS recurring,
         COALESCE(SUM(done = 0 AND remind_at IS NOT NULL), 0) AS reminders
       FROM tasks WHERE user_id = ?1`
  ).bind(userId, now, today, today + DAY, now - 7 * DAY).first();
  return row;
}
__name(userStats, "userStats");
async function allTasks(db, userId) {
  const { results } = await db.prepare(`SELECT * FROM tasks WHERE user_id = ? ORDER BY done ASC, ${PENDING_ORDER}`).bind(userId).all();
  return results;
}
__name(allTasks, "allTasks");
function clearDone(db, userId) {
  return db.prepare(`DELETE FROM tasks WHERE user_id = ? AND done = 1`).bind(userId).run();
}
__name(clearDone, "clearDone");
async function listChannels(db) {
  const { results } = await db.prepare(`SELECT * FROM channels ORDER BY id`).all();
  return results;
}
__name(listChannels, "listChannels");
function addChannel(db, chat, title, link, now) {
  return db.prepare(`INSERT OR IGNORE INTO channels (chat, title, link, created_at) VALUES (?, ?, ?, ?)`).bind(chat, title, link, now).run();
}
__name(addChannel, "addChannel");
function removeChannel(db, id) {
  return db.prepare(`DELETE FROM channels WHERE id = ?`).bind(id).run();
}
__name(removeChannel, "removeChannel");
function getChannel(db, id) {
  return db.prepare(`SELECT * FROM channels WHERE id = ?`).bind(id).first();
}
__name(getChannel, "getChannel");
function setChannelTitle(db, id, title) {
  return db.prepare(`UPDATE channels SET title = ? WHERE id = ?`).bind(title, id).run();
}
__name(setChannelTitle, "setChannelTitle");
async function dueReminders(db, now, limit) {
  const { results } = await db.prepare(
    `SELECT t.* FROM tasks t JOIN users u ON u.id = t.user_id
       WHERE t.remind_at IS NOT NULL AND t.remind_at <= ? AND t.done = 0 AND u.blocked = 0
       ORDER BY t.remind_at LIMIT ?`
  ).bind(now, limit).all();
  return results;
}
__name(dueReminders, "dueReminders");
async function digestCandidates(db, hour, dateKey, limit) {
  const { results } = await db.prepare(
    `SELECT * FROM users WHERE digest_hour IS NOT NULL AND digest_hour <= ? AND (digest_last IS NULL OR digest_last <> ?) AND blocked = 0
       ORDER BY id LIMIT ?`
  ).bind(hour, dateKey, limit).all();
  return results;
}
__name(digestCandidates, "digestCandidates");
async function pendingForDigest(db, userId, now) {
  const end = startOfLocalDay(now) + DAY;
  const { results } = await db.prepare(
    `SELECT * FROM tasks WHERE user_id = ? AND done = 0
       ORDER BY (due_at IS NOT NULL AND due_at < ?) DESC, ${PENDING_ORDER} LIMIT 10`
  ).bind(userId, end).all();
  return results;
}
__name(pendingForDigest, "pendingForDigest");
function activeBroadcast(db) {
  return db.prepare(`SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id LIMIT 1`).first();
}
__name(activeBroadcast, "activeBroadcast");
function createBroadcast(db, fromChat, messageId, now) {
  return db.prepare(`INSERT INTO broadcasts (from_chat, message_id, created_at) VALUES (?, ?, ?)`).bind(fromChat, messageId, now).run();
}
__name(createBroadcast, "createBroadcast");
async function broadcastTargets(db, cursor, limit) {
  const { results } = await db.prepare(`SELECT id FROM users WHERE id > ? AND blocked = 0 ORDER BY id LIMIT ?`).bind(cursor, limit).all();
  return results.map((r) => r.id);
}
__name(broadcastTargets, "broadcastTargets");
function updateBroadcast(db, id, cursor, sent, failed, status) {
  return db.prepare(`UPDATE broadcasts SET cursor = ?, sent = sent + ?, failed = failed + ?, status = ? WHERE id = ?`).bind(cursor, sent, failed, status, id).run();
}
__name(updateBroadcast, "updateBroadcast");
function getBroadcast(db, id) {
  return db.prepare(`SELECT * FROM broadcasts WHERE id = ?`).bind(id).first();
}
__name(getBroadcast, "getBroadcast");
async function botStats(db, now) {
  const [u, t] = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS users, COALESCE(SUM(last_seen >= ?), 0) AS active_day, COALESCE(SUM(last_seen >= ?), 0) AS active_week,
           COALESCE(SUM(blocked = 1), 0) AS blocked, COALESCE(SUM(created_at >= ?), 0) AS new_day FROM users`
    ).bind(now - DAY, now - 7 * DAY, now - DAY),
    db.prepare(`SELECT COUNT(*) AS tasks, COALESCE(SUM(done = 1), 0) AS done FROM tasks`)
  ]);
  return { ...u.results[0], ...t.results[0] };
}
__name(botStats, "botStats");
async function countActiveUsers(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE blocked = 0`).first();
  return row.n;
}
__name(countActiveUsers, "countActiveUsers");

// src/ui.js
var ui_exports = {};
__export(ui_exports, {
  BTN: () => BTN,
  HELP_TEXT: () => HELP_TEXT,
  PRIORITY: () => PRIORITY,
  QUICK_ADD_HINT: () => QUICK_ADD_HINT,
  btn: () => btn,
  cancelKb: () => cancelKb,
  categoryKb: () => categoryKb,
  cb: () => cb,
  dueKb: () => dueKb,
  dueLabel: () => dueLabel,
  esc: () => esc,
  inline: () => inline,
  listView: () => listView,
  mainKeyboard: () => mainKeyboard,
  priorityKb: () => priorityKb,
  progressBar: () => progressBar,
  reminderKb: () => reminderKb,
  repeatKb: () => repeatKb,
  taskCard: () => taskCard,
  taskCardKb: () => taskCardKb,
  taskLine: () => taskLine,
  truncate: () => truncate,
  urlBtn: () => urlBtn
});
var esc = /* @__PURE__ */ __name((s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), "esc");
var truncate = /* @__PURE__ */ __name((s, n) => {
  const chars = Array.from(String(s));
  return chars.length > n ? chars.slice(0, n - 1).join("") + "\u2026" : String(s);
}, "truncate");
function cb(...parts) {
  const data = parts.join("|");
  if (new TextEncoder().encode(data).length <= 64) return data;
  return parts.slice(0, -1).join("|");
}
__name(cb, "cb");
var btn = /* @__PURE__ */ __name((text, data) => ({ text, callback_data: data }), "btn");
var urlBtn = /* @__PURE__ */ __name((text, url) => ({ text, url }), "urlBtn");
var inline = /* @__PURE__ */ __name((rows) => ({ inline_keyboard: rows.filter((r) => r.length) }), "inline");
var BTN = {
  add: "\u2795 \u06A9\u0627\u0631 \u062C\u062F\u06CC\u062F",
  list: "\u{1F4CB} \u06A9\u0627\u0631\u0647\u0627\u06CC \u0645\u0646",
  today: "\u{1F4C5} \u0627\u0645\u0631\u0648\u0632",
  search: "\u{1F50D} \u062C\u0633\u062A\u062C\u0648",
  cats: "\u{1F5C2} \u062F\u0633\u062A\u0647\u200C\u0647\u0627",
  stats: "\u{1F4CA} \u0622\u0645\u0627\u0631",
  settings: "\u2699\uFE0F \u062A\u0646\u0638\u06CC\u0645\u0627\u062A",
  help: "\u2753 \u0631\u0627\u0647\u0646\u0645\u0627",
  admin: "\u{1F451} \u067E\u0646\u0644 \u0645\u062F\u06CC\u0631\u06CC\u062A"
};
function mainKeyboard(isOwner) {
  const rows = [
    [BTN.add, BTN.list],
    [BTN.today, BTN.search],
    [BTN.cats, BTN.stats],
    [BTN.settings, BTN.help]
  ];
  if (isOwner) rows.push([BTN.admin]);
  return { keyboard: rows.map((r) => r.map((text) => ({ text }))), resize_keyboard: true, is_persistent: true };
}
__name(mainKeyboard, "mainKeyboard");
var cancelKb = inline([[btn("\u274C \u0644\u063A\u0648", "CX")]]);
var PRIORITY = {
  1: { icon: "\u{1F534}", label: "\u0628\u0627\u0644\u0627" },
  2: { icon: "\u{1F7E1}", label: "\u0645\u062A\u0648\u0633\u0637" },
  3: { icon: "\u{1F7E2}", label: "\u06A9\u0645" }
};
function dueLabel(t, now) {
  if (!t.due_at) return "";
  const time = t.due_time ? ` ${formatTime(t.due_at)}` : "";
  const late = !t.done && t.due_at < now ? "\u26A0\uFE0F " : "";
  return `${late}${relativeDay(t.due_at, now)}${time}`;
}
__name(dueLabel, "dueLabel");
function taskLine(t, now, maxLen = 120) {
  const icon = t.done ? "\u2705" : PRIORITY[t.priority].icon;
  const text = esc(truncate(t.text, maxLen));
  const title = t.done ? `<s>${text}</s>` : text;
  const meta = [];
  if (t.due_at) meta.push(`\u{1F4C5} ${dueLabel(t, now)}`);
  if (t.category) meta.push(`\u{1F5C2} ${esc(t.category)}`);
  if (t.remind_at && !t.done) meta.push("\u23F0");
  if (t.repeat) meta.push("\u{1F501}");
  if (t.note) meta.push("\u{1F4DD}");
  return `${icon} <b>${fa(t.num)}.</b> ${title}${meta.length ? `
      <i>${meta.join(" \xB7 ")}</i>` : ""}`;
}
__name(taskLine, "taskLine");
function taskCard(t, now) {
  const lines = [
    `${t.done ? "\u2705" : PRIORITY[t.priority].icon} <b>\u06A9\u0627\u0631 \u0634\u0645\u0627\u0631\u0647 ${fa(t.num)}</b>`,
    "",
    `<b>${esc(t.text)}</b>`,
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501",
    `\u{1F4CC} \u0648\u0636\u0639\u06CC\u062A: ${t.done ? `\u0627\u0646\u062C\u0627\u0645 \u0634\u062F\u0647 (${relativeDay(t.done_at, now)})` : "\u23F3 \u062F\u0631 \u062C\u0631\u06CC\u0627\u0646"}`,
    `\u{1F525} \u0627\u0648\u0644\u0648\u06CC\u062A: ${PRIORITY[t.priority].icon} ${PRIORITY[t.priority].label}`,
    `\u{1F5C2} \u062F\u0633\u062A\u0647: ${t.category ? esc(t.category) : "\u2014"}`,
    `\u{1F4C5} \u062F\u062F\u0644\u0627\u06CC\u0646: ${t.due_at ? `${formatDate(t.due_at, { time: !!t.due_time, now })} (${dueLabel(t, now)})` : "\u2014"}`,
    `\u23F0 \u06CC\u0627\u062F\u0622\u0648\u0631: ${t.remind_at && !t.done ? formatDate(t.remind_at, { now }) : "\u2014"}`,
    `\u{1F501} \u062A\u06A9\u0631\u0627\u0631: ${t.repeat ? REPEAT_LABELS[t.repeat] : "\u2014"}`
  ];
  if (t.note) lines.push("", `\u{1F4DD} <b>\u06CC\u0627\u062F\u062F\u0627\u0634\u062A:</b>
${esc(t.note)}`);
  lines.push("", `<i>\u{1F553} \u0627\u06CC\u062C\u0627\u062F: ${formatDate(t.created_at, { now })}</i>`);
  return lines.join("\n");
}
__name(taskCard, "taskCard");
function taskCardKb(t, ctx) {
  const n = t.num;
  return inline([
    [btn(t.done ? "\u21A9\uFE0F \u0628\u0631\u06AF\u0631\u062F\u0627\u0646\u062F\u0646 \u0628\u0647 \u062F\u0631 \u062C\u0631\u06CC\u0627\u0646" : "\u2705 \u0627\u0646\u062C\u0627\u0645 \u0634\u062F", cb("D", n, ctx)), btn("\u{1F5D1} \u062D\u0630\u0641", cb("X", n, ctx))],
    [btn("\u270F\uFE0F \u0648\u06CC\u0631\u0627\u06CC\u0634 \u0645\u062A\u0646", cb("E", n, "t", ctx)), btn("\u{1F4DD} \u06CC\u0627\u062F\u062F\u0627\u0634\u062A", cb("E", n, "n", ctx))],
    [btn("\u{1F525} \u0627\u0648\u0644\u0648\u06CC\u062A", cb("E", n, "p", ctx)), btn("\u{1F5C2} \u062F\u0633\u062A\u0647", cb("E", n, "c", ctx))],
    [btn("\u{1F4C5} \u062F\u062F\u0644\u0627\u06CC\u0646", cb("E", n, "d", ctx)), btn("\u23F0 \u06CC\u0627\u062F\u0622\u0648\u0631", cb("E", n, "r", ctx))],
    [btn("\u{1F501} \u062A\u06A9\u0631\u0627\u0631", cb("E", n, "R", ctx)), btn("\u{1F519} \u0628\u0627\u0632\u06AF\u0634\u062A \u0628\u0647 \u0644\u06CC\u0633\u062A", `L|${ctx.replace(".", "|")}`)]
  ]);
}
__name(taskCardKb, "taskCardKb");
var LIST_TITLES = {
  p: "\u{1F4CB} <b>\u06A9\u0627\u0631\u0647\u0627\u06CC \u062F\u0631 \u062C\u0631\u06CC\u0627\u0646</b>",
  t: "\u{1F4C5} <b>\u06A9\u0627\u0631\u0647\u0627\u06CC \u0627\u0645\u0631\u0648\u0632 \u0648 \u0639\u0642\u0628\u200C\u0627\u0641\u062A\u0627\u062F\u0647</b>",
  d: "\u2705 <b>\u06A9\u0627\u0631\u0647\u0627\u06CC \u0627\u0646\u062C\u0627\u0645\u200C\u0634\u062F\u0647</b>",
  a: "\u{1F5C3} <b>\u0647\u0645\u0647 \u06A9\u0627\u0631\u0647\u0627</b>"
};
function listView({ filter, page, total, rows, now }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const title = filter.startsWith("c") ? `\u{1F5C2} <b>\u062F\u0633\u062A\u0647 \xAB${esc(filter.slice(1))}\xBB</b>` : LIST_TITLES[filter];
  const header = `${title} (${fa(total)})${pages > 1 ? ` \u2014 \u0635\u0641\u062D\u0647 ${fa(page + 1)} \u0627\u0632 ${fa(pages)}` : ""}`;
  const body = rows.length ? rows.map((t) => taskLine(t, now)).join("\n\n") : filter === "p" ? "\u2728 \u0647\u06CC\u0686 \u06A9\u0627\u0631 \u062F\u0631 \u062C\u0631\u06CC\u0627\u0646\u06CC \u0646\u062F\u0627\u0631\u06CC\u062F!\n\u0628\u0631\u0627\u06CC \u0627\u0641\u0632\u0648\u062F\u0646 \u06A9\u0627\u0631\u060C \u06A9\u0627\u0641\u06CC\u0647 \u0645\u062A\u0646\u0634 \u0631\u0648 \u0647\u0645\u06CC\u0646\u200C\u062C\u0627 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F." : "\u2728 \u0686\u06CC\u0632\u06CC \u0628\u0631\u0627\u06CC \u0646\u0645\u0627\u06CC\u0634 \u0646\u06CC\u0633\u062A.";
  const ctx = `${filter}.${page}`;
  const rowsKb = rows.map((t) => [btn(`${t.done ? "\u2705" : PRIORITY[t.priority].icon} ${fa(t.num)}. ${truncate(t.text, 30)}`, cb("T", t.num, ctx))]);
  const nav = [];
  if (pages > 1) {
    nav.push(btn("\u25C0\uFE0F", page > 0 ? `L|${filter}|${page - 1}` : "N"));
    nav.push(btn(`${fa(page + 1)}/${fa(pages)}`, "N"));
    nav.push(btn("\u25B6\uFE0F", page < pages - 1 ? `L|${filter}|${page + 1}` : "N"));
  }
  const mark = /* @__PURE__ */ __name((f, label) => btn(filter === f ? `\u2022 ${label} \u2022` : label, `L|${f}|0`), "mark");
  return {
    text: `${header}

${body}`,
    kb: inline([...rowsKb, nav, [mark("p", "\u23F3 \u062F\u0631 \u062C\u0631\u06CC\u0627\u0646"), mark("t", "\u{1F4C5} \u0627\u0645\u0631\u0648\u0632"), mark("d", "\u2705 \u0627\u0646\u062C\u0627\u0645\u200C\u0634\u062F\u0647")], [btn("\u2795 \u0627\u0641\u0632\u0648\u062F\u0646 \u06A9\u0627\u0631", "ADD"), btn("\u{1F5C3} \u0647\u0645\u0647", "L|a|0")]])
  };
}
__name(listView, "listView");
function priorityKb(n, ctx) {
  return inline([
    [1, 2, 3].map((p) => btn(`${PRIORITY[p].icon} ${PRIORITY[p].label}`, cb("P", n, p, ctx))),
    [btn("\u{1F519} \u0628\u0627\u0632\u06AF\u0634\u062A", cb("T", n, ctx))]
  ]);
}
__name(priorityKb, "priorityKb");
function categoryKb(n, categories, current, ctx) {
  const rows = [];
  const names = categories.map((c) => c.category).filter((c) => c !== current).slice(0, 8);
  for (let i = 0; i < names.length; i += 2) rows.push(names.slice(i, i + 2).map((c) => btn(`\u{1F5C2} ${c}`, cb("C", n, c, ctx))));
  if (current) rows.push([btn("\u274C \u062D\u0630\u0641 \u062F\u0633\u062A\u0647", cb("C", n, "-", ctx))]);
  rows.push([btn("\u{1F519} \u0628\u0627\u0632\u06AF\u0634\u062A", cb("T", n, ctx))]);
  return inline(rows);
}
__name(categoryKb, "categoryKb");
function dueKb(n, hasDue, ctx) {
  return inline([
    [btn("\u0627\u0645\u0631\u0648\u0632", cb("DD", n, "0", ctx)), btn("\u0641\u0631\u062F\u0627", cb("DD", n, "1", ctx)), btn("\u067E\u0633\u200C\u0641\u0631\u062F\u0627", cb("DD", n, "2", ctx))],
    [btn("\u06F3 \u0631\u0648\u0632 \u062F\u06CC\u06AF\u0631", cb("DD", n, "3", ctx)), btn("\u0647\u0641\u062A\u0647 \u0628\u0639\u062F", cb("DD", n, "7", ctx)), btn("\u0645\u0627\u0647 \u0628\u0639\u062F", cb("DD", n, "30", ctx))],
    hasDue ? [btn("\u274C \u062D\u0630\u0641 \u062F\u062F\u0644\u0627\u06CC\u0646", cb("DD", n, "x", ctx))] : [],
    [btn("\u{1F519} \u0628\u0627\u0632\u06AF\u0634\u062A", cb("T", n, ctx))]
  ]);
}
__name(dueKb, "dueKb");
function reminderKb(n, t, ctx) {
  return inline([
    [btn("\u06F1\u06F5 \u062F\u0642\u06CC\u0642\u0647 \u0628\u0639\u062F", cb("RM", n, "15", ctx)), btn("\u06F3\u06F0 \u062F\u0642\u06CC\u0642\u0647 \u0628\u0639\u062F", cb("RM", n, "30", ctx))],
    [btn("\u06F1 \u0633\u0627\u0639\u062A \u0628\u0639\u062F", cb("RM", n, "60", ctx)), btn("\u06F3 \u0633\u0627\u0639\u062A \u0628\u0639\u062F", cb("RM", n, "180", ctx))],
    [btn("\u0641\u0631\u062F\u0627 \u06F9 \u0635\u0628\u062D", cb("RM", n, "t9", ctx)), btn("\u0627\u0645\u0634\u0628 \u06F2\u06F1:\u06F0\u06F0", cb("RM", n, "n21", ctx))],
    t.due_at && t.due_time ? [btn("\u23F1 \u0633\u0631 \u0645\u0648\u0639\u062F \u062F\u062F\u0644\u0627\u06CC\u0646", cb("RM", n, "due", ctx)), btn("\u06F1 \u0633\u0627\u0639\u062A \u0642\u0628\u0644 \u062F\u062F\u0644\u0627\u06CC\u0646", cb("RM", n, "due60", ctx))] : [],
    t.remind_at ? [btn("\u274C \u062D\u0630\u0641 \u06CC\u0627\u062F\u0622\u0648\u0631", cb("RM", n, "x", ctx))] : [],
    [btn("\u{1F519} \u0628\u0627\u0632\u06AF\u0634\u062A", cb("T", n, ctx))]
  ]);
}
__name(reminderKb, "reminderKb");
function repeatKb(n, current, ctx) {
  const mark = /* @__PURE__ */ __name((r, label) => btn(current === r ? `\u2713 ${label}` : label, cb("RP", n, r, ctx)), "mark");
  return inline([
    [mark("d", "\u0631\u0648\u0632\u0627\u0646\u0647"), mark("w", "\u0647\u0641\u062A\u06AF\u06CC"), mark("m", "\u0645\u0627\u0647\u0627\u0646\u0647")],
    current ? [btn("\u274C \u0628\u062F\u0648\u0646 \u062A\u06A9\u0631\u0627\u0631", cb("RP", n, "x", ctx))] : [],
    [btn("\u{1F519} \u0628\u0627\u0632\u06AF\u0634\u062A", cb("T", n, ctx))]
  ]);
}
__name(repeatKb, "repeatKb");
function progressBar(ratio, width = 10) {
  const filled = Math.round(ratio * width);
  return "\u25B0".repeat(filled) + "\u25B1".repeat(width - filled);
}
__name(progressBar, "progressBar");
var QUICK_ADD_HINT = [
  "\u{1F4A1} <b>\u0627\u0641\u0632\u0648\u062F\u0646 \u0633\u0631\u06CC\u0639:</b> \u0647\u0631 \u0645\u062A\u0646\u06CC \u0628\u0641\u0631\u0633\u062A\u06CC\u062F \u0628\u0647\u200C\u0639\u0646\u0648\u0627\u0646 \u06A9\u0627\u0631 \u062C\u062F\u06CC\u062F \u0630\u062E\u06CC\u0631\u0647 \u0645\u06CC\u200C\u0634\u0647.",
  "\u0645\u06CC\u200C\u062A\u0648\u0646\u06CC\u062F \u062F\u0627\u062E\u0644 \u0645\u062A\u0646 \u0627\u0632 \u0627\u06CC\u0646\u200C\u0647\u0627 \u0647\u0645 \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u06A9\u0646\u06CC\u062F:",
  "\u2022 <code>#\u062F\u0633\u062A\u0647</code> \u2190 \u062F\u0633\u062A\u0647\u200C\u0628\u0646\u062F\u06CC (\u0645\u062B\u0644\u0627\u064B <code>#\u062E\u0631\u06CC\u062F</code>)",
  "\u2022 <code>!1</code> / <code>!2</code> / <code>!3</code> \u2190 \u0627\u0648\u0644\u0648\u06CC\u062A \u0628\u0627\u0644\u0627 / \u0645\u062A\u0648\u0633\u0637 / \u06A9\u0645",
  "\u2022 <code>@\u0632\u0645\u0627\u0646</code> \u2190 \u062F\u062F\u0644\u0627\u06CC\u0646 (\u0645\u062B\u0644\u0627\u064B <code>@\u0641\u0631\u062F\u0627</code>\u060C <code>@\u0634\u0646\u0628\u0647 \u0633\u0627\u0639\u062A 18</code>\u060C <code>@1405/08/10</code>)",
  "",
  "\u0646\u0645\u0648\u0646\u0647: <code>\u062E\u0631\u06CC\u062F \u0646\u0627\u0646 \u0648 \u0634\u06CC\u0631 #\u062E\u0627\u0646\u0647 !1 @\u0641\u0631\u062F\u0627 18:00</code>"
].join("\n");
var HELP_TEXT = [
  "\u{1F4D6} <b>\u0631\u0627\u0647\u0646\u0645\u0627\u06CC \u0631\u0628\u0627\u062A \u062A\u0648\u062F\u0648 \u0644\u06CC\u0633\u062A</b>",
  "",
  "<b>\u06F1\u06F0 \u0642\u0627\u0628\u0644\u06CC\u062A \u0631\u0628\u0627\u062A:</b>",
  "1\uFE0F\u20E3 <b>\u0627\u0641\u0632\u0648\u062F\u0646 \u0633\u0631\u06CC\u0639 \u0647\u0648\u0634\u0645\u0646\u062F</b> \u2014 \u0645\u062A\u0646 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F\u061B \u062F\u0633\u062A\u0647\u060C \u0627\u0648\u0644\u0648\u06CC\u062A \u0648 \u062F\u062F\u0644\u0627\u06CC\u0646 \u0631\u0648 \u0627\u0632 \u062E\u0648\u062F \u0645\u062A\u0646 \u0645\u06CC\u200C\u0641\u0647\u0645\u0647.",
  "2\uFE0F\u20E3 <b>\u0627\u0648\u0644\u0648\u06CC\u062A\u200C\u0628\u0646\u062F\u06CC</b> \u{1F534}\u{1F7E1}\u{1F7E2} \u2014 \u06A9\u0627\u0631\u0647\u0627 \u062E\u0648\u062F\u06A9\u0627\u0631 \u0628\u0631 \u0627\u0633\u0627\u0633 \u0627\u0648\u0644\u0648\u06CC\u062A \u0648 \u062F\u062F\u0644\u0627\u06CC\u0646 \u0645\u0631\u062A\u0628 \u0645\u06CC\u200C\u0634\u0646.",
  "3\uFE0F\u20E3 <b>\u062F\u062F\u0644\u0627\u06CC\u0646 \u0628\u0627 \u062A\u0642\u0648\u06CC\u0645 \u0634\u0645\u0633\u06CC</b> \u{1F4C5} \u2014 \u0628\u0627 \u0647\u0634\u062F\u0627\u0631 \u26A0\uFE0F \u0628\u0631\u0627\u06CC \u06A9\u0627\u0631\u0647\u0627\u06CC \u0639\u0642\u0628\u200C\u0627\u0641\u062A\u0627\u062F\u0647.",
  "4\uFE0F\u20E3 <b>\u06CC\u0627\u062F\u0622\u0648\u0631 \u0632\u0645\u0627\u0646\u200C\u062F\u0627\u0631</b> \u23F0 \u2014 \u0633\u0631 \u0648\u0642\u062A \u067E\u06CC\u0627\u0645 \u0645\u06CC\u200C\u06AF\u06CC\u0631\u06CC\u062F (\u0628\u0627 \u062F\u06A9\u0645\u0647 \u062A\u0639\u0648\u06CC\u0642).",
  "5\uFE0F\u20E3 <b>\u062F\u0633\u062A\u0647\u200C\u0628\u0646\u062F\u06CC</b> \u{1F5C2} \u2014 \u06A9\u0627\u0631\u0647\u0627 \u0631\u0648 \u06AF\u0631\u0648\u0647\u200C\u0628\u0646\u062F\u06CC \u0648 \u0641\u06CC\u0644\u062A\u0631 \u06A9\u0646\u06CC\u062F.",
  "6\uFE0F\u20E3 <b>\u06A9\u0627\u0631\u0647\u0627\u06CC \u062A\u06A9\u0631\u0627\u0631\u06CC</b> \u{1F501} \u2014 \u0631\u0648\u0632\u0627\u0646\u0647\u060C \u0647\u0641\u062A\u06AF\u06CC \u06CC\u0627 \u0645\u0627\u0647\u0627\u0646\u0647\u061B \u0628\u0627 \u0627\u0646\u062C\u0627\u0645 \u0647\u0631 \u0646\u0648\u0628\u062A\u060C \u0646\u0648\u0628\u062A \u0628\u0639\u062F \u062E\u0648\u062F\u06A9\u0627\u0631 \u0633\u0627\u062E\u062A\u0647 \u0645\u06CC\u200C\u0634\u0647.",
  "7\uFE0F\u20E3 <b>\u06CC\u0627\u062F\u062F\u0627\u0634\u062A \u0648 \u0648\u06CC\u0631\u0627\u06CC\u0634 \u06A9\u0627\u0645\u0644</b> \u{1F4DD} \u2014 \u0645\u062A\u0646\u060C \u06CC\u0627\u062F\u062F\u0627\u0634\u062A \u0648 \u0647\u0645\u0647 \u0645\u0634\u062E\u0635\u0627\u062A \u0647\u0631 \u06A9\u0627\u0631 \u0642\u0627\u0628\u0644 \u0648\u06CC\u0631\u0627\u06CC\u0634\u0647.",
  "8\uFE0F\u20E3 <b>\u062C\u0633\u062A\u062C\u0648</b> \u{1F50D} \u2014 \u062F\u0631 \u0645\u062A\u0646\u060C \u06CC\u0627\u062F\u062F\u0627\u0634\u062A \u0648 \u062F\u0633\u062A\u0647 \u06A9\u0627\u0631\u0647\u0627.",
  "9\uFE0F\u20E3 <b>\u0622\u0645\u0627\u0631 \u0648 \u0646\u0645\u0648\u062F\u0627\u0631 \u067E\u06CC\u0634\u0631\u0641\u062A</b> \u{1F4CA}",
  "\u{1F51F} <b>\u062E\u0644\u0627\u0635\u0647 \u0631\u0648\u0632\u0627\u0646\u0647 \u0635\u0628\u062D\u06AF\u0627\u0647\u06CC</b> \u{1F305} \u2014 \u0647\u0631 \u0631\u0648\u0632 \u0633\u0627\u0639\u062A \u062F\u0644\u062E\u0648\u0627\u0647\u060C \u0644\u06CC\u0633\u062A \u06A9\u0627\u0631\u0647\u0627\u06CC \u0627\u0645\u0631\u0648\u0632 \u0628\u0631\u0627\u062A\u0648\u0646 \u0627\u0631\u0633\u0627\u0644 \u0645\u06CC\u200C\u0634\u0647.",
  "",
  "\u2795 \u0647\u0645\u0686\u0646\u06CC\u0646: \u062E\u0631\u0648\u062C\u06CC \u0641\u0627\u06CC\u0644 \u0627\u0632 \u0647\u0645\u0647 \u06A9\u0627\u0631\u0647\u0627 \u{1F4E4} \u0648 \u067E\u0627\u06A9\u0633\u0627\u0632\u06CC \u06A9\u0627\u0631\u0647\u0627\u06CC \u0627\u0646\u062C\u0627\u0645\u200C\u0634\u062F\u0647 \u{1F9F9} \u062F\u0631 \u2699\uFE0F \u062A\u0646\u0638\u06CC\u0645\u0627\u062A.",
  "",
  QUICK_ADD_HINT,
  "",
  "<b>\u0641\u0631\u0645\u062A\u200C\u0647\u0627\u06CC \u0632\u0645\u0627\u0646:</b> <code>\u0627\u0645\u0631\u0648\u0632</code>\u060C <code>\u0641\u0631\u062F\u0627</code>\u060C <code>\u067E\u0633\u200C\u0641\u0631\u062F\u0627</code>\u060C <code>\u0634\u0646\u0628\u0647</code>\u060C <code>\u0647\u0641\u062A\u0647 \u0628\u0639\u062F</code>\u060C <code>+3</code> (\u06F3 \u0631\u0648\u0632 \u0628\u0639\u062F)\u060C <code>30 \u062F\u0642\u06CC\u0642\u0647 \u062F\u06CC\u06AF\u0631</code>\u060C <code>2 \u0633\u0627\u0639\u062A \u0628\u0639\u062F</code>\u060C <code>18:30</code>\u060C <code>\u0633\u0627\u0639\u062A 8 \u0634\u0628</code>\u060C <code>1405/08/10</code>\u060C <code>2026-11-01 09:00</code>",
  "",
  "<b>\u062F\u0633\u062A\u0648\u0631\u0627\u062A:</b> /start \xB7 /list \xB7 /today \xB7 /add \xB7 /search \xB7 /stats \xB7 /settings \xB7 /help \xB7 /cancel"
].join("\n");

// src/join.js
var verified = /* @__PURE__ */ new Map();
function clearJoinCache() {
  verified.clear();
}
__name(clearJoinCache, "clearJoinCache");
var MEMBER = /* @__PURE__ */ new Set(["creator", "administrator", "member"]);
async function missingChannels(ctx, userId) {
  const channels = await listChannels(ctx.db);
  const missing = await Promise.all(
    channels.map(async (c) => {
      const r = await ctx.api.call("getChatMember", { chat_id: c.chat, user_id: userId });
      if (!r.ok) return false;
      const { status, is_member: isMember } = r.result;
      return !(MEMBER.has(status) || status === "restricted" && isMember);
    })
  );
  return channels.filter((_, i) => missing[i]);
}
__name(missingChannels, "missingChannels");
async function checkJoin(ctx, userId, { force = false } = {}) {
  const last = verified.get(userId);
  if (!force && last && ctx.now - last < JOIN_CACHE_MS) return [];
  const missing = await missingChannels(ctx, userId);
  if (missing.length) {
    verified.delete(userId);
  } else {
    if (verified.size > 1e4) verified.clear();
    verified.set(userId, ctx.now);
  }
  return missing;
}
__name(checkJoin, "checkJoin");
function joinGateView(missing) {
  const text = [
    "\u{1F512} <b>\u0628\u0631\u0627\u06CC \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u0627\u0632 \u0631\u0628\u0627\u062A\u060C \u0627\u0628\u062A\u062F\u0627 \u062F\u0631 \u06A9\u0627\u0646\u0627\u0644\u200C\u0647\u0627\u06CC \u0632\u06CC\u0631 \u0639\u0636\u0648 \u0634\u0648\u06CC\u062F:</b>",
    "",
    ...missing.map((c, i) => `${fa(i + 1)}. ${esc(c.title || c.chat)}`),
    "",
    "\u0628\u0639\u062F \u0627\u0632 \u0639\u0636\u0648\u06CC\u062A \u0631\u0648\u06CC \xAB\u2705 \u0639\u0636\u0648 \u0634\u062F\u0645\xBB \u0628\u0632\u0646\u06CC\u062F \u{1F447}"
  ].join("\n");
  const rows = missing.map((c) => [urlBtn(`\u{1F4E2} \u0639\u0636\u0648\u06CC\u062A \u062F\u0631 ${c.title || c.chat}`, c.link)]);
  rows.push([btn("\u2705 \u0639\u0636\u0648 \u0634\u062F\u0645\u060C \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646", "J")]);
  return { text, kb: inline(rows) };
}
__name(joinGateView, "joinGateView");

// src/admin.js
var USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
async function homeView(ctx) {
  const channels = await listChannels(ctx.db);
  return {
    text: [
      "\u{1F451} <b>\u067E\u0646\u0644 \u0645\u062F\u06CC\u0631\u06CC\u062A \u0631\u0628\u0627\u062A</b>",
      "",
      `\u{1F4E2} \u06A9\u0627\u0646\u0627\u0644\u200C\u0647\u0627\u06CC \u062C\u0648\u06CC\u0646 \u0627\u062C\u0628\u0627\u0631\u06CC: ${fa(channels.length)} \u0627\u0632 ${fa(MAX_CHANNELS)}`,
      "",
      "\u062F\u0633\u062A\u0648\u0631\u0627\u062A \u0645\u062A\u0646\u06CC \u0647\u0645 \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0627\u0633\u062A:",
      "<code>/channels</code> \u2014 \u0644\u06CC\u0633\u062A \u06A9\u0627\u0646\u0627\u0644\u200C\u0647\u0627",
      "<code>/addchannel @username</code> \u2014 \u0627\u0641\u0632\u0648\u062F\u0646 \u06A9\u0627\u0646\u0627\u0644",
      "<code>/delchannel @username</code> \u06CC\u0627 <code>/delchannel 2</code> \u2014 \u062D\u0630\u0641 \u06A9\u0627\u0646\u0627\u0644"
    ].join("\n"),
    kb: inline([
      [btn(`\u{1F4E2} \u06A9\u0627\u0646\u0627\u0644\u200C\u0647\u0627\u06CC \u062C\u0648\u06CC\u0646 \u0627\u062C\u0628\u0627\u0631\u06CC (${fa(channels.length)}/${fa(MAX_CHANNELS)})`, "A|ch")],
      [btn("\u{1F4CA} \u0622\u0645\u0627\u0631 \u0631\u0628\u0627\u062A", "A|st"), btn("\u{1F4E3} \u067E\u06CC\u0627\u0645 \u0647\u0645\u06AF\u0627\u0646\u06CC", "A|bc")]
    ])
  };
}
__name(homeView, "homeView");
async function channelsView(ctx, notice = "") {
  const channels = await listChannels(ctx.db);
  const lines = channels.length ? channels.map((c, i) => `${fa(i + 1)}. <b>${esc(c.title || c.chat)}</b>
      <code>${esc(c.chat)}</code> \u2014 ${esc(c.link)}`) : ["\u0647\u06CC\u0686 \u06A9\u0627\u0646\u0627\u0644\u06CC \u062A\u0646\u0638\u06CC\u0645 \u0646\u0634\u062F\u0647\u061B \u062C\u0648\u06CC\u0646 \u0627\u062C\u0628\u0627\u0631\u06CC \u063A\u06CC\u0631\u0641\u0639\u0627\u0644 \u0627\u0633\u062A."];
  const rows = channels.map((c, i) => [btn(`\u274C \u062D\u0630\u0641 ${fa(i + 1)}. ${c.title || c.chat}`, `A|cd|${c.id}`)]);
  rows.push([
    channels.length < MAX_CHANNELS ? btn("\u2795 \u0627\u0641\u0632\u0648\u062F\u0646 \u06A9\u0627\u0646\u0627\u0644", "A|ca") : btn(`\u26D4\uFE0F \u0633\u0642\u0641 ${fa(MAX_CHANNELS)} \u06A9\u0627\u0646\u0627\u0644 \u067E\u0631 \u0627\u0633\u062A`, "A|full"),
    btn("\u{1F504} \u0628\u0631\u0631\u0633\u06CC \u0648\u0636\u0639\u06CC\u062A", "A|ck")
  ]);
  rows.push([btn("\u{1F519} \u067E\u0646\u0644 \u0645\u062F\u06CC\u0631\u06CC\u062A", "A|h")]);
  return {
    text: [
      notice,
      `\u{1F4E2} <b>\u06A9\u0627\u0646\u0627\u0644\u200C\u0647\u0627\u06CC \u062C\u0648\u06CC\u0646 \u0627\u062C\u0628\u0627\u0631\u06CC</b> (${fa(channels.length)} \u0627\u0632 ${fa(MAX_CHANNELS)})`,
      "",
      ...lines,
      "",
      "\u26A0\uFE0F \u0631\u0628\u0627\u062A \u0628\u0627\u06CC\u062F \u062F\u0631 \u0647\u0631 \u06A9\u0627\u0646\u0627\u0644 <b>\u0627\u062F\u0645\u06CC\u0646</b> \u0628\u0627\u0634\u062F \u062A\u0627 \u0639\u0636\u0648\u06CC\u062A \u06A9\u0627\u0631\u0628\u0631\u0627\u0646 \u0628\u0631\u0631\u0633\u06CC \u0634\u0648\u062F."
    ].filter((l, i) => i > 0 || l).join("\n"),
    kb: inline(rows)
  };
}
__name(channelsView, "channelsView");
var ADD_CHANNEL_PROMPT = [
  "\u2795 <b>\u0627\u0641\u0632\u0648\u062F\u0646 \u06A9\u0627\u0646\u0627\u0644 \u062C\u0648\u06CC\u0646 \u0627\u062C\u0628\u0627\u0631\u06CC</b>",
  "",
  "\u06CC\u06A9\u06CC \u0627\u0632 \u0627\u06CC\u0646\u200C\u0647\u0627 \u0631\u0627 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F:",
  "\u2022 \u06CC\u0648\u0632\u0631\u0646\u06CC\u0645 \u06A9\u0627\u0646\u0627\u0644: <code>@channel</code>",
  "\u2022 \u0644\u06CC\u0646\u06A9 \u06A9\u0627\u0646\u0627\u0644: <code>https://t.me/channel</code>",
  "\u2022 \u06A9\u0627\u0646\u0627\u0644 \u062E\u0635\u0648\u0635\u06CC: \u0622\u06CC\u062F\u06CC \u0639\u062F\u062F\u06CC + \u0644\u06CC\u0646\u06A9 \u062F\u0639\u0648\u062A\u060C \u0645\u062B\u0644:",
  "  <code>-1001234567890 https://t.me/+AbCdEf</code>",
  "\u2022 \u06CC\u0627 \u06CC\u06A9 \u067E\u06CC\u0627\u0645 \u0627\u0632 \u062E\u0648\u062F \u06A9\u0627\u0646\u0627\u0644 \u0631\u0627 \u0627\u06CC\u0646\u062C\u0627 \u0641\u0648\u0631\u0648\u0627\u0631\u062F \u06A9\u0646\u06CC\u062F.",
  "",
  "\u26A0\uFE0F \u0642\u0628\u0644\u0634 \u0631\u0628\u0627\u062A \u0631\u0627 \u062F\u0631 \u06A9\u0627\u0646\u0627\u0644 \u0627\u062F\u0645\u06CC\u0646 \u06A9\u0646\u06CC\u062F."
].join("\n");
function parseChannelInput(msg) {
  const origin = msg.forward_origin;
  const fwdChat = origin?.type === "channel" ? origin.chat : msg.forward_from_chat;
  if (fwdChat && fwdChat.type === "channel") {
    return fwdChat.username ? { chat: `@${fwdChat.username}`, link: `https://t.me/${fwdChat.username}` } : { chat: String(fwdChat.id), link: null };
  }
  const text = toLatinDigits(msg.text || msg.caption || "").trim().replace(/^\/addchannel(@\w+)?\s*/i, "");
  let chat = null;
  let link = null;
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^<|>$/g, "");
    const invite = token.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(\+[\w-]+|joinchat\/[\w-]+)\/?$/i);
    const pub = token.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i);
    if (invite) link = `https://t.me/${invite[1]}`;
    else if (pub) chat = `@${pub[1]}`;
    else if (/^@/.test(token) && USERNAME_RE.test(token.slice(1))) chat = token;
    else if (/^-100\d{5,}$/.test(token)) chat = token;
  }
  if (chat?.startsWith("@")) link = `https://t.me/${chat.slice(1)}`;
  return chat ? { chat, link } : null;
}
__name(parseChannelInput, "parseChannelInput");
async function addChannel2(ctx, input) {
  if (!input) return { ok: false, text: "\u2757\uFE0F \u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A.\n\n" + ADD_CHANNEL_PROMPT };
  const channels = await listChannels(ctx.db);
  if (channels.length >= MAX_CHANNELS) return { ok: false, text: `\u26D4\uFE0F \u062D\u062F\u0627\u06A9\u062B\u0631 ${fa(MAX_CHANNELS)} \u06A9\u0627\u0646\u0627\u0644 \u0642\u0627\u0628\u0644 \u062A\u0646\u0638\u06CC\u0645 \u0627\u0633\u062A. \u0627\u0648\u0644 \u06CC\u06A9\u06CC \u0631\u0627 \u062D\u0630\u0641 \u06A9\u0646\u06CC\u062F.` };
  if (channels.some((c) => c.chat.toLowerCase() === input.chat.toLowerCase())) return { ok: false, text: `\u2139\uFE0F \u06A9\u0627\u0646\u0627\u0644 <code>${esc(input.chat)}</code> \u0627\u0632 \u0642\u0628\u0644 \u062F\u0631 \u0644\u06CC\u0633\u062A \u0647\u0633\u062A.` };
  const info = await ctx.api.call("getChat", { chat_id: input.chat });
  let { chat, link } = input;
  let title = null;
  if (info.ok) {
    title = info.result.title || null;
    if (info.result.username) {
      chat = `@${info.result.username}`;
      link = link || `https://t.me/${info.result.username}`;
      if (channels.some((c) => c.chat.toLowerCase() === chat.toLowerCase())) return { ok: false, text: `\u2139\uFE0F \u06A9\u0627\u0646\u0627\u0644 <code>${esc(chat)}</code> \u0627\u0632 \u0642\u0628\u0644 \u062F\u0631 \u0644\u06CC\u0633\u062A \u0647\u0633\u062A.` };
    }
    if (!link) link = info.result.invite_link || null;
    if (!link) {
      const created = await ctx.api.call("createChatInviteLink", { chat_id: chat, name: "todo-bot join" });
      if (created.ok) link = created.result.invite_link;
    }
  } else if (!chat.startsWith("@")) {
    return { ok: false, text: "\u274C \u0631\u0628\u0627\u062A \u0628\u0647 \u0627\u06CC\u0646 \u06A9\u0627\u0646\u0627\u0644 \u062F\u0633\u062A\u0631\u0633\u06CC \u0646\u062F\u0627\u0631\u062F. \u0627\u0648\u0644 \u0631\u0628\u0627\u062A \u0631\u0627 \u062F\u0631 \u06A9\u0627\u0646\u0627\u0644 \u0627\u062F\u0645\u06CC\u0646 \u06A9\u0646\u06CC\u062F \u0648 \u062F\u0648\u0628\u0627\u0631\u0647 \u0627\u0645\u062A\u062D\u0627\u0646 \u06A9\u0646\u06CC\u062F." };
  }
  if (!link) return { ok: false, text: "\u2757\uFE0F \u0644\u06CC\u0646\u06A9 \u062F\u0639\u0648\u062A \u06A9\u0627\u0646\u0627\u0644 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F. \u0622\u06CC\u062F\u06CC \u0639\u062F\u062F\u06CC \u0631\u0627 \u0647\u0645\u0631\u0627\u0647 \u0644\u06CC\u0646\u06A9 \u062F\u0639\u0648\u062A \u0628\u0641\u0631\u0633\u062A\u06CC\u062F:\n<code>-1001234567890 https://t.me/+AbCdEf</code>" };
  const me = await ctx.api.call("getChatMember", { chat_id: chat, user_id: ctx.api.botId() });
  const isAdmin = me.ok && ["administrator", "creator"].includes(me.result.status);
  await addChannel(ctx.db, chat, title, link, ctx.now);
  clearJoinCache();
  const warn = isAdmin ? "" : "\n\u26A0\uFE0F \u0631\u0628\u0627\u062A \u062F\u0631 \u0627\u06CC\u0646 \u06A9\u0627\u0646\u0627\u0644 \u0627\u062F\u0645\u06CC\u0646 \u0646\u06CC\u0633\u062A\u061B \u062A\u0627 \u0648\u0642\u062A\u06CC \u0627\u062F\u0645\u06CC\u0646 \u0646\u0634\u0648\u062F\u060C \u0639\u0636\u0648\u06CC\u062A \u062F\u0631 \u0627\u06CC\u0646 \u06A9\u0627\u0646\u0627\u0644 \u0628\u0631\u0631\u0633\u06CC \u0646\u0645\u06CC\u200C\u0634\u0648\u062F.";
  return { ok: true, text: `\u2705 \u06A9\u0627\u0646\u0627\u0644 <b>${esc(title || chat)}</b> \u0627\u0636\u0627\u0641\u0647 \u0634\u062F.${warn}
` };
}
__name(addChannel2, "addChannel");
async function removeChannel2(ctx, id) {
  const ch = await getChannel(ctx.db, id);
  if (!ch) return null;
  await removeChannel(ctx.db, id);
  clearJoinCache();
  return ch;
}
__name(removeChannel2, "removeChannel");
async function resolveChannelRef(ctx, ref) {
  const channels = await listChannels(ctx.db);
  const r = normalizeInput(ref);
  if (/^\d+$/.test(r)) return channels[Number(r) - 1] || null;
  const name = r.replace(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//, "@").replace(/\/$/, "");
  return channels.find((c) => c.chat.toLowerCase() === name || c.chat.toLowerCase() === `@${name}`) || null;
}
__name(resolveChannelRef, "resolveChannelRef");
async function statusReport(ctx) {
  const channels = await listChannels(ctx.db);
  const botId = ctx.api.botId();
  const lines = await Promise.all(
    channels.map(async (c, i) => {
      const [info, me] = await Promise.all([
        ctx.api.call("getChat", { chat_id: c.chat }),
        ctx.api.call("getChatMember", { chat_id: c.chat, user_id: botId })
      ]);
      if (info.ok && info.result.title && info.result.title !== c.title) await setChannelTitle(ctx.db, c.id, info.result.title);
      const name = esc(info.ok && info.result.title || c.title || c.chat);
      if (!info.ok) return `${fa(i + 1)}. \u274C <b>${name}</b> \u2014 \u06A9\u0627\u0646\u0627\u0644 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F \u06CC\u0627 \u0631\u0628\u0627\u062A \u0628\u0647 \u0622\u0646 \u062F\u0633\u062A\u0631\u0633\u06CC \u0646\u062F\u0627\u0631\u062F`;
      if (me.ok && ["administrator", "creator"].includes(me.result.status)) return `${fa(i + 1)}. \u2705 <b>${name}</b> \u2014 \u0631\u0628\u0627\u062A \u0627\u062F\u0645\u06CC\u0646 \u0627\u0633\u062A`;
      return `${fa(i + 1)}. \u26A0\uFE0F <b>${name}</b> \u2014 \u0631\u0628\u0627\u062A \u0627\u062F\u0645\u06CC\u0646 \u0646\u06CC\u0633\u062A (\u0639\u0636\u0648\u06CC\u062A \u0628\u0631\u0631\u0633\u06CC \u0646\u0645\u06CC\u200C\u0634\u0648\u062F)`;
    })
  );
  return lines.length ? `\u{1F504} <b>\u0648\u0636\u0639\u06CC\u062A \u06A9\u0627\u0646\u0627\u0644\u200C\u0647\u0627:</b>
${lines.join("\n")}
` : "";
}
__name(statusReport, "statusReport");
async function statsView(ctx) {
  const s = await botStats(ctx.db, ctx.now);
  const b = await activeBroadcast(ctx.db);
  return {
    text: [
      "\u{1F4CA} <b>\u0622\u0645\u0627\u0631 \u0631\u0628\u0627\u062A</b>",
      "",
      `\u{1F465} \u06A9\u0644 \u06A9\u0627\u0631\u0628\u0631\u0627\u0646: ${fa(s.users)}`,
      `\u{1F195} \u06A9\u0627\u0631\u0628\u0631\u0627\u0646 \u062C\u062F\u06CC\u062F (\u06F2\u06F4 \u0633\u0627\u0639\u062A): ${fa(s.new_day)}`,
      `\u{1F7E2} \u0641\u0639\u0627\u0644 \u062F\u0631 \u06F2\u06F4 \u0633\u0627\u0639\u062A: ${fa(s.active_day)}`,
      `\u{1F4C6} \u0641\u0639\u0627\u0644 \u062F\u0631 \u06F7 \u0631\u0648\u0632: ${fa(s.active_week)}`,
      `\u{1F6AB} \u0631\u0628\u0627\u062A \u0631\u0627 \u0628\u0644\u0627\u06A9 \u06A9\u0631\u062F\u0647\u200C\u0627\u0646\u062F: ${fa(s.blocked)}`,
      "",
      `\u{1F4DD} \u06A9\u0644 \u06A9\u0627\u0631\u0647\u0627: ${fa(s.tasks)}`,
      `\u2705 \u06A9\u0627\u0631\u0647\u0627\u06CC \u0627\u0646\u062C\u0627\u0645\u200C\u0634\u062F\u0647: ${fa(s.done)}`,
      b ? `
\u{1F4E3} \u0627\u0631\u0633\u0627\u0644 \u0647\u0645\u06AF\u0627\u0646\u06CC \u062F\u0631 \u062D\u0627\u0644 \u0627\u062C\u0631\u0627: ${fa(b.sent)} \u0627\u0631\u0633\u0627\u0644\u200C\u0634\u062F\u0647\u060C ${fa(b.failed)} \u0646\u0627\u0645\u0648\u0641\u0642` : "",
      "",
      `<i>\u{1F553} ${formatDate(ctx.now, { now: ctx.now })}</i>`
    ].join("\n"),
    kb: inline([[btn("\u{1F504} \u0628\u0631\u0648\u0632\u0631\u0633\u0627\u0646\u06CC", "A|st"), btn("\u{1F519} \u067E\u0646\u0644 \u0645\u062F\u06CC\u0631\u06CC\u062A", "A|h")]])
  };
}
__name(statsView, "statsView");
async function prepareBroadcast(ctx, msg) {
  await setState(ctx.db, ctx.uid, null);
  const count = await countActiveUsers(ctx.db);
  return ctx.api.send(ctx.chatId, `\u{1F4E3} \u0627\u06CC\u0646 \u067E\u06CC\u0627\u0645 \u0628\u0631\u0627\u06CC <b>${fa(count)}</b> \u06A9\u0627\u0631\u0628\u0631 \u0627\u0631\u0633\u0627\u0644 \u0634\u0648\u062F\u061F`, {
    reply_to_message_id: msg.message_id,
    reply_markup: inline([[btn("\u2705 \u0628\u0644\u0647\u060C \u0627\u0631\u0633\u0627\u0644 \u06A9\u0646", `A|bcy|${msg.message_id}`), btn("\u274C \u0644\u063A\u0648", "A|bcn")]])
  });
}
__name(prepareBroadcast, "prepareBroadcast");
async function onAdminCommand(ctx, cmd, arg) {
  if (cmd === "/admin") {
    const v = await homeView(ctx);
    return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
  }
  if (cmd === "/channels") {
    const v = await channelsView(ctx);
    return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
  }
  if (cmd === "/addchannel") {
    if (!arg) {
      await setState(ctx.db, ctx.uid, { a: "addch" });
      return ctx.api.send(ctx.chatId, ADD_CHANNEL_PROMPT, { reply_markup: inline([[btn("\u274C \u0644\u063A\u0648", "A|ch")]]) });
    }
    const res = await addChannel2(ctx, parseChannelInput({ text: arg }));
    const v = await channelsView(ctx, res.text);
    return ctx.api.send(ctx.chatId, res.ok ? v.text : res.text, { reply_markup: res.ok ? v.kb : void 0 });
  }
  if (cmd === "/delchannel") {
    const ch = arg ? await resolveChannelRef(ctx, arg) : null;
    if (!ch) return ctx.api.send(ctx.chatId, "\u2757\uFE0F \u06A9\u0627\u0646\u0627\u0644 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F. \u0646\u0645\u0648\u0646\u0647: <code>/delchannel @username</code> \u06CC\u0627 <code>/delchannel 2</code> (\u0634\u0645\u0627\u0631\u0647 \u062F\u0631 \u0644\u06CC\u0633\u062A /channels)");
    await removeChannel2(ctx, ch.id);
    const v = await channelsView(ctx, `\u{1F5D1} \u06A9\u0627\u0646\u0627\u0644 <b>${esc(ch.title || ch.chat)}</b> \u062D\u0630\u0641 \u0634\u062F.
`);
    return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
  }
  return null;
}
__name(onAdminCommand, "onAdminCommand");
async function onAdminState(ctx, msg) {
  if (ctx.state.a === "addch") {
    const res = await addChannel2(ctx, parseChannelInput(msg));
    if (!res.ok) return ctx.api.send(ctx.chatId, res.text, { reply_markup: inline([[btn("\u274C \u0644\u063A\u0648", "A|ch")]]) });
    await setState(ctx.db, ctx.uid, null);
    const v = await channelsView(ctx, res.text);
    return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
  }
  if (ctx.state.a === "bc") return prepareBroadcast(ctx, msg);
  return null;
}
__name(onAdminState, "onAdminState");
async function onAdminCallback(ctx, parts) {
  const [action, arg] = parts;
  if (action !== "ca" && action !== "bc" && ctx.state) await setState(ctx.db, ctx.uid, null);
  switch (action) {
    case "h": {
      const v = await homeView(ctx);
      return ctx.show(v.text, v.kb);
    }
    case "ch": {
      const v = await channelsView(ctx);
      return ctx.show(v.text, v.kb);
    }
    case "full":
      return ctx.toast(`\u26D4\uFE0F \u062D\u062F\u0627\u06A9\u062B\u0631 ${fa(MAX_CHANNELS)} \u06A9\u0627\u0646\u0627\u0644\u061B \u0627\u0648\u0644 \u06CC\u06A9\u06CC \u0631\u0627 \u062D\u0630\u0641 \u06A9\u0646\u06CC\u062F.`, true);
    case "ca": {
      const channels = await listChannels(ctx.db);
      if (channels.length >= MAX_CHANNELS) return ctx.toast(`\u26D4\uFE0F \u062D\u062F\u0627\u06A9\u062B\u0631 ${fa(MAX_CHANNELS)} \u06A9\u0627\u0646\u0627\u0644\u061B \u0627\u0648\u0644 \u06CC\u06A9\u06CC \u0631\u0627 \u062D\u0630\u0641 \u06A9\u0646\u06CC\u062F.`, true);
      await setState(ctx.db, ctx.uid, { a: "addch" });
      return ctx.show(ADD_CHANNEL_PROMPT, inline([[btn("\u{1F519} \u0644\u063A\u0648 \u0648 \u0628\u0627\u0632\u06AF\u0634\u062A", "A|ch")]]));
    }
    case "cd": {
      const ch = await getChannel(ctx.db, Number(arg));
      if (!ch) return ctx.toast("\u0627\u06CC\u0646 \u06A9\u0627\u0646\u0627\u0644 \u0642\u0628\u0644\u0627\u064B \u062D\u0630\u0641 \u0634\u062F\u0647.", true);
      return ctx.show(
        `\u{1F5D1} \u06A9\u0627\u0646\u0627\u0644 <b>${esc(ch.title || ch.chat)}</b> \u0627\u0632 \u062C\u0648\u06CC\u0646 \u0627\u062C\u0628\u0627\u0631\u06CC \u062D\u0630\u0641 \u0634\u0648\u062F\u061F`,
        inline([[btn("\u2705 \u0628\u0644\u0647\u060C \u062D\u0630\u0641 \u0634\u0648\u062F", `A|cdy|${ch.id}`), btn("\u274C \u0646\u0647", "A|ch")]])
      );
    }
    case "cdy": {
      const ch = await removeChannel2(ctx, Number(arg));
      const v = await channelsView(ctx, ch ? `\u{1F5D1} \u06A9\u0627\u0646\u0627\u0644 <b>${esc(ch.title || ch.chat)}</b> \u062D\u0630\u0641 \u0634\u062F.
` : "");
      await ctx.toast(ch ? "\u{1F5D1} \u062D\u0630\u0641 \u0634\u062F" : "\u0642\u0628\u0644\u0627\u064B \u062D\u0630\u0641 \u0634\u062F\u0647 \u0628\u0648\u062F");
      return ctx.show(v.text, v.kb);
    }
    case "ck": {
      await ctx.toast("\u23F3 \u062F\u0631 \u062D\u0627\u0644 \u0628\u0631\u0631\u0633\u06CC...");
      const report = await statusReport(ctx);
      const v = await channelsView(ctx, report);
      return ctx.show(v.text, v.kb);
    }
    case "st": {
      const v = await statsView(ctx);
      return ctx.show(v.text, v.kb);
    }
    case "bc": {
      await setState(ctx.db, ctx.uid, { a: "bc" });
      return ctx.show(
        "\u{1F4E3} <b>\u067E\u06CC\u0627\u0645 \u0647\u0645\u06AF\u0627\u0646\u06CC</b>\n\n\u067E\u06CC\u0627\u0645\u06CC \u06A9\u0647 \u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u06CC\u062F \u0628\u0631\u0627\u06CC \u0647\u0645\u0647 \u06A9\u0627\u0631\u0628\u0631\u0627\u0646 \u0627\u0631\u0633\u0627\u0644 \u0634\u0648\u062F \u0631\u0627 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F (\u0645\u062A\u0646\u060C \u0639\u06A9\u0633\u060C \u0648\u06CC\u062F\u06CC\u0648\u060C \u0641\u0627\u06CC\u0644 \u06CC\u0627 \u0641\u0648\u0631\u0648\u0627\u0631\u062F).",
        inline([[btn("\u{1F519} \u0644\u063A\u0648 \u0648 \u0628\u0627\u0632\u06AF\u0634\u062A", "A|h")]])
      );
    }
    case "bcy": {
      if (await activeBroadcast(ctx.db)) return ctx.toast("\u23F3 \u06CC\u06A9 \u0627\u0631\u0633\u0627\u0644 \u0647\u0645\u06AF\u0627\u0646\u06CC \u062F\u06CC\u06AF\u0631 \u062F\u0631 \u062D\u0627\u0644 \u0627\u062C\u0631\u0627\u0633\u062A.", true);
      await createBroadcast(ctx.db, ctx.chatId, Number(arg), ctx.now);
      await ctx.toast("\u{1F4E3} \u0627\u0631\u0633\u0627\u0644 \u0634\u0631\u0648\u0639 \u0634\u062F");
      return ctx.show("\u{1F4E3} \u0627\u0631\u0633\u0627\u0644 \u0647\u0645\u06AF\u0627\u0646\u06CC \u0634\u0631\u0648\u0639 \u0634\u062F. \u067E\u06CC\u0627\u0645\u200C\u0647\u0627 \u062F\u0631 \u067E\u0633\u200C\u0632\u0645\u06CC\u0646\u0647 \u0627\u0631\u0633\u0627\u0644 \u0645\u06CC\u200C\u0634\u0648\u0646\u062F \u0648 \u062F\u0631 \u067E\u0627\u06CC\u0627\u0646 \u06AF\u0632\u0627\u0631\u0634 \u0628\u0631\u0627\u06CC\u062A\u0627\u0646 \u0645\u06CC\u200C\u0622\u06CC\u062F.", null);
    }
    case "bcn":
      return ctx.show("\u274C \u0627\u0631\u0633\u0627\u0644 \u0647\u0645\u06AF\u0627\u0646\u06CC \u0644\u063A\u0648 \u0634\u062F.", null);
    default:
      return ctx.toast("\u062F\u0633\u062A\u0648\u0631 \u0646\u0627\u0645\u0639\u062A\u0628\u0631");
  }
}
__name(onAdminCallback, "onAdminCallback");

// src/quickadd.js
var CATEGORY_RE = /^[\p{L}\p{N}_ \-]+$/u;
function cleanCategory(raw) {
  const name = String(raw || "").replace(/\s+/g, " ").trim();
  if (!name || !CATEGORY_RE.test(name) || Array.from(name).length > MAX_CATEGORY_LEN) return null;
  return name;
}
__name(cleanCategory, "cleanCategory");
function parseQuickAdd(input, now) {
  let s = ` ${input} `;
  let priority = 2;
  let category = null;
  let due = null;
  s = s.replace(/(\s)!([1-3۱-۳])(?=\s)/g, (_, pre, d) => {
    priority = Number(normalizeInput(d));
    return pre;
  });
  s = s.replace(/(\s)#([\p{L}\p{N}_]+)(?=\s)/gu, (whole, pre, name) => {
    if (category) return whole;
    const c = cleanCategory(name.replace(/_/g, " "));
    if (!c) return whole;
    category = c;
    return pre;
  });
  const at = s.match(/\s@(?=\S)/);
  if (at) {
    const start = at.index + 1;
    const words = s.slice(start + 1).trim().split(/\s+/);
    for (let k = Math.min(words.length, 6); k >= 1; k -= 1) {
      const r = parseWhen(words.slice(0, k).join(" "), now, { defaultHour: 23, defaultMinute: 59 });
      if (r) {
        due = r;
        s = `${s.slice(0, start)} ${words.slice(k).join(" ")}`;
        break;
      }
    }
  }
  return { text: s.replace(/\s+/g, " ").trim(), priority, category, due };
}
__name(parseQuickAdd, "parseQuickAdd");

// src/telegram.js
function createApi(env) {
  const base = `${env.TELEGRAM_API || "https://api.telegram.org"}/bot${env.BOT_TOKEN}/`;
  async function call(method, params = {}) {
    try {
      const res = await fetch(base + method, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params)
      });
      const data = await res.json();
      if (!data.ok && !/message is not modified/.test(data.description || "")) {
        console.warn(`telegram ${method} failed:`, data.error_code, data.description);
      }
      return data;
    } catch (err) {
      console.error(`telegram ${method} error:`, err);
      return { ok: false, error_code: 0, description: String(err) };
    }
  }
  __name(call, "call");
  async function sendDocument(chatId, filename, content, caption) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
    }
    form.append("document", new Blob([content], { type: "text/plain" }), filename);
    try {
      const res = await fetch(base + "sendDocument", { method: "POST", body: form });
      return await res.json();
    } catch (err) {
      console.error("telegram sendDocument error:", err);
      return { ok: false, description: String(err) };
    }
  }
  __name(sendDocument, "sendDocument");
  return {
    call,
    sendDocument,
    send: /* @__PURE__ */ __name((chatId, text, extra = {}) => call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra
    }), "send"),
    edit: /* @__PURE__ */ __name((chatId, messageId, text, extra = {}) => call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra
    }), "edit"),
    answer: /* @__PURE__ */ __name((callbackId, text, showAlert = false) => call("answerCallbackQuery", { callback_query_id: callbackId, text, show_alert: showAlert }), "answer"),
    botId: /* @__PURE__ */ __name(() => Number(String(env.BOT_TOKEN || "").split(":")[0]), "botId")
  };
}
__name(createApi, "createApi");
var isBlockedError = /* @__PURE__ */ __name((r) => r && !r.ok && (r.error_code === 403 || /chat not found|blocked|deactivated/i.test(r.description || "")), "isBlockedError");

// src/bot.js
var { btn: btn2, esc: esc2, inline: inline2 } = ui_exports;
async function handleUpdate(env, update) {
  await ensureSchema(env.DB);
  const base = { env, api: createApi(env), db: env.DB, now: Date.now(), owner: ownerId(env) };
  if (update.message) return onMessage(base, update.message);
  if (update.callback_query) return onCallback(base, update.callback_query);
  return null;
}
__name(handleUpdate, "handleUpdate");
async function buildCtx(base, from, chatId) {
  const user = await touchUser(base.db, from, base.now);
  return { ...base, from, chatId, user, uid: from.id, isOwner: from.id === base.owner, state: parseState(user) };
}
__name(buildCtx, "buildCtx");
var clearState = /* @__PURE__ */ __name((ctx) => {
  if (!ctx.state) return null;
  ctx.state = null;
  return setState(ctx.db, ctx.uid, null);
}, "clearState");
var setState2 = /* @__PURE__ */ __name((ctx, state) => {
  ctx.state = state;
  return setState(ctx.db, ctx.uid, state);
}, "setState");
var DEFAULT_CTX = "p.0";
function listFromCtx(lctx) {
  const i = (lctx || DEFAULT_CTX).lastIndexOf(".");
  return { filter: lctx.slice(0, i) || "p", page: Number(lctx.slice(i + 1)) || 0 };
}
__name(listFromCtx, "listFromCtx");
async function onMessage(base, msg) {
  if (msg.chat?.type !== "private" || !msg.from || msg.from.is_bot) return null;
  const ctx = await buildCtx(base, msg.from, msg.chat.id);
  if (!ctx.isOwner) {
    const missing = await checkJoin(ctx, ctx.uid);
    if (missing.length) {
      const v = joinGateView(missing);
      return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
    }
  }
  const text = (msg.text || "").trim();
  if (text.startsWith("/")) {
    const [head, ...rest] = text.split(/\s+/);
    const cmd = head.split("@")[0].toLowerCase();
    const arg = rest.join(" ").trim();
    const command = COMMANDS[cmd];
    if (command) {
      await clearState(ctx);
      return command(ctx, arg);
    }
    if (ctx.isOwner) {
      await clearState(ctx);
      const done = await onAdminCommand(ctx, cmd, arg);
      if (done) return done;
    }
    return ctx.api.send(ctx.chatId, "\u2753 \u062F\u0633\u062A\u0648\u0631 \u0646\u0627\u0634\u0646\u0627\u062E\u062A\u0647 \u0627\u0633\u062A. \u0631\u0627\u0647\u0646\u0645\u0627: /help");
  }
  const menu = MENU[text];
  if (menu && (menu !== showAdmin || ctx.isOwner)) {
    await clearState(ctx);
    return menu(ctx);
  }
  if (ctx.state) return onStateInput(ctx, msg, text);
  if (!text) return ctx.api.send(ctx.chatId, "\u{1F4DD} \u0628\u0631\u0627\u06CC \u0627\u0641\u0632\u0648\u062F\u0646 \u06A9\u0627\u0631\u060C \u0645\u062A\u0646\u0634 \u0631\u0627 \u0628\u0647\u200C\u0635\u0648\u0631\u062A \u067E\u06CC\u0627\u0645 \u0645\u062A\u0646\u06CC \u0628\u0641\u0631\u0633\u062A\u06CC\u062F.");
  return quickAdd(ctx, text);
}
__name(onMessage, "onMessage");
var COMMANDS = {
  "/start": sendWelcome,
  "/help": /* @__PURE__ */ __name((ctx) => ctx.api.send(ctx.chatId, HELP_TEXT, { reply_markup: mainKeyboard(ctx.isOwner) }), "/help"),
  "/list": /* @__PURE__ */ __name((ctx) => sendList(ctx, "p", 0), "/list"),
  "/today": /* @__PURE__ */ __name((ctx) => sendList(ctx, "t", 0), "/today"),
  "/done": /* @__PURE__ */ __name((ctx) => sendList(ctx, "d", 0), "/done"),
  "/add": /* @__PURE__ */ __name((ctx, arg) => arg ? quickAdd(ctx, arg) : promptAdd(ctx), "/add"),
  "/search": /* @__PURE__ */ __name((ctx, arg) => arg ? sendSearch(ctx, arg) : promptSearch(ctx), "/search"),
  "/stats": sendStats,
  "/categories": sendCategories,
  "/settings": /* @__PURE__ */ __name((ctx) => sendSettings(ctx), "/settings"),
  "/cancel": /* @__PURE__ */ __name((ctx) => ctx.api.send(ctx.chatId, "\u274C \u0644\u063A\u0648 \u0634\u062F.", { reply_markup: mainKeyboard(ctx.isOwner) }), "/cancel")
};
async function showAdmin(ctx) {
  return onAdminCommand(ctx, "/admin", "");
}
__name(showAdmin, "showAdmin");
var MENU = {
  [BTN.add]: promptAdd,
  [BTN.list]: (ctx) => sendList(ctx, "p", 0),
  [BTN.today]: (ctx) => sendList(ctx, "t", 0),
  [BTN.search]: promptSearch,
  [BTN.cats]: sendCategories,
  [BTN.stats]: sendStats,
  [BTN.settings]: (ctx) => sendSettings(ctx),
  [BTN.help]: COMMANDS["/help"],
  [BTN.admin]: showAdmin
};
async function sendWelcome(ctx) {
  const name = esc2(ctx.from.first_name || "\u062F\u0648\u0633\u062A \u0645\u0646");
  const text = [
    `\u{1F44B} \u0633\u0644\u0627\u0645 ${name}!`,
    "\u0628\u0647 \u0631\u0628\u0627\u062A <b>\u062A\u0648\u062F\u0648 \u0644\u06CC\u0633\u062A</b> \u062E\u0648\u0634 \u0627\u0648\u0645\u062F\u06CC \u{1F331}",
    "\u0627\u06CC\u0646\u062C\u0627 \u06A9\u0627\u0631\u0647\u0627\u062A \u0631\u0648 \u062B\u0628\u062A \u0645\u06CC\u200C\u06A9\u0646\u06CC\u060C \u0627\u0648\u0644\u0648\u06CC\u062A \u0648 \u062F\u062F\u0644\u0627\u06CC\u0646 \u0645\u06CC\u200C\u0630\u0627\u0631\u06CC\u060C \u06CC\u0627\u062F\u0622\u0648\u0631 \u0645\u06CC\u200C\u06AF\u06CC\u0631\u06CC \u0648 \u067E\u06CC\u0634\u0631\u0641\u062A\u062A \u0631\u0648 \u0645\u06CC\u200C\u0628\u06CC\u0646\u06CC.",
    "",
    QUICK_ADD_HINT,
    "",
    "\u0627\u0632 \u0645\u0646\u0648\u06CC \u067E\u0627\u06CC\u06CC\u0646 \u0647\u0645 \u0645\u06CC\u200C\u062A\u0648\u0646\u06CC \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u06A9\u0646\u06CC \u{1F447} (\u0631\u0627\u0647\u0646\u0645\u0627\u06CC \u06A9\u0627\u0645\u0644: /help)"
  ].join("\n");
  return ctx.api.send(ctx.chatId, text, { reply_markup: mainKeyboard(ctx.isOwner) });
}
__name(sendWelcome, "sendWelcome");
function promptAdd(ctx) {
  return Promise.all([
    setState2(ctx, { a: "add" }),
    ctx.api.send(ctx.chatId, `\u270D\uFE0F \u0645\u062A\u0646 \u06A9\u0627\u0631 \u062C\u062F\u06CC\u062F \u0631\u0627 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F.

${QUICK_ADD_HINT}`, { reply_markup: cancelKb })
  ]);
}
__name(promptAdd, "promptAdd");
function promptSearch(ctx) {
  return Promise.all([
    setState2(ctx, { a: "search" }),
    ctx.api.send(ctx.chatId, "\u{1F50D} \u0639\u0628\u0627\u0631\u062A \u0645\u0648\u0631\u062F \u0646\u0638\u0631 \u0631\u0627 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F (\u062F\u0631 \u0645\u062A\u0646\u060C \u06CC\u0627\u062F\u062F\u0627\u0634\u062A \u0648 \u062F\u0633\u062A\u0647\u200C\u06CC \u06A9\u0627\u0631\u0647\u0627 \u062C\u0633\u062A\u062C\u0648 \u0645\u06CC\u200C\u0634\u0648\u062F):", { reply_markup: cancelKb })
  ]);
}
__name(promptSearch, "promptSearch");
async function quickAdd(ctx, input) {
  const p = parseQuickAdd(input, ctx.now);
  if (!p.text) return ctx.api.send(ctx.chatId, "\u2757\uFE0F \u0645\u062A\u0646 \u06A9\u0627\u0631 \u062E\u0627\u0644\u06CC \u0627\u0633\u062A. \u06CC\u06A9 \u0645\u062A\u0646 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F.");
  if (Array.from(p.text).length > MAX_TASK_LEN) return ctx.api.send(ctx.chatId, `\u2757\uFE0F \u0645\u062A\u0646 \u06A9\u0627\u0631 \u062D\u062F\u0627\u06A9\u062B\u0631 ${fa(MAX_TASK_LEN)} \u06A9\u0627\u0631\u0627\u06A9\u062A\u0631 \u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u062F \u0628\u0627\u0634\u062F.`);
  await clearState(ctx);
  const t = await addTask(
    ctx.db,
    ctx.uid,
    {
      text: p.text,
      priority: p.priority,
      category: p.category,
      due_at: p.due?.ts ?? null,
      due_time: p.due?.hasTime ? 1 : 0
    },
    ctx.now
  );
  return sendCard(ctx, t, DEFAULT_CTX, "\u2705 <b>\u0628\u0647 \u0644\u06CC\u0633\u062A \u0627\u0636\u0627\u0641\u0647 \u0634\u062F!</b>\n\n");
}
__name(quickAdd, "quickAdd");
function sendCard(ctx, t, lctx = DEFAULT_CTX, prefix = "") {
  return ctx.api.send(ctx.chatId, prefix + taskCard(t, ctx.now), { reply_markup: taskCardKb(t, lctx) });
}
__name(sendCard, "sendCard");
async function sendList(ctx, filter, page) {
  const v = await buildList(ctx, filter, page);
  return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
}
__name(sendList, "sendList");
async function buildList(ctx, filter, page) {
  let { total, rows } = await listTasks(ctx.db, ctx.uid, filter, page, ctx.now);
  if (!rows.length && page > 0) {
    page = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
    ({ total, rows } = await listTasks(ctx.db, ctx.uid, filter, page, ctx.now));
  }
  return listView({ filter, page, total, rows, now: ctx.now });
}
__name(buildList, "buildList");
async function sendSearch(ctx, query) {
  const q = query.trim().slice(0, 100);
  const rows = await searchTasks(ctx.db, ctx.uid, q);
  if (!rows.length) return ctx.api.send(ctx.chatId, `\u{1F50D} \u0646\u062A\u06CC\u062C\u0647\u200C\u0627\u06CC \u0628\u0631\u0627\u06CC \xAB${esc2(q)}\xBB \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F.`);
  const text = `\u{1F50D} <b>\u0646\u062A\u0627\u06CC\u062C \u062C\u0633\u062A\u062C\u0648 \u0628\u0631\u0627\u06CC \xAB${esc2(q)}\xBB</b> (${fa(rows.length)})

${rows.map((t) => taskLine(t, ctx.now)).join("\n\n")}`;
  const kb = inline2(rows.map((t) => [btn2(`${t.done ? "\u2705" : PRIORITY[t.priority].icon} ${fa(t.num)}. ${truncate(t.text, 30)}`, cb("T", t.num, DEFAULT_CTX))]));
  return ctx.api.send(ctx.chatId, text, { reply_markup: kb });
}
__name(sendSearch, "sendSearch");
async function sendCategories(ctx) {
  const cats = await listCategories(ctx.db, ctx.uid);
  if (!cats.length) {
    return ctx.api.send(
      ctx.chatId,
      "\u{1F5C2} \u0647\u0646\u0648\u0632 \u062F\u0633\u062A\u0647\u200C\u0627\u06CC \u0646\u0633\u0627\u062E\u062A\u0647\u200C\u0627\u06CC\u062F.\n\n\u0628\u0631\u0627\u06CC \u062F\u0633\u062A\u0647\u200C\u0628\u0646\u062F\u06CC\u060C \u0645\u0648\u0642\u0639 \u0627\u0641\u0632\u0648\u062F\u0646 \u06A9\u0627\u0631 \u0627\u0632 <code>#\u0646\u0627\u0645_\u062F\u0633\u062A\u0647</code> \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u06A9\u0646\u06CC\u062F \u06CC\u0627 \u0627\u0632 \u062F\u06A9\u0645\u0647 \xAB\u{1F5C2} \u062F\u0633\u062A\u0647\xBB \u062F\u0631 \u06A9\u0627\u0631\u062A \u0647\u0631 \u06A9\u0627\u0631."
    );
  }
  const text = `\u{1F5C2} <b>\u062F\u0633\u062A\u0647\u200C\u0647\u0627\u06CC \u0634\u0645\u0627</b>

${cats.map((c) => `\u2022 <b>${esc2(c.category)}</b> \u2014 ${fa(c.pending)} \u062F\u0631 \u062C\u0631\u06CC\u0627\u0646 \u0627\u0632 ${fa(c.total)}`).join("\n")}`;
  const kb = inline2(cats.map((c) => [btn2(`\u{1F5C2} ${c.category} (${fa(c.pending)})`, `L|c${c.category}|0`)]));
  return ctx.api.send(ctx.chatId, text, { reply_markup: kb });
}
__name(sendCategories, "sendCategories");
async function sendStats(ctx) {
  const s = await userStats(ctx.db, ctx.uid, ctx.now);
  const cats = await listCategories(ctx.db, ctx.uid);
  const ratio = s.total ? s.done / s.total : 0;
  const lines = [
    "\u{1F4CA} <b>\u0622\u0645\u0627\u0631 \u0634\u0645\u0627</b>",
    "",
    `\u{1F4DD} \u06A9\u0644 \u06A9\u0627\u0631\u0647\u0627: <b>${fa(s.total)}</b>`,
    `\u2705 \u0627\u0646\u062C\u0627\u0645\u200C\u0634\u062F\u0647: <b>${fa(s.done)}</b>`,
    `\u23F3 \u062F\u0631 \u062C\u0631\u06CC\u0627\u0646: <b>${fa(s.pending)}</b>`,
    `\u26A0\uFE0F \u0639\u0642\u0628\u200C\u0627\u0641\u062A\u0627\u062F\u0647: <b>${fa(s.overdue)}</b>`,
    `\u{1F4C5} \u062F\u062F\u0644\u0627\u06CC\u0646 \u0627\u0645\u0631\u0648\u0632: <b>${fa(s.today)}</b>`,
    `\u{1F3C1} \u0627\u0646\u062C\u0627\u0645\u200C\u0634\u062F\u0647 \u0627\u0645\u0631\u0648\u0632: <b>${fa(s.done_today)}</b>`,
    `\u{1F5D3} \u0627\u0646\u062C\u0627\u0645\u200C\u0634\u062F\u0647 \u062F\u0631 \u06F7 \u0631\u0648\u0632 \u0627\u062E\u06CC\u0631: <b>${fa(s.week)}</b>`,
    `\u{1F501} \u06A9\u0627\u0631\u0647\u0627\u06CC \u062A\u06A9\u0631\u0627\u0631\u06CC: <b>${fa(s.recurring)}</b> \xB7 \u23F0 \u06CC\u0627\u062F\u0622\u0648\u0631\u0647\u0627\u06CC \u0641\u0639\u0627\u0644: <b>${fa(s.reminders)}</b>`,
    "",
    `\u{1F4C8} \u067E\u06CC\u0634\u0631\u0641\u062A \u06A9\u0644\u06CC: ${progressBar(ratio)} ${fa(Math.round(ratio * 100))}\u066A`,
    "",
    `\u{1F525} \u0627\u0648\u0644\u0648\u06CC\u062A \u06A9\u0627\u0631\u0647\u0627\u06CC \u062F\u0631 \u062C\u0631\u06CC\u0627\u0646: \u{1F534} ${fa(s.p1)} \xB7 \u{1F7E1} ${fa(s.p2)} \xB7 \u{1F7E2} ${fa(s.p3)}`
  ];
  if (cats.length) lines.push(`\u{1F5C2} \u062F\u0633\u062A\u0647\u200C\u0647\u0627: ${cats.slice(0, 8).map((c) => `${esc2(c.category)} ${fa(c.pending)}/${fa(c.total)}`).join(" \xB7 ")}`);
  if (s.total && s.pending === 0) lines.push("", "\u{1F389} \u0647\u0645\u0647 \u06A9\u0627\u0631\u0647\u0627 \u0627\u0646\u062C\u0627\u0645 \u0634\u062F\u0647\u061B \u0639\u0627\u0644\u06CC\u0647!");
  else if (s.overdue) lines.push("", "\u{1F4AA} \u0686\u0646\u062F \u06A9\u0627\u0631 \u0639\u0642\u0628\u200C\u0627\u0641\u062A\u0627\u062F\u0647 \u062F\u0627\u0631\u06CC\u062F\u061B \u0627\u0632 \xAB\u{1F4C5} \u0627\u0645\u0631\u0648\u0632\xBB \u0634\u0631\u0648\u0639 \u06A9\u0646\u06CC\u062F.");
  return ctx.api.send(ctx.chatId, lines.join("\n"));
}
__name(sendStats, "sendStats");
function settingsView(ctx) {
  const h = ctx.user.digest_hour;
  const text = [
    "\u2699\uFE0F <b>\u062A\u0646\u0638\u06CC\u0645\u0627\u062A</b>",
    "",
    `\u{1F305} \u062E\u0644\u0627\u0635\u0647 \u0631\u0648\u0632\u0627\u0646\u0647: ${h === null || h === void 0 ? "\u062E\u0627\u0645\u0648\u0634" : `\u0647\u0631 \u0631\u0648\u0632 \u0633\u0627\u0639\u062A ${fa(`${String(h).padStart(2, "0")}:00`)}`}`,
    "",
    "\u{1F4E4} \xAB\u062E\u0631\u0648\u062C\u06CC \u0641\u0627\u06CC\u0644\xBB \u06CC\u06A9 \u0641\u0627\u06CC\u0644 \u0645\u062A\u0646\u06CC \u0627\u0632 \u0647\u0645\u0647 \u06A9\u0627\u0631\u0647\u0627\u06CC\u062A\u0627\u0646 \u0645\u06CC\u200C\u0641\u0631\u0633\u062A\u062F.",
    "\u{1F9F9} \xAB\u067E\u0627\u06A9\u0633\u0627\u0632\u06CC\xBB \u0647\u0645\u0647 \u06A9\u0627\u0631\u0647\u0627\u06CC \u0627\u0646\u062C\u0627\u0645\u200C\u0634\u062F\u0647 \u0631\u0627 \u062D\u0630\u0641 \u0645\u06CC\u200C\u06A9\u0646\u062F."
  ].join("\n");
  const kb = inline2([
    [btn2("\u{1F305} \u062E\u0644\u0627\u0635\u0647 \u0631\u0648\u0632\u0627\u0646\u0647", "S|dg")],
    [btn2("\u{1F4E4} \u062E\u0631\u0648\u062C\u06CC \u0641\u0627\u06CC\u0644", "S|ex"), btn2("\u{1F9F9} \u067E\u0627\u06A9\u0633\u0627\u0632\u06CC \u0627\u0646\u062C\u0627\u0645\u200C\u0634\u062F\u0647\u200C\u0647\u0627", "S|cl")]
  ]);
  return { text, kb };
}
__name(settingsView, "settingsView");
function sendSettings(ctx) {
  const v = settingsView(ctx);
  return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
}
__name(sendSettings, "sendSettings");
async function onStateInput(ctx, msg, text) {
  const s = ctx.state;
  if (ctx.isOwner && (s.a === "addch" || s.a === "bc")) return onAdminState(ctx, msg);
  if (!text) return ctx.api.send(ctx.chatId, "\u{1F4DD} \u0644\u0637\u0641\u0627\u064B \u067E\u06CC\u0627\u0645 \u0645\u062A\u0646\u06CC \u0628\u0641\u0631\u0633\u062A\u06CC\u062F (\u06CC\u0627 /cancel \u0628\u0631\u0627\u06CC \u0644\u063A\u0648).");
  if (s.a === "add") return quickAdd(ctx, text);
  if (s.a === "search") {
    await clearState(ctx);
    return sendSearch(ctx, text);
  }
  const t = s.n ? await getTask(ctx.db, ctx.uid, s.n) : null;
  if (!t) {
    await clearState(ctx);
    return ctx.api.send(ctx.chatId, "\u2757\uFE0F \u0627\u06CC\u0646 \u06A9\u0627\u0631 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F (\u0634\u0627\u06CC\u062F \u062D\u0630\u0641 \u0634\u062F\u0647).");
  }
  const lctx = s.c || DEFAULT_CTX;
  const retry = /* @__PURE__ */ __name((message) => ctx.api.send(ctx.chatId, message, { reply_markup: inline2([[btn2("\u274C \u0644\u063A\u0648", cb("T", t.num, lctx))]]) }), "retry");
  switch (s.a) {
    case "text": {
      if (Array.from(text).length > MAX_TASK_LEN) return retry(`\u2757\uFE0F \u062D\u062F\u0627\u06A9\u062B\u0631 ${fa(MAX_TASK_LEN)} \u06A9\u0627\u0631\u0627\u06A9\u062A\u0631. \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F:`);
      await updateTask(ctx.db, ctx.uid, t.num, { text });
      break;
    }
    case "note": {
      if (Array.from(text).length > MAX_NOTE_LEN) return retry(`\u2757\uFE0F \u06CC\u0627\u062F\u062F\u0627\u0634\u062A \u062D\u062F\u0627\u06A9\u062B\u0631 ${fa(MAX_NOTE_LEN)} \u06A9\u0627\u0631\u0627\u06A9\u062A\u0631 \u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u062F \u0628\u0627\u0634\u062F. \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F:`);
      await updateTask(ctx.db, ctx.uid, t.num, { note: text });
      break;
    }
    case "cat": {
      const name = cleanCategory(text.replace(/^#/, ""));
      if (!name) return retry("\u2757\uFE0F \u0646\u0627\u0645 \u062F\u0633\u062A\u0647 \u0641\u0642\u0637 \u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u062F \u062D\u0631\u0648\u0641\u060C \u0639\u062F\u062F\u060C \u0641\u0627\u0635\u0644\u0647 \u0648 _ \u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F \u0648 \u062D\u062F\u0627\u06A9\u062B\u0631 \u06F2\u06F0 \u06A9\u0627\u0631\u0627\u06A9\u062A\u0631 \u0628\u0627\u0634\u062F. \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F:");
      await updateTask(ctx.db, ctx.uid, t.num, { category: name });
      break;
    }
    case "due": {
      const r = parseWhen(text, ctx.now, { defaultHour: 23, defaultMinute: 59 });
      if (!r) return retry("\u2757\uFE0F \u062A\u0627\u0631\u06CC\u062E \u0631\u0627 \u0645\u062A\u0648\u062C\u0647 \u0646\u0634\u062F\u0645. \u0646\u0645\u0648\u0646\u0647\u200C\u0647\u0627: <code>\u0641\u0631\u062F\u0627</code>\u060C <code>\u0634\u0646\u0628\u0647</code>\u060C <code>1405/08/10</code>\u060C <code>\u0641\u0631\u062F\u0627 18:00</code>");
      await updateTask(ctx.db, ctx.uid, t.num, { due_at: r.ts, due_time: r.hasTime ? 1 : 0 });
      break;
    }
    case "rem": {
      const r = parseWhen(text, ctx.now, { defaultHour: 9, defaultMinute: 0 });
      if (!r) return retry("\u2757\uFE0F \u0632\u0645\u0627\u0646 \u0631\u0627 \u0645\u062A\u0648\u062C\u0647 \u0646\u0634\u062F\u0645. \u0646\u0645\u0648\u0646\u0647\u200C\u0647\u0627: <code>30 \u062F\u0642\u06CC\u0642\u0647 \u062F\u06CC\u06AF\u0631</code>\u060C <code>18:30</code>\u060C <code>\u0641\u0631\u062F\u0627 \u0633\u0627\u0639\u062A 9</code>");
      if (r.ts <= ctx.now) return retry("\u2757\uFE0F \u0627\u06CC\u0646 \u0632\u0645\u0627\u0646 \u06AF\u0630\u0634\u062A\u0647 \u0627\u0633\u062A. \u06CC\u06A9 \u0632\u0645\u0627\u0646 \u062F\u0631 \u0622\u06CC\u0646\u062F\u0647 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F:");
      await updateTask(ctx.db, ctx.uid, t.num, { remind_at: r.ts });
      break;
    }
    default:
      await clearState(ctx);
      return COMMANDS["/cancel"](ctx);
  }
  await clearState(ctx);
  return sendCard(ctx, await getTask(ctx.db, ctx.uid, t.num), lctx, "\u270F\uFE0F <b>\u0630\u062E\u06CC\u0631\u0647 \u0634\u062F.</b>\n\n");
}
__name(onStateInput, "onStateInput");
async function onCallback(base, cq) {
  if (!cq.message || cq.message.chat?.type !== "private") return base.api.answer(cq.id);
  const ctx = await buildCtx(base, cq.from, cq.message.chat.id);
  ctx.msgId = cq.message.message_id;
  let answered = false;
  ctx.toast = (text, alert = false) => {
    answered = true;
    return ctx.api.answer(cq.id, text, alert);
  };
  ctx.show = async (text, kb) => {
    const extra = kb ? { reply_markup: kb } : {};
    const r = await ctx.api.edit(ctx.chatId, ctx.msgId, text, extra);
    if (!r.ok && !/not modified/.test(r.description || "")) return ctx.api.send(ctx.chatId, text, extra);
    return r;
  };
  try {
    await routeCallback(ctx, cq.data || "");
  } finally {
    if (!answered) await ctx.api.answer(cq.id);
  }
}
__name(onCallback, "onCallback");
async function onJoinCheck(ctx) {
  const missing = ctx.isOwner ? [] : await checkJoin(ctx, ctx.uid, { force: true });
  if (missing.length) {
    await ctx.toast("\u274C \u0647\u0646\u0648\u0632 \u062F\u0631 \u0647\u0645\u0647 \u06A9\u0627\u0646\u0627\u0644\u200C\u0647\u0627 \u0639\u0636\u0648 \u0646\u0634\u062F\u0647\u200C\u0627\u06CC\u062F.", true);
    const v = joinGateView(missing);
    return ctx.show(v.text, v.kb);
  }
  await ctx.toast("\u2705 \u0639\u0636\u0648\u06CC\u062A \u0634\u0645\u0627 \u062A\u0623\u06CC\u06CC\u062F \u0634\u062F");
  await ctx.show("\u2705 \u0639\u0636\u0648\u06CC\u062A \u0634\u0645\u0627 \u062A\u0623\u06CC\u06CC\u062F \u0634\u062F. \u062E\u0648\u0634 \u0622\u0645\u062F\u06CC\u062F!", null);
  return sendWelcome(ctx);
}
__name(onJoinCheck, "onJoinCheck");
async function routeCallback(ctx, data) {
  if (data === "J") return onJoinCheck(ctx);
  if (!ctx.isOwner) {
    const missing = await checkJoin(ctx, ctx.uid);
    if (missing.length) {
      await ctx.toast("\u{1F512} \u0627\u0648\u0644 \u0628\u0627\u06CC\u062F \u062F\u0631 \u06A9\u0627\u0646\u0627\u0644\u200C\u0647\u0627 \u0639\u0636\u0648 \u0634\u0648\u06CC\u062F.", true);
      const v = joinGateView(missing);
      return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
    }
  }
  const [action, ...p] = data.split("|");
  switch (action) {
    case "N":
      return null;
    case "CX":
      await clearState(ctx);
      return ctx.show("\u274C \u0644\u063A\u0648 \u0634\u062F.", null);
    case "ADD":
      await clearState(ctx);
      return promptAdd(ctx);
    case "L": {
      await clearState(ctx);
      const v = await buildList(ctx, p[0] || "p", Number(p[1]) || 0);
      return ctx.show(v.text, v.kb);
    }
    case "S":
      return onSettingsCallback(ctx, p);
    case "A":
      if (!ctx.isOwner) return ctx.toast("\u26D4\uFE0F \u0627\u06CC\u0646 \u0628\u062E\u0634 \u0641\u0642\u0637 \u0628\u0631\u0627\u06CC \u0645\u0627\u0644\u06A9 \u0631\u0628\u0627\u062A \u0627\u0633\u062A.", true);
      return onAdminCallback(ctx, p);
    case "SN":
      return onSnooze(ctx, Number(p[0]), Number(p[1]));
    default:
      return onTaskCallback(ctx, action, p);
  }
}
__name(routeCallback, "routeCallback");
async function onTaskCallback(ctx, action, p) {
  const num = Number(p[0]);
  const t = Number.isInteger(num) ? await getTask(ctx.db, ctx.uid, num) : null;
  if (!t) {
    await ctx.toast("\u2757\uFE0F \u0627\u06CC\u0646 \u06A9\u0627\u0631 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F (\u0634\u0627\u06CC\u062F \u062D\u0630\u0641 \u0634\u062F\u0647).", true);
    const v = await buildList(ctx, "p", 0);
    return ctx.show(v.text, v.kb);
  }
  const lctx = action === "T" || action === "D" || action === "X" || action === "XX" ? p[1] || DEFAULT_CTX : p[2] || DEFAULT_CTX;
  const card = /* @__PURE__ */ __name(async (toast) => {
    if (toast) await ctx.toast(toast);
    const fresh = await getTask(ctx.db, ctx.uid, num);
    return ctx.show(taskCard(fresh, ctx.now), taskCardKb(fresh, lctx));
  }, "card");
  const backKb = /* @__PURE__ */ __name((rows = []) => inline2([...rows, [btn2("\u{1F519} \u0628\u0627\u0632\u06AF\u0634\u062A", cb("T", num, lctx))]]), "backKb");
  switch (action) {
    case "T":
      await clearState(ctx);
      return card();
    case "D":
      return card(await toggleDone(ctx, t));
    case "X":
      return ctx.show(
        `\u{1F5D1} \u06A9\u0627\u0631 \xAB<b>${esc2(truncate(t.text, 60))}</b>\xBB \u062D\u0630\u0641 \u0634\u0648\u062F\u061F`,
        inline2([[btn2("\u2705 \u0628\u0644\u0647\u060C \u062D\u0630\u0641 \u0634\u0648\u062F", cb("XX", num, lctx)), btn2("\u274C \u0646\u0647", cb("T", num, lctx))]])
      );
    case "XX": {
      await deleteTask(ctx.db, ctx.uid, num);
      await ctx.toast("\u{1F5D1} \u062D\u0630\u0641 \u0634\u062F");
      const { filter, page } = listFromCtx(lctx);
      const v = await buildList(ctx, filter, page);
      return ctx.show(v.text, v.kb);
    }
    case "E":
      return onEditMenu(ctx, t, p[1], lctx, backKb);
    case "P":
      await updateTask(ctx.db, ctx.uid, num, { priority: Math.min(3, Math.max(1, Number(p[1]) || 2)) });
      return card(`\u0627\u0648\u0644\u0648\u06CC\u062A: ${PRIORITY[Number(p[1])]?.label || "\u0645\u062A\u0648\u0633\u0637"}`);
    case "C": {
      await clearState(ctx);
      const name = p[1] === "-" ? null : cleanCategory(p[1]);
      await updateTask(ctx.db, ctx.uid, num, { category: name });
      return card(name ? `\u{1F5C2} \u062F\u0633\u062A\u0647: ${name}` : "\u{1F5C2} \u062F\u0633\u062A\u0647 \u062D\u0630\u0641 \u0634\u062F");
    }
    case "DD": {
      await clearState(ctx);
      if (p[1] === "x") {
        await updateTask(ctx.db, ctx.uid, num, { due_at: null, due_time: 0 });
        return card("\u{1F4C5} \u062F\u062F\u0644\u0627\u06CC\u0646 \u062D\u0630\u0641 \u0634\u062F");
      }
      const days = Number(p[1]) || 0;
      const base = days === 30 ? addRepeat(ctx.now, "m") : ctx.now + days * DAY;
      const lp = localParts(base);
      const ts = fromLocal(lp.y, lp.m, lp.d, 23, 59);
      await updateTask(ctx.db, ctx.uid, num, { due_at: ts, due_time: 0 });
      return card(`\u{1F4C5} \u062F\u062F\u0644\u0627\u06CC\u0646: ${formatShortDate(ts)}`);
    }
    case "RM": {
      await clearState(ctx);
      if (p[1] === "x") {
        await updateTask(ctx.db, ctx.uid, num, { remind_at: null });
        return card("\u23F0 \u06CC\u0627\u062F\u0622\u0648\u0631 \u062D\u0630\u0641 \u0634\u062F");
      }
      const ts = reminderPreset(ctx.now, p[1], t);
      if (!ts || ts <= ctx.now) return ctx.toast("\u2757\uFE0F \u0627\u06CC\u0646 \u0632\u0645\u0627\u0646 \u06AF\u0630\u0634\u062A\u0647 \u0627\u0633\u062A\u061B \u0632\u0645\u0627\u0646 \u062F\u06CC\u06AF\u0631\u06CC \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F.", true);
      await updateTask(ctx.db, ctx.uid, num, { remind_at: ts });
      return card(`\u23F0 \u06CC\u0627\u062F\u0622\u0648\u0631: ${formatDate(ts, { now: ctx.now })}`);
    }
    case "RP": {
      const repeat = ["d", "w", "m"].includes(p[1]) ? p[1] : null;
      await updateTask(ctx.db, ctx.uid, num, { repeat });
      return card(repeat ? `\u{1F501} \u062A\u06A9\u0631\u0627\u0631 ${REPEAT_LABELS[repeat]}` : "\u{1F501} \u062A\u06A9\u0631\u0627\u0631 \u062E\u0627\u0645\u0648\u0634 \u0634\u062F");
    }
    case "NX":
      await clearState(ctx);
      await updateTask(ctx.db, ctx.uid, num, { note: null });
      return card("\u{1F4DD} \u06CC\u0627\u062F\u062F\u0627\u0634\u062A \u062D\u0630\u0641 \u0634\u062F");
    default:
      return ctx.toast("\u062F\u0633\u062A\u0648\u0631 \u0646\u0627\u0645\u0639\u062A\u0628\u0631");
  }
}
__name(onTaskCallback, "onTaskCallback");
async function onEditMenu(ctx, t, field, lctx, backKb) {
  const num = t.num;
  const title = `<b>${fa(num)}. ${esc2(truncate(t.text, 60))}</b>

`;
  switch (field) {
    case "t":
      await setState2(ctx, { a: "text", n: num, c: lctx });
      return ctx.show(`${title}\u270F\uFE0F \u0645\u062A\u0646 \u062C\u062F\u06CC\u062F \u0627\u06CC\u0646 \u06A9\u0627\u0631 \u0631\u0627 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F:

<code>${esc2(t.text)}</code>`, backKb());
    case "n":
      await setState2(ctx, { a: "note", n: num, c: lctx });
      return ctx.show(
        `${title}\u{1F4DD} \u06CC\u0627\u062F\u062F\u0627\u0634\u062A \u0627\u06CC\u0646 \u06A9\u0627\u0631 \u0631\u0627 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F${t.note ? " (\u062C\u0627\u06CC\u06AF\u0632\u06CC\u0646 \u06CC\u0627\u062F\u062F\u0627\u0634\u062A \u0641\u0639\u0644\u06CC \u0645\u06CC\u200C\u0634\u0648\u062F)" : ""}:${t.note ? `

<i>${esc2(t.note)}</i>` : ""}`,
        backKb(t.note ? [[btn2("\u{1F5D1} \u062D\u0630\u0641 \u06CC\u0627\u062F\u062F\u0627\u0634\u062A", cb("NX", num, "", lctx))]] : [])
      );
    case "p":
      return ctx.show(`${title}\u{1F525} \u0627\u0648\u0644\u0648\u06CC\u062A \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F:`, priorityKb(num, lctx));
    case "c": {
      await setState2(ctx, { a: "cat", n: num, c: lctx });
      const cats = await listCategories(ctx.db, ctx.uid);
      return ctx.show(`${title}\u{1F5C2} \u06CC\u06A9 \u062F\u0633\u062A\u0647 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F \u06CC\u0627 <b>\u0646\u0627\u0645 \u062F\u0633\u062A\u0647 \u062C\u062F\u06CC\u062F</b> \u0631\u0627 \u062A\u0627\u06CC\u067E \u06A9\u0646\u06CC\u062F:`, categoryKb(num, cats, t.category, lctx));
    }
    case "d":
      await setState2(ctx, { a: "due", n: num, c: lctx });
      return ctx.show(
        `${title}\u{1F4C5} \u062F\u062F\u0644\u0627\u06CC\u0646 \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F \u06CC\u0627 \u062A\u0627\u06CC\u067E \u06A9\u0646\u06CC\u062F.
\u0646\u0645\u0648\u0646\u0647: <code>\u0641\u0631\u062F\u0627</code>\u060C <code>\u0634\u0646\u0628\u0647 18:00</code>\u060C <code>1405/08/10</code>\u060C <code>+5</code>`,
        dueKb(num, !!t.due_at, lctx)
      );
    case "r":
      await setState2(ctx, { a: "rem", n: num, c: lctx });
      return ctx.show(
        `${title}\u23F0 \u0632\u0645\u0627\u0646 \u06CC\u0627\u062F\u0622\u0648\u0631\u06CC \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F \u06CC\u0627 \u062A\u0627\u06CC\u067E \u06A9\u0646\u06CC\u062F.
\u0646\u0645\u0648\u0646\u0647: <code>45 \u062F\u0642\u06CC\u0642\u0647 \u062F\u06CC\u06AF\u0631</code>\u060C <code>18:30</code>\u060C <code>\u0641\u0631\u062F\u0627 \u0633\u0627\u0639\u062A 8</code>\u060C <code>1405/08/10 10:00</code>`,
        reminderKb(num, t, lctx)
      );
    case "R":
      return ctx.show(
        `${title}\u{1F501} \u062A\u06A9\u0631\u0627\u0631 \u0627\u06CC\u0646 \u06A9\u0627\u0631 \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F.
\u0628\u0627 \u0627\u0646\u062C\u0627\u0645 \u0647\u0631 \u0646\u0648\u0628\u062A\u060C \u062F\u062F\u0644\u0627\u06CC\u0646 (\u0648 \u06CC\u0627\u062F\u0622\u0648\u0631) \u062E\u0648\u062F\u06A9\u0627\u0631 \u0628\u0647 \u0646\u0648\u0628\u062A \u0628\u0639\u062F \u0645\u0646\u062A\u0642\u0644 \u0645\u06CC\u200C\u0634\u0648\u062F.`,
        repeatKb(num, t.repeat, lctx)
      );
    default:
      return ctx.toast("\u062F\u0633\u062A\u0648\u0631 \u0646\u0627\u0645\u0639\u062A\u0628\u0631");
  }
}
__name(onEditMenu, "onEditMenu");
function reminderPreset(now, preset, t) {
  if (/^\d+$/.test(preset)) return now + Number(preset) * MINUTE;
  const lp = localParts(now);
  if (preset === "t9") {
    const tp = localParts(now + DAY);
    return fromLocal(tp.y, tp.m, tp.d, 9, 0);
  }
  if (preset === "n21") return fromLocal(lp.y, lp.m, lp.d, 21, 0);
  if (preset === "due") return t.due_at;
  if (preset === "due60") return t.due_at ? t.due_at - 60 * MINUTE : null;
  return null;
}
__name(reminderPreset, "reminderPreset");
async function toggleDone(ctx, t) {
  if (t.done) {
    await updateTask(ctx.db, ctx.uid, t.num, { done: 0, done_at: null });
    return "\u21A9\uFE0F \u0628\u0647 \u06A9\u0627\u0631\u0647\u0627\u06CC \u062F\u0631 \u062C\u0631\u06CC\u0627\u0646 \u0628\u0631\u06AF\u0634\u062A";
  }
  if (t.repeat) {
    const today = localParts(ctx.now);
    const base = t.due_at ?? fromLocal(today.y, today.m, today.d, 23, 59);
    const next = nextOccurrence(base, t.repeat, ctx.now);
    await addTask(
      ctx.db,
      ctx.uid,
      { text: t.text, note: t.note, priority: t.priority, category: t.category, due_at: t.due_at, due_time: t.due_time, done: 1, done_at: ctx.now },
      ctx.now
    );
    let remind = t.remind_at && t.remind_at <= base ? t.remind_at + (next - base) : t.remind_at;
    if (remind && remind <= ctx.now) remind = nextOccurrence(remind, t.repeat, ctx.now);
    await updateTask(ctx.db, ctx.uid, t.num, { due_at: next, due_time: t.due_at ? t.due_time : 0, remind_at: remind });
    return `\u{1F501} \u0627\u0646\u062C\u0627\u0645 \u0634\u062F! \u0646\u0648\u0628\u062A \u0628\u0639\u062F: ${formatShortDate(next)}`;
  }
  await updateTask(ctx.db, ctx.uid, t.num, { done: 1, done_at: ctx.now, remind_at: null });
  return "\u2705 \u0622\u0641\u0631\u06CC\u0646! \u0627\u0646\u062C\u0627\u0645 \u0634\u062F";
}
__name(toggleDone, "toggleDone");
async function onSnooze(ctx, num, minutes) {
  const t = await getTask(ctx.db, ctx.uid, num);
  if (!t || t.done) return ctx.show("\u2139\uFE0F \u0627\u06CC\u0646 \u06A9\u0627\u0631 \u062F\u06CC\u06AF\u0631 \u062F\u0631 \u062C\u0631\u06CC\u0627\u0646 \u0646\u06CC\u0633\u062A.", null);
  const ts = ctx.now + (minutes || 10) * MINUTE;
  await updateTask(ctx.db, ctx.uid, num, { remind_at: ts });
  await ctx.toast("\u{1F634} \u0628\u0647 \u062A\u0639\u0648\u06CC\u0642 \u0627\u0641\u062A\u0627\u062F");
  return ctx.show(
    `\u{1F634} \u06CC\u0627\u062F\u0622\u0648\u0631\u06CC \xAB<b>${esc2(t.text)}</b>\xBB \u0628\u0647 \u0633\u0627\u0639\u062A ${formatTime(ts)} \u0645\u0648\u06A9\u0648\u0644 \u0634\u062F.`,
    inline2([[btn2("\u{1F4C4} \u062C\u0632\u0626\u06CC\u0627\u062A \u06A9\u0627\u0631", cb("T", num, DEFAULT_CTX))]])
  );
}
__name(onSnooze, "onSnooze");
async function onSettingsCallback(ctx, p) {
  const [action, arg] = p;
  switch (action) {
    case "h": {
      const v = settingsView(ctx);
      return ctx.show(v.text, v.kb);
    }
    case "dg": {
      const hours = [6, 7, 8, 9, 10, 12, 14, 18, 20, 21, 22, 23];
      const rows = [];
      for (let i = 0; i < hours.length; i += 4) {
        rows.push(hours.slice(i, i + 4).map((h) => btn2(`${ctx.user.digest_hour === h ? "\u2713 " : ""}${fa(`${h}:00`)}`, `S|dh|${h}`)));
      }
      rows.push([btn2("\u{1F515} \u062E\u0627\u0645\u0648\u0634", "S|dh|x"), btn2("\u{1F519} \u0628\u0627\u0632\u06AF\u0634\u062A", "S|h")]);
      return ctx.show(
        "\u{1F305} <b>\u062E\u0644\u0627\u0635\u0647 \u0631\u0648\u0632\u0627\u0646\u0647</b>\n\n\u0647\u0631 \u0631\u0648\u0632 \u062F\u0631 \u0633\u0627\u0639\u062A \u0627\u0646\u062A\u062E\u0627\u0628\u06CC\u060C \u0644\u06CC\u0633\u062A \u06A9\u0627\u0631\u0647\u0627\u06CC \u0627\u0645\u0631\u0648\u0632\u060C \u06A9\u0627\u0631\u0647\u0627\u06CC \u0639\u0642\u0628\u200C\u0627\u0641\u062A\u0627\u062F\u0647 \u0648 \u06A9\u0627\u0631\u0647\u0627\u06CC \u0645\u0647\u0645 \u0628\u0631\u0627\u06CC\u062A\u0627\u0646 \u0627\u0631\u0633\u0627\u0644 \u0645\u06CC\u200C\u0634\u0648\u062F.\n\u0633\u0627\u0639\u062A \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F:",
        inline2(rows)
      );
    }
    case "dh": {
      const hour = arg === "x" ? null : Math.min(23, Math.max(0, Number(arg)));
      const last = hour !== null && localParts(ctx.now).hh >= hour ? localDateKey(ctx.now) : null;
      await setDigest(ctx.db, ctx.uid, hour, last);
      ctx.user.digest_hour = hour;
      await ctx.toast(hour === null ? "\u{1F515} \u062E\u0644\u0627\u0635\u0647 \u0631\u0648\u0632\u0627\u0646\u0647 \u062E\u0627\u0645\u0648\u0634 \u0634\u062F" : `\u{1F305} \u0647\u0631 \u0631\u0648\u0632 \u0633\u0627\u0639\u062A ${fa(hour)}:\u06F0\u06F0`);
      const v = settingsView(ctx);
      return ctx.show(v.text, v.kb);
    }
    case "ex": {
      const tasks = await allTasks(ctx.db, ctx.uid);
      if (!tasks.length) return ctx.toast("\u0647\u0646\u0648\u0632 \u06A9\u0627\u0631\u06CC \u062B\u0628\u062A \u0646\u06A9\u0631\u062F\u0647\u200C\u0627\u06CC\u062F.", true);
      await ctx.toast("\u{1F4E4} \u062F\u0631 \u062D\u0627\u0644 \u0622\u0645\u0627\u062F\u0647\u200C\u0633\u0627\u0632\u06CC \u0641\u0627\u06CC\u0644...");
      return ctx.api.sendDocument(ctx.chatId, `todo-${localDateKey(ctx.now)}.txt`, exportText(tasks, ctx.now), `\u{1F4E4} \u062E\u0631\u0648\u062C\u06CC ${fa(tasks.length)} \u06A9\u0627\u0631 \u0634\u0645\u0627`);
    }
    case "cl":
      return ctx.show("\u{1F9F9} \u0647\u0645\u0647 \u06A9\u0627\u0631\u0647\u0627\u06CC <b>\u0627\u0646\u062C\u0627\u0645\u200C\u0634\u062F\u0647</b> \u0628\u0631\u0627\u06CC \u0647\u0645\u06CC\u0634\u0647 \u062D\u0630\u0641 \u0634\u0648\u0646\u062F\u061F", inline2([[btn2("\u2705 \u0628\u0644\u0647\u060C \u067E\u0627\u06A9 \u06A9\u0646", "S|cly"), btn2("\u274C \u0646\u0647", "S|h")]]));
    case "cly": {
      const r = await clearDone(ctx.db, ctx.uid);
      await ctx.toast(`\u{1F9F9} ${fa(r.meta.changes || 0)} \u06A9\u0627\u0631 \u0627\u0646\u062C\u0627\u0645\u200C\u0634\u062F\u0647 \u067E\u0627\u06A9 \u0634\u062F`, true);
      const v = settingsView(ctx);
      return ctx.show(v.text, v.kb);
    }
    default:
      return ctx.toast("\u062F\u0633\u062A\u0648\u0631 \u0646\u0627\u0645\u0639\u062A\u0628\u0631");
  }
}
__name(onSettingsCallback, "onSettingsCallback");
function exportText(tasks, now) {
  const pending = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const line = /* @__PURE__ */ __name((t) => {
    const parts = [`${t.done ? "[\u2714]" : `[${PRIORITY[t.priority].icon}]`} #${t.num} ${t.text}`];
    if (t.category) parts.push(`\u062F\u0633\u062A\u0647: ${t.category}`);
    if (t.due_at) parts.push(`\u062F\u062F\u0644\u0627\u06CC\u0646: ${formatDate(t.due_at, { time: !!t.due_time, now })}`);
    if (t.remind_at && !t.done) parts.push(`\u06CC\u0627\u062F\u0622\u0648\u0631: ${formatDate(t.remind_at, { now })}`);
    if (t.repeat) parts.push(`\u062A\u06A9\u0631\u0627\u0631: ${REPEAT_LABELS[t.repeat]}`);
    if (t.done_at) parts.push(`\u0627\u0646\u062C\u0627\u0645: ${formatDate(t.done_at, { now })}`);
    return parts.join(" | ") + (t.note ? `
      \u06CC\u0627\u062F\u062F\u0627\u0634\u062A: ${t.note.replace(/\n/g, "\n      ")}` : "");
  }, "line");
  return [
    `\u062E\u0631\u0648\u062C\u06CC \u062A\u0648\u062F\u0648 \u0644\u06CC\u0633\u062A \u2014 ${formatDate(now, { now })}`,
    "=".repeat(40),
    "",
    `\u23F3 \u062F\u0631 \u062C\u0631\u06CC\u0627\u0646 (${pending.length})`,
    ...pending.map(line),
    "",
    `\u2705 \u0627\u0646\u062C\u0627\u0645\u200C\u0634\u062F\u0647 (${done.length})`,
    ...done.map(line),
    ""
  ].join("\n");
}
__name(exportText, "exportText");

// src/cron.js
var transient = /* @__PURE__ */ __name((r) => !r.ok && (r.error_code === 429 || r.error_code === 0 || r.error_code >= 500), "transient");
async function runCron(env, now) {
  await ensureSchema(env.DB);
  const ctx = { env, db: env.DB, api: createApi(env), now };
  const results = await Promise.allSettled([sendReminders(ctx), sendDigests(ctx), runBroadcast(ctx)]);
  for (const r of results) if (r.status === "rejected") console.error("cron job failed:", r.reason?.stack || r.reason);
  return results.map((r) => r.status === "fulfilled" ? r.value : 0);
}
__name(runCron, "runCron");
async function sendReminders(ctx) {
  const tasks = await dueReminders(ctx.db, ctx.now, CRON_BUDGET.reminders);
  let sent = 0;
  await Promise.all(
    tasks.map(async (t) => {
      const next = t.repeat ? nextOccurrence(t.remind_at, t.repeat, ctx.now) : null;
      const claim = await ctx.db.prepare(`UPDATE tasks SET remind_at = ? WHERE id = ? AND remind_at = ?`).bind(next, t.id, t.remind_at).run();
      if (!claim.meta.changes) return;
      const r = await ctx.api.send(t.user_id, `\u23F0 <b>\u06CC\u0627\u062F\u0622\u0648\u0631\u06CC</b>

${taskLine(t, ctx.now, Infinity)}${t.note ? `

\u{1F4DD} ${esc(t.note)}` : ""}`, {
        reply_markup: inline([
          [btn("\u2705 \u0627\u0646\u062C\u0627\u0645 \u0634\u062F", cb("D", t.num, "p.0")), btn("\u{1F4C4} \u062C\u0632\u0626\u06CC\u0627\u062A", cb("T", t.num, "p.0"))],
          [btn("\u{1F634} \u06F1\u06F0 \u062F\u0642\u06CC\u0642\u0647 \u0628\u0639\u062F", `SN|${t.num}|10`), btn("\u{1F634} \u06F1 \u0633\u0627\u0639\u062A \u0628\u0639\u062F", `SN|${t.num}|60`)]
        ])
      });
      if (r.ok) sent += 1;
      else if (isBlockedError(r)) await markBlocked(ctx.db, t.user_id);
      else if (transient(r)) await ctx.db.prepare(`UPDATE tasks SET remind_at = ? WHERE id = ?`).bind(t.remind_at, t.id).run();
    })
  );
  return sent;
}
__name(sendReminders, "sendReminders");
function greeting(hour) {
  if (hour < 12) return "\u{1F305} \u0635\u0628\u062D \u0628\u062E\u06CC\u0631";
  if (hour < 17) return "\u2600\uFE0F \u0631\u0648\u0632 \u0628\u062E\u06CC\u0631";
  return "\u{1F319} \u0639\u0635\u0631 \u0628\u062E\u06CC\u0631";
}
__name(greeting, "greeting");
async function sendDigests(ctx) {
  const lp = localParts(ctx.now);
  const key = localDateKey(ctx.now);
  const users = await digestCandidates(ctx.db, lp.hh, key, CRON_BUDGET.digests);
  let sent = 0;
  await Promise.all(
    users.map(async (u) => {
      const claim = await ctx.db.prepare(`UPDATE users SET digest_last = ? WHERE id = ? AND (digest_last IS NULL OR digest_last <> ?)`).bind(key, u.id, key).run();
      if (!claim.meta.changes) return;
      const [stats, tasks] = await Promise.all([userStats(ctx.db, u.id, ctx.now), pendingForDigest(ctx.db, u.id, ctx.now)]);
      const lines = [
        `${greeting(lp.hh)} ${esc(u.first_name || "")}!`,
        `\u{1F4CB} <b>\u062E\u0644\u0627\u0635\u0647 \u0631\u0648\u0632\u0627\u0646\u0647</b> \u2014 ${formatDate(ctx.now, { time: false, now: ctx.now })}`,
        "",
        `\u23F3 \u062F\u0631 \u062C\u0631\u06CC\u0627\u0646: <b>${fa(stats.pending)}</b> \xB7 \u{1F4C5} \u0627\u0645\u0631\u0648\u0632: <b>${fa(stats.today)}</b> \xB7 \u26A0\uFE0F \u0639\u0642\u0628\u200C\u0627\u0641\u062A\u0627\u062F\u0647: <b>${fa(stats.overdue)}</b>`,
        `\u{1F3C1} \u062F\u0631 \u06F7 \u0631\u0648\u0632 \u0627\u062E\u06CC\u0631 <b>${fa(stats.week)}</b> \u06A9\u0627\u0631 \u0627\u0646\u062C\u0627\u0645 \u062F\u0627\u062F\u0647\u200C\u0627\u06CC\u062F.`,
        ""
      ];
      if (tasks.length) lines.push("<b>\u06A9\u0627\u0631\u0647\u0627\u06CC \u0645\u0647\u0645 \u0627\u0645\u0631\u0648\u0632:</b>", "", tasks.map((t) => taskLine(t, ctx.now)).join("\n\n"));
      else lines.push("\u{1F389} \u0647\u06CC\u0686 \u06A9\u0627\u0631 \u062F\u0631 \u062C\u0631\u06CC\u0627\u0646\u06CC \u0646\u062F\u0627\u0631\u06CC\u062F. \u06CC\u06A9 \u0631\u0648\u0632 \u0639\u0627\u0644\u06CC \u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u06CC\u062F!");
      const r = await ctx.api.send(u.id, lines.join("\n"), {
        reply_markup: inline([[btn("\u{1F4CB} \u0647\u0645\u0647 \u06A9\u0627\u0631\u0647\u0627", "L|p|0"), btn("\u{1F4C5} \u06A9\u0627\u0631\u0647\u0627\u06CC \u0627\u0645\u0631\u0648\u0632", "L|t|0")]])
      });
      if (r.ok) sent += 1;
      else if (isBlockedError(r)) await markBlocked(ctx.db, u.id);
      else if (transient(r)) await ctx.db.prepare(`UPDATE users SET digest_last = ? WHERE id = ?`).bind(u.digest_last, u.id).run();
    })
  );
  return sent;
}
__name(sendDigests, "sendDigests");
async function runBroadcast(ctx) {
  const b = await activeBroadcast(ctx.db);
  if (!b) return 0;
  const targets = await broadcastTargets(ctx.db, b.cursor, CRON_BUDGET.broadcast);
  let sent = 0;
  let failed = 0;
  await Promise.all(
    targets.map(async (id) => {
      const r = await ctx.api.call("copyMessage", { chat_id: id, from_chat_id: b.from_chat, message_id: b.message_id });
      if (r.ok) sent += 1;
      else {
        failed += 1;
        if (isBlockedError(r)) await markBlocked(ctx.db, id);
      }
    })
  );
  const finished = targets.length < CRON_BUDGET.broadcast;
  const cursor = targets.length ? targets[targets.length - 1] : b.cursor;
  await updateBroadcast(ctx.db, b.id, cursor, sent, failed, finished ? "done" : "running");
  if (finished) {
    const total = await getBroadcast(ctx.db, b.id);
    await ctx.api.send(
      ownerId(ctx.env),
      `\u{1F4E3} <b>\u0627\u0631\u0633\u0627\u0644 \u0647\u0645\u06AF\u0627\u0646\u06CC \u062A\u0645\u0627\u0645 \u0634\u062F.</b>

\u2705 \u0645\u0648\u0641\u0642: ${fa(total.sent)}
\u274C \u0646\u0627\u0645\u0648\u0641\u0642: ${fa(total.failed)}`
    );
  }
  return sent;
}
__name(runBroadcast, "runBroadcast");

// src/index.js
var json = /* @__PURE__ */ __name((data, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } }), "json");
var USER_COMMANDS = [
  { command: "start", description: "\u0634\u0631\u0648\u0639 \u0648 \u0645\u0646\u0648\u06CC \u0627\u0635\u0644\u06CC" },
  { command: "list", description: "\u06A9\u0627\u0631\u0647\u0627\u06CC \u062F\u0631 \u062C\u0631\u06CC\u0627\u0646" },
  { command: "today", description: "\u06A9\u0627\u0631\u0647\u0627\u06CC \u0627\u0645\u0631\u0648\u0632 \u0648 \u0639\u0642\u0628\u200C\u0627\u0641\u062A\u0627\u062F\u0647" },
  { command: "add", description: "\u0627\u0641\u0632\u0648\u062F\u0646 \u06A9\u0627\u0631 \u062C\u062F\u06CC\u062F" },
  { command: "search", description: "\u062C\u0633\u062A\u062C\u0648 \u062F\u0631 \u06A9\u0627\u0631\u0647\u0627" },
  { command: "categories", description: "\u062F\u0633\u062A\u0647\u200C\u0628\u0646\u062F\u06CC\u200C\u0647\u0627" },
  { command: "stats", description: "\u0622\u0645\u0627\u0631 \u0648 \u067E\u06CC\u0634\u0631\u0641\u062A" },
  { command: "settings", description: "\u062A\u0646\u0638\u06CC\u0645\u0627\u062A\u060C \u062E\u0644\u0627\u0635\u0647 \u0631\u0648\u0632\u0627\u0646\u0647 \u0648 \u062E\u0631\u0648\u062C\u06CC" },
  { command: "help", description: "\u0631\u0627\u0647\u0646\u0645\u0627" },
  { command: "cancel", description: "\u0644\u063A\u0648 \u0639\u0645\u0644\u06CC\u0627\u062A \u062C\u0627\u0631\u06CC" }
];
var OWNER_COMMANDS = [
  ...USER_COMMANDS,
  { command: "admin", description: "\u067E\u0646\u0644 \u0645\u062F\u06CC\u0631\u06CC\u062A" },
  { command: "channels", description: "\u06A9\u0627\u0646\u0627\u0644\u200C\u0647\u0627\u06CC \u062C\u0648\u06CC\u0646 \u0627\u062C\u0628\u0627\u0631\u06CC" },
  { command: "addchannel", description: "\u0627\u0641\u0632\u0648\u062F\u0646 \u06A9\u0627\u0646\u0627\u0644 \u062C\u0648\u06CC\u0646 \u0627\u062C\u0628\u0627\u0631\u06CC" },
  { command: "delchannel", description: "\u062D\u0630\u0641 \u06A9\u0627\u0646\u0627\u0644 \u062C\u0648\u06CC\u0646 \u0627\u062C\u0628\u0627\u0631\u06CC" }
];
async function setup(request, env) {
  const url = new URL(request.url);
  if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) return json({ ok: false, error: "BOT_TOKEN and WEBHOOK_SECRET secrets must be set first." }, 500);
  if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) return json({ ok: false, error: "wrong secret" }, 403);
  const api = createApi(env);
  const webhook = await api.call("setWebhook", {
    url: `${url.origin}/webhook`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    max_connections: 40
  });
  const commands = await api.call("setMyCommands", { commands: USER_COMMANDS });
  const ownerCommands = await api.call("setMyCommands", { commands: OWNER_COMMANDS, scope: { type: "chat", chat_id: ownerId(env) } });
  const me = await api.call("getMe");
  return json({ ok: webhook.ok, webhook, commands, ownerCommands: ownerCommands.ok ? ownerCommands : `${ownerCommands.description} (the owner must /start the bot first)`, bot: me.result });
}
__name(setup, "setup");
var src_default = {
  async fetch(request, env) {
    setTzOffset(env.TZ_OFFSET_MINUTES);
    const url = new URL(request.url);
    if (url.pathname === "/webhook" && request.method === "POST") {
      if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("bad request", { status: 400 });
      }
      try {
        await handleUpdate(env, update);
      } catch (err) {
        console.error("update failed:", err?.stack || err);
      }
      return new Response("ok");
    }
    if (url.pathname === "/setup") return setup(request, env);
    if (url.pathname === "/") return new Response("\u2705 Todo bot is running.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response("not found", { status: 404 });
  },
  async scheduled(event, env, ctx) {
    setTzOffset(env.TZ_OFFSET_MINUTES);
    ctx.waitUntil(runCron(env, event.scheduledTime));
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-scheduled.ts
var scheduled = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  const url = new URL(request.url);
  if (url.pathname === "/__scheduled") {
    const cron = url.searchParams.get("cron") ?? "";
    await middlewareCtx.dispatch("scheduled", { cron });
    return new Response("Ran scheduled event");
  }
  const resp = await middlewareCtx.next(request, env);
  if (request.headers.get("referer")?.endsWith("/__scheduled") && url.pathname === "/favicon.ico" && resp.status === 500) {
    return new Response(null, { status: 404 });
  }
  return resp;
}, "scheduled");
var middleware_scheduled_default = scheduled;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-6xHGbn/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_scheduled_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-6xHGbn/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
