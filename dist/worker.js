var __defProp = Object.defineProperty;
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
var CRON_SUBREQUESTS = 45;
var CRON_BUDGET = { reminders: 8, digests: 10, broadcast: 15 };
var JOIN_CACHE_MS = 6e4;
var WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;
function secret(env, name) {
  return String(env[name] ?? "").trim();
}
function ownerId(env) {
  return Number(env.OWNER_ID || DEFAULT_OWNER_ID);
}

// src/time.js
var MINUTE = 6e4;
var HOUR = 60 * MINUTE;
var DAY = 24 * HOUR;
var offsetMs = DEFAULT_TZ_OFFSET_MINUTES * MINUTE;
function setTzOffset(minutes) {
  if (Number.isFinite(Number(minutes))) offsetMs = Number(minutes) * MINUTE;
}
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
function fromLocal(y, m, d, hh = 0, mm = 0) {
  return Date.UTC(y, m - 1, d, hh, mm) - offsetMs;
}
function startOfLocalDay(ts) {
  const p = localParts(ts);
  return fromLocal(p.y, p.m, p.d);
}
function localDateKey(ts) {
  const p = localParts(ts);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
var BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
var div = (a, b) => ~~(a / b);
var mod = (a, b) => a - ~~(a / b) * b;
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
function j2g(jy, jm, jd) {
  const r = jalCal(jy);
  return d2g(g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1);
}
function jalaliMonthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return jalCal(jy).leap === 0 ? 30 : 29;
}
function toJalali(ts) {
  const p = localParts(ts);
  return { ...g2j(p.y, p.m, p.d), hh: p.hh, mm: p.mm, dow: p.dow };
}
var FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
var fa = (v) => String(v).replace(/\d/g, (d) => FA_DIGITS[d]);
var WEEKDAYS = ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];
var JMONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
var pad2 = (n) => String(n).padStart(2, "0");
function formatTime(ts) {
  const p = localParts(ts);
  return fa(`${pad2(p.hh)}:${pad2(p.mm)}`);
}
function formatDate(ts, { time = true, now = Date.now() } = {}) {
  const j = toJalali(ts);
  const year = j.jy === toJalali(now).jy ? "" : ` ${fa(j.jy)}`;
  let out = `${WEEKDAYS[j.dow]} ${fa(j.jd)} ${JMONTHS[j.jm - 1]}${year}`;
  if (time) out += `، ساعت ${formatTime(ts)}`;
  return out;
}
function formatShortDate(ts) {
  const j = toJalali(ts);
  return fa(`${j.jy}/${pad2(j.jm)}/${pad2(j.jd)}`);
}
function relativeDay(ts, now = Date.now()) {
  const diff = Math.round((startOfLocalDay(ts) - startOfLocalDay(now)) / DAY);
  if (diff === 0) return "امروز";
  if (diff === 1) return "فردا";
  if (diff === 2) return "پس‌فردا";
  if (diff === -1) return "دیروز";
  return diff > 0 ? `${fa(diff)} روز دیگر` : `${fa(-diff)} روز پیش`;
}
function toLatinDigits(s) {
  return String(s || "").replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}
function normalizeInput(s) {
  return toLatinDigits(s).replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/[\u200c\u200f\u200e]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}
var DAY_WORDS = {
  "امروز": 0,
  today: 0,
  "فردا": 1,
  tomorrow: 1,
  "پسفردا": 2,
  "هفتهبعد": 7,
  "هفتهدیگر": 7,
  "هفتهدیگه": 7,
  "هفتهآینده": 7,
  nextweek: 7
};
var WEEKDAY_WORDS = {
  "یکشنبه": 0,
  "دوشنبه": 1,
  "سهشنبه": 2,
  "چهارشنبه": 3,
  "پنجشنبه": 4,
  "جمعه": 5,
  "شنبه": 6
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
function parseWhen(raw, now = Date.now(), { defaultHour = 9, defaultMinute = 0 } = {}) {
  let s = normalizeInput(raw);
  if (!s) return null;
  const rel = s.match(/^(?:\+|in\s+)?\s*(\d{1,4})\s*([a-z\u0600-\u06ff]*)\s*(?:دیگر|دیگه|بعد|later)?$/);
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
var REPEAT_LABELS = { d: "روزانه", w: "هفتگی", m: "ماهانه" };
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
function nextOccurrence(ts, repeat, after) {
  let next = addRepeat(ts, repeat);
  for (let i = 0; next <= after && i < 2e3; i += 1) next = addRepeat(next, repeat);
  return next;
}

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
async function getSetting(db, key) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first();
  return row ? row.value : null;
}
function setSetting(db, key, value) {
  return db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(key, value).run();
}
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
function parseState(user) {
  try {
    return user.state ? JSON.parse(user.state) : null;
  } catch {
    return null;
  }
}
function setState(db, userId, state) {
  return db.prepare(`UPDATE users SET state = ? WHERE id = ?`).bind(state ? JSON.stringify(state) : null, userId).run();
}
function setDigest(db, userId, hour, lastKey) {
  return db.prepare(`UPDATE users SET digest_hour = ?, digest_last = ? WHERE id = ?`).bind(hour, lastKey, userId).run();
}
function markBlocked(db, userId) {
  return db.prepare(`UPDATE users SET blocked = 1 WHERE id = ?`).bind(userId).run();
}
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
function getTask(db, userId, num) {
  return db.prepare(`SELECT * FROM tasks WHERE user_id = ? AND num = ?`).bind(userId, num).first();
}
function updateTask(db, userId, num, fields) {
  const keys = Object.keys(fields).filter((k) => EDITABLE.has(k));
  if (!keys.length) return null;
  return db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE user_id = ? AND num = ?`).bind(...keys.map((k) => fields[k] ?? null), userId, num).run();
}
function deleteTask(db, userId, num) {
  return db.prepare(`DELETE FROM tasks WHERE user_id = ? AND num = ?`).bind(userId, num).run();
}
var PENDING_ORDER = `priority ASC, due_at IS NULL, due_at ASC, num ASC`;
function filterSql(filter, now) {
  if (filter === "d") return { where: `done = 1`, order: `done_at DESC`, args: [] };
  if (filter === "t") return { where: `done = 0 AND due_at IS NOT NULL AND due_at < ?`, order: `due_at ASC, priority ASC`, args: [startOfLocalDay(now) + DAY] };
  if (filter === "a") return { where: `1 = 1`, order: `done ASC, ${PENDING_ORDER}`, args: [] };
  if (filter.startsWith("c")) return { where: `category = ?`, order: `done ASC, ${PENDING_ORDER}`, args: [filter.slice(1)] };
  return { where: `done = 0`, order: PENDING_ORDER, args: [] };
}
async function listTasks(db, userId, filter, page, now) {
  const f = filterSql(filter, now);
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND ${f.where}`).bind(userId, ...f.args),
    db.prepare(`SELECT * FROM tasks WHERE user_id = ? AND ${f.where} ORDER BY ${f.order} LIMIT ? OFFSET ?`).bind(userId, ...f.args, PAGE_SIZE, page * PAGE_SIZE)
  ]);
  return { total: count.results[0].n, rows: rows.results };
}
async function searchTasks(db, userId, query) {
  const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { results } = await db.prepare(
    `SELECT * FROM tasks WHERE user_id = ?1 AND (text LIKE ?2 ESCAPE '\\' OR note LIKE ?2 ESCAPE '\\' OR category LIKE ?2 ESCAPE '\\')
       ORDER BY done ASC, ${PENDING_ORDER} LIMIT 10`
  ).bind(userId, like).all();
  return results;
}
async function listCategories(db, userId) {
  const { results } = await db.prepare(
    `SELECT category, SUM(done = 0) AS pending, COUNT(*) AS total FROM tasks
       WHERE user_id = ? AND category IS NOT NULL GROUP BY category ORDER BY pending DESC, category LIMIT 30`
  ).bind(userId).all();
  return results;
}
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
async function allTasks(db, userId) {
  const { results } = await db.prepare(`SELECT * FROM tasks WHERE user_id = ? ORDER BY done ASC, ${PENDING_ORDER}`).bind(userId).all();
  return results;
}
function clearDone(db, userId) {
  return db.prepare(`DELETE FROM tasks WHERE user_id = ? AND done = 1`).bind(userId).run();
}
async function listChannels(db) {
  const { results } = await db.prepare(`SELECT * FROM channels ORDER BY id`).all();
  return results;
}
function addChannel(db, chat, title, link, now) {
  return db.prepare(`INSERT OR IGNORE INTO channels (chat, title, link, created_at) VALUES (?, ?, ?, ?)`).bind(chat, title, link, now).run();
}
function removeChannel(db, id) {
  return db.prepare(`DELETE FROM channels WHERE id = ?`).bind(id).run();
}
function getChannel(db, id) {
  return db.prepare(`SELECT * FROM channels WHERE id = ?`).bind(id).first();
}
function setChannelTitles(db, pairs) {
  return db.batch(pairs.map(([id, title]) => db.prepare(`UPDATE channels SET title = ? WHERE id = ?`).bind(title, id)));
}
async function dueReminders(db, now, limit) {
  const { results } = await db.prepare(
    `SELECT t.* FROM tasks t JOIN users u ON u.id = t.user_id
       WHERE t.remind_at IS NOT NULL AND t.remind_at <= ? AND t.done = 0 AND u.blocked = 0
       ORDER BY t.remind_at LIMIT ?`
  ).bind(now, limit).all();
  return results;
}
async function digestCandidates(db, hour, dateKey, limit) {
  const { results } = await db.prepare(
    `SELECT * FROM users WHERE digest_hour IS NOT NULL AND digest_hour <= ? AND (digest_last IS NULL OR digest_last <> ?) AND blocked = 0
       ORDER BY id LIMIT ?`
  ).bind(hour, dateKey, limit).all();
  return results;
}
async function pendingForDigest(db, userId, now) {
  const end = startOfLocalDay(now) + DAY;
  const { results } = await db.prepare(
    `SELECT * FROM tasks WHERE user_id = ? AND done = 0
       ORDER BY (due_at IS NOT NULL AND due_at < ?) DESC, ${PENDING_ORDER} LIMIT 10`
  ).bind(userId, end).all();
  return results;
}
function activeBroadcast(db) {
  return db.prepare(`SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id LIMIT 1`).first();
}
function createBroadcast(db, fromChat, messageId, now) {
  return db.prepare(`INSERT INTO broadcasts (from_chat, message_id, created_at) VALUES (?, ?, ?)`).bind(fromChat, messageId, now).run();
}
async function broadcastTargets(db, cursor, limit) {
  const { results } = await db.prepare(`SELECT id FROM users WHERE id > ? AND blocked = 0 ORDER BY id LIMIT ?`).bind(cursor, limit).all();
  return results.map((r) => r.id);
}
function updateBroadcast(db, id, cursor, sent, failed, status2) {
  return db.prepare(`UPDATE broadcasts SET cursor = ?, sent = sent + ?, failed = failed + ?, status = ? WHERE id = ?`).bind(cursor, sent, failed, status2, id).run();
}
function getBroadcast(db, id) {
  return db.prepare(`SELECT * FROM broadcasts WHERE id = ?`).bind(id).first();
}
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
async function countActiveUsers(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE blocked = 0`).first();
  return row.n;
}

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
var esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
var truncate = (s, n) => {
  const chars = Array.from(String(s));
  return chars.length > n ? chars.slice(0, n - 1).join("") + "…" : String(s);
};
function cb(...parts) {
  const data = parts.join("|");
  if (new TextEncoder().encode(data).length <= 64) return data;
  return parts.slice(0, -1).join("|");
}
var btn = (text, data) => ({ text, callback_data: data });
var urlBtn = (text, url) => ({ text, url });
var inline = (rows) => ({ inline_keyboard: rows.filter((r) => r.length) });
var BTN = {
  add: "➕ کار جدید",
  list: "📋 کارهای من",
  today: "📅 امروز",
  search: "🔍 جستجو",
  cats: "🗂 دسته‌ها",
  stats: "📊 آمار",
  settings: "⚙️ تنظیمات",
  help: "❓ راهنما",
  admin: "👑 پنل مدیریت"
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
var cancelKb = inline([[btn("❌ لغو", "CX")]]);
var PRIORITY = {
  1: { icon: "🔴", label: "بالا" },
  2: { icon: "🟡", label: "متوسط" },
  3: { icon: "🟢", label: "کم" }
};
function dueLabel(t, now) {
  if (!t.due_at) return "";
  const time = t.due_time ? ` ${formatTime(t.due_at)}` : "";
  const late = !t.done && t.due_at < now ? "⚠️ " : "";
  return `${late}${relativeDay(t.due_at, now)}${time}`;
}
function taskLine(t, now, maxLen = 120) {
  const icon = t.done ? "✅" : PRIORITY[t.priority].icon;
  const text = esc(truncate(t.text, maxLen));
  const title = t.done ? `<s>${text}</s>` : text;
  const meta = [];
  if (t.due_at) meta.push(`📅 ${dueLabel(t, now)}`);
  if (t.category) meta.push(`🗂 ${esc(t.category)}`);
  if (t.remind_at && !t.done) meta.push("⏰");
  if (t.repeat) meta.push("🔁");
  if (t.note) meta.push("📝");
  return `${icon} <b>${fa(t.num)}.</b> ${title}${meta.length ? `
      <i>${meta.join(" · ")}</i>` : ""}`;
}
function taskCard(t, now) {
  const lines = [
    `${t.done ? "✅" : PRIORITY[t.priority].icon} <b>کار شماره ${fa(t.num)}</b>`,
    "",
    `<b>${esc(t.text)}</b>`,
    "━━━━━━━━━━━━━━",
    `📌 وضعیت: ${t.done ? `انجام شده (${relativeDay(t.done_at, now)})` : "⏳ در جریان"}`,
    `🔥 اولویت: ${PRIORITY[t.priority].icon} ${PRIORITY[t.priority].label}`,
    `🗂 دسته: ${t.category ? esc(t.category) : "—"}`,
    `📅 ددلاین: ${t.due_at ? `${formatDate(t.due_at, { time: !!t.due_time, now })} (${dueLabel(t, now)})` : "—"}`,
    `⏰ یادآور: ${t.remind_at && !t.done ? formatDate(t.remind_at, { now }) : "—"}`,
    `🔁 تکرار: ${t.repeat ? REPEAT_LABELS[t.repeat] : "—"}`
  ];
  if (t.note) lines.push("", `📝 <b>یادداشت:</b>
${esc(t.note)}`);
  lines.push("", `<i>🕓 ایجاد: ${formatDate(t.created_at, { now })}</i>`);
  return lines.join("\n");
}
function taskCardKb(t, ctx) {
  const n = t.num;
  return inline([
    [btn(t.done ? "↩️ برگرداندن به در جریان" : "✅ انجام شد", cb("D", n, ctx)), btn("🗑 حذف", cb("X", n, ctx))],
    [btn("✏️ ویرایش متن", cb("E", n, "t", ctx)), btn("📝 یادداشت", cb("E", n, "n", ctx))],
    [btn("🔥 اولویت", cb("E", n, "p", ctx)), btn("🗂 دسته", cb("E", n, "c", ctx))],
    [btn("📅 ددلاین", cb("E", n, "d", ctx)), btn("⏰ یادآور", cb("E", n, "r", ctx))],
    [btn("🔁 تکرار", cb("E", n, "R", ctx)), btn("🔙 بازگشت به لیست", `L|${ctx.replace(".", "|")}`)]
  ]);
}
var LIST_TITLES = {
  p: "📋 <b>کارهای در جریان</b>",
  t: "📅 <b>کارهای امروز و عقب‌افتاده</b>",
  d: "✅ <b>کارهای انجام‌شده</b>",
  a: "🗃 <b>همه کارها</b>"
};
function listView({ filter, page, total, rows, now }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const title = filter.startsWith("c") ? `🗂 <b>دسته «${esc(filter.slice(1))}»</b>` : LIST_TITLES[filter];
  const header = `${title} (${fa(total)})${pages > 1 ? ` — صفحه ${fa(page + 1)} از ${fa(pages)}` : ""}`;
  const body = rows.length ? rows.map((t) => taskLine(t, now)).join("\n\n") : filter === "p" ? "✨ هیچ کار در جریانی ندارید!\nبرای افزودن کار، کافیه متنش رو همین‌جا بفرستید." : "✨ چیزی برای نمایش نیست.";
  const ctx = `${filter}.${page}`;
  const rowsKb = rows.map((t) => [btn(`${t.done ? "✅" : PRIORITY[t.priority].icon} ${fa(t.num)}. ${truncate(t.text, 30)}`, cb("T", t.num, ctx))]);
  const nav = [];
  if (pages > 1) {
    nav.push(btn("◀️", page > 0 ? `L|${filter}|${page - 1}` : "N"));
    nav.push(btn(`${fa(page + 1)}/${fa(pages)}`, "N"));
    nav.push(btn("▶️", page < pages - 1 ? `L|${filter}|${page + 1}` : "N"));
  }
  const mark = (f, label) => btn(filter === f ? `• ${label} •` : label, `L|${f}|0`);
  return {
    text: `${header}

${body}`,
    kb: inline([...rowsKb, nav, [mark("p", "⏳ در جریان"), mark("t", "📅 امروز"), mark("d", "✅ انجام‌شده")], [btn("➕ افزودن کار", "ADD"), btn("🗃 همه", "L|a|0")]])
  };
}
function priorityKb(n, ctx) {
  return inline([
    [1, 2, 3].map((p) => btn(`${PRIORITY[p].icon} ${PRIORITY[p].label}`, cb("P", n, p, ctx))),
    [btn("🔙 بازگشت", cb("T", n, ctx))]
  ]);
}
function categoryKb(n, categories, current, ctx) {
  const rows = [];
  const names = categories.map((c) => c.category).filter((c) => c !== current).slice(0, 8);
  for (let i = 0; i < names.length; i += 2) rows.push(names.slice(i, i + 2).map((c) => btn(`🗂 ${c}`, cb("C", n, c, ctx))));
  if (current) rows.push([btn("❌ حذف دسته", cb("C", n, "-", ctx))]);
  rows.push([btn("🔙 بازگشت", cb("T", n, ctx))]);
  return inline(rows);
}
function dueKb(n, hasDue, ctx) {
  return inline([
    [btn("امروز", cb("DD", n, "0", ctx)), btn("فردا", cb("DD", n, "1", ctx)), btn("پس‌فردا", cb("DD", n, "2", ctx))],
    [btn("۳ روز دیگر", cb("DD", n, "3", ctx)), btn("هفته بعد", cb("DD", n, "7", ctx)), btn("ماه بعد", cb("DD", n, "30", ctx))],
    hasDue ? [btn("❌ حذف ددلاین", cb("DD", n, "x", ctx))] : [],
    [btn("🔙 بازگشت", cb("T", n, ctx))]
  ]);
}
function reminderKb(n, t, ctx) {
  return inline([
    [btn("۱۵ دقیقه بعد", cb("RM", n, "15", ctx)), btn("۳۰ دقیقه بعد", cb("RM", n, "30", ctx))],
    [btn("۱ ساعت بعد", cb("RM", n, "60", ctx)), btn("۳ ساعت بعد", cb("RM", n, "180", ctx))],
    [btn("فردا ۹ صبح", cb("RM", n, "t9", ctx)), btn("امشب ۲۱:۰۰", cb("RM", n, "n21", ctx))],
    t.due_at && t.due_time ? [btn("⏱ سر موعد ددلاین", cb("RM", n, "due", ctx)), btn("۱ ساعت قبل ددلاین", cb("RM", n, "due60", ctx))] : [],
    t.remind_at ? [btn("❌ حذف یادآور", cb("RM", n, "x", ctx))] : [],
    [btn("🔙 بازگشت", cb("T", n, ctx))]
  ]);
}
function repeatKb(n, current, ctx) {
  const mark = (r, label) => btn(current === r ? `✓ ${label}` : label, cb("RP", n, r, ctx));
  return inline([
    [mark("d", "روزانه"), mark("w", "هفتگی"), mark("m", "ماهانه")],
    current ? [btn("❌ بدون تکرار", cb("RP", n, "x", ctx))] : [],
    [btn("🔙 بازگشت", cb("T", n, ctx))]
  ]);
}
function progressBar(ratio, width = 10) {
  const filled = Math.round(ratio * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}
var QUICK_ADD_HINT = [
  "💡 <b>افزودن سریع:</b> هر متنی بفرستید به‌عنوان کار جدید ذخیره می‌شه.",
  "می‌تونید داخل متن از این‌ها هم استفاده کنید:",
  "• <code>#دسته</code> ← دسته‌بندی (مثلاً <code>#خرید</code>)",
  "• <code>!1</code> / <code>!2</code> / <code>!3</code> ← اولویت بالا / متوسط / کم",
  "• <code>@زمان</code> ← ددلاین (مثلاً <code>@فردا</code>، <code>@شنبه ساعت 18</code>، <code>@1405/08/10</code>)",
  "",
  "نمونه: <code>خرید نان و شیر #خانه !1 @فردا 18:00</code>"
].join("\n");
var HELP_TEXT = [
  "📖 <b>راهنمای ربات تودو لیست</b>",
  "",
  "<b>۱۰ قابلیت ربات:</b>",
  "1️⃣ <b>افزودن سریع هوشمند</b> — متن بفرستید؛ دسته، اولویت و ددلاین رو از خود متن می‌فهمه.",
  "2️⃣ <b>اولویت‌بندی</b> 🔴🟡🟢 — کارها خودکار بر اساس اولویت و ددلاین مرتب می‌شن.",
  "3️⃣ <b>ددلاین با تقویم شمسی</b> 📅 — با هشدار ⚠️ برای کارهای عقب‌افتاده.",
  "4️⃣ <b>یادآور زمان‌دار</b> ⏰ — سر وقت پیام می‌گیرید (با دکمه تعویق).",
  "5️⃣ <b>دسته‌بندی</b> 🗂 — کارها رو گروه‌بندی و فیلتر کنید.",
  "6️⃣ <b>کارهای تکراری</b> 🔁 — روزانه، هفتگی یا ماهانه؛ با انجام هر نوبت، نوبت بعد خودکار ساخته می‌شه.",
  "7️⃣ <b>یادداشت و ویرایش کامل</b> 📝 — متن، یادداشت و همه مشخصات هر کار قابل ویرایشه.",
  "8️⃣ <b>جستجو</b> 🔍 — در متن، یادداشت و دسته کارها.",
  "9️⃣ <b>آمار و نمودار پیشرفت</b> 📊",
  "🔟 <b>خلاصه روزانه صبحگاهی</b> 🌅 — هر روز ساعت دلخواه، لیست کارهای امروز براتون ارسال می‌شه.",
  "",
  "➕ همچنین: خروجی فایل از همه کارها 📤 و پاکسازی کارهای انجام‌شده 🧹 در ⚙️ تنظیمات.",
  "",
  QUICK_ADD_HINT,
  "",
  "<b>فرمت‌های زمان:</b> <code>امروز</code>، <code>فردا</code>، <code>پس‌فردا</code>، <code>شنبه</code>، <code>هفته بعد</code>، <code>+3</code> (۳ روز بعد)، <code>30 دقیقه دیگر</code>، <code>2 ساعت بعد</code>، <code>18:30</code>، <code>ساعت 8 شب</code>، <code>1405/08/10</code>، <code>2026-11-01 09:00</code>",
  "",
  "<b>دستورات:</b> /start · /list · /today · /add · /search · /stats · /settings · /help · /cancel"
].join("\n");

// src/join.js
var verified = /* @__PURE__ */ new Map();
function clearJoinCache() {
  verified.clear();
}
var MEMBER = /* @__PURE__ */ new Set(["creator", "administrator", "member"]);
async function missingChannels(ctx, userId) {
  const channels = await listChannels(ctx.db);
  const missing = await Promise.all(
    channels.map(async (c) => {
      const r = await ctx.api.call("getChatMember", { chat_id: c.chat, user_id: userId });
      if (!r.ok) return false;
      const { status: status2, is_member: isMember } = r.result;
      return !(MEMBER.has(status2) || status2 === "restricted" && isMember);
    })
  );
  return channels.filter((_, i) => missing[i]);
}
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
function joinGateView(missing) {
  const text = [
    "🔒 <b>برای استفاده از ربات، ابتدا در کانال‌های زیر عضو شوید:</b>",
    "",
    ...missing.map((c, i) => `${fa(i + 1)}. ${esc(c.title || c.chat)}`),
    "",
    "بعد از عضویت روی «✅ عضو شدم» بزنید 👇"
  ].join("\n");
  const rows = missing.map((c) => [urlBtn(`📢 عضویت در ${c.title || c.chat}`, c.link)]);
  rows.push([btn("✅ عضو شدم، بررسی کن", "J")]);
  return { text, kb: inline(rows) };
}

// src/admin.js
var USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
async function homeView(ctx) {
  const channels = await listChannels(ctx.db);
  return {
    text: [
      "👑 <b>پنل مدیریت ربات</b>",
      "",
      `📢 کانال‌های جوین اجباری: ${fa(channels.length)} از ${fa(MAX_CHANNELS)}`,
      "",
      "دستورات متنی هم در دسترس است:",
      "<code>/channels</code> — لیست کانال‌ها",
      "<code>/addchannel @username</code> — افزودن کانال",
      "<code>/delchannel @username</code> یا <code>/delchannel 2</code> — حذف کانال"
    ].join("\n"),
    kb: inline([
      [btn(`📢 کانال‌های جوین اجباری (${fa(channels.length)}/${fa(MAX_CHANNELS)})`, "A|ch")],
      [btn("📊 آمار ربات", "A|st"), btn("📣 پیام همگانی", "A|bc")]
    ])
  };
}
async function channelsView(ctx, notice = "") {
  const channels = await listChannels(ctx.db);
  const lines = channels.length ? channels.map((c, i) => `${fa(i + 1)}. <b>${esc(c.title || c.chat)}</b>
      <code>${esc(c.chat)}</code> — ${esc(c.link)}`) : ["هیچ کانالی تنظیم نشده؛ جوین اجباری غیرفعال است."];
  const rows = channels.map((c, i) => [btn(`❌ حذف ${fa(i + 1)}. ${c.title || c.chat}`, `A|cd|${c.id}`)]);
  rows.push([
    channels.length < MAX_CHANNELS ? btn("➕ افزودن کانال", "A|ca") : btn(`⛔️ سقف ${fa(MAX_CHANNELS)} کانال پر است`, "A|full"),
    btn("🔄 بررسی وضعیت", "A|ck")
  ]);
  rows.push([btn("🔙 پنل مدیریت", "A|h")]);
  return {
    text: [
      notice,
      `📢 <b>کانال‌های جوین اجباری</b> (${fa(channels.length)} از ${fa(MAX_CHANNELS)})`,
      "",
      ...lines,
      "",
      "⚠️ ربات باید در هر کانال <b>ادمین</b> باشد تا عضویت کاربران بررسی شود."
    ].filter((l, i) => i > 0 || l).join("\n"),
    kb: inline(rows)
  };
}
var ADD_CHANNEL_PROMPT = [
  "➕ <b>افزودن کانال جوین اجباری</b>",
  "",
  "یکی از این‌ها را بفرستید:",
  "• یوزرنیم کانال: <code>@channel</code>",
  "• لینک کانال: <code>https://t.me/channel</code>",
  "• کانال خصوصی: آیدی عددی + لینک دعوت، مثل:",
  "  <code>-1001234567890 https://t.me/+AbCdEf</code>",
  "• یا یک پیام از خود کانال را اینجا فوروارد کنید.",
  "",
  "⚠️ قبلش ربات را در کانال ادمین کنید."
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
async function addChannel2(ctx, input) {
  if (!input) return { ok: false, text: "❗️ ورودی نامعتبر است.\n\n" + ADD_CHANNEL_PROMPT };
  const channels = await listChannels(ctx.db);
  if (channels.length >= MAX_CHANNELS) return { ok: false, text: `⛔️ حداکثر ${fa(MAX_CHANNELS)} کانال قابل تنظیم است. اول یکی را حذف کنید.` };
  if (channels.some((c) => c.chat.toLowerCase() === input.chat.toLowerCase())) return { ok: false, text: `ℹ️ کانال <code>${esc(input.chat)}</code> از قبل در لیست هست.` };
  const info = await ctx.api.call("getChat", { chat_id: input.chat });
  let { chat, link } = input;
  let title = null;
  if (info.ok) {
    title = info.result.title || null;
    if (info.result.username) {
      chat = `@${info.result.username}`;
      link = link || `https://t.me/${info.result.username}`;
      if (channels.some((c) => c.chat.toLowerCase() === chat.toLowerCase())) return { ok: false, text: `ℹ️ کانال <code>${esc(chat)}</code> از قبل در لیست هست.` };
    }
    if (!link) link = info.result.invite_link || null;
    if (!link) {
      const created = await ctx.api.call("createChatInviteLink", { chat_id: chat, name: "todo-bot join" });
      if (created.ok) link = created.result.invite_link;
    }
  } else if (!chat.startsWith("@")) {
    return { ok: false, text: "❌ ربات به این کانال دسترسی ندارد. اول ربات را در کانال ادمین کنید و دوباره امتحان کنید." };
  }
  if (!link) return { ok: false, text: "❗️ لینک دعوت کانال پیدا نشد. آیدی عددی را همراه لینک دعوت بفرستید:\n<code>-1001234567890 https://t.me/+AbCdEf</code>" };
  const me = await ctx.api.call("getChatMember", { chat_id: chat, user_id: ctx.api.botId() });
  const isAdmin = me.ok && ["administrator", "creator"].includes(me.result.status);
  await addChannel(ctx.db, chat, title, link, ctx.now);
  clearJoinCache();
  const warn = isAdmin ? "" : "\n⚠️ ربات در این کانال ادمین نیست؛ تا وقتی ادمین نشود، عضویت در این کانال بررسی نمی‌شود.";
  return { ok: true, text: `✅ کانال <b>${esc(title || chat)}</b> اضافه شد.${warn}
` };
}
async function removeChannel2(ctx, id) {
  const ch = await getChannel(ctx.db, id);
  if (!ch) return null;
  await removeChannel(ctx.db, id);
  clearJoinCache();
  return ch;
}
async function resolveChannelRef(ctx, ref) {
  const channels = await listChannels(ctx.db);
  const r = normalizeInput(ref);
  if (/^\d+$/.test(r)) return channels[Number(r) - 1] || null;
  const name = r.replace(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//, "@").replace(/\/$/, "");
  return channels.find((c) => c.chat.toLowerCase() === name || c.chat.toLowerCase() === `@${name}`) || null;
}
async function statusReport(ctx) {
  const channels = await listChannels(ctx.db);
  const botId = ctx.api.botId();
  const renamed = [];
  const lines = await Promise.all(
    channels.map(async (c, i) => {
      const [info, me] = await Promise.all([
        ctx.api.call("getChat", { chat_id: c.chat }),
        ctx.api.call("getChatMember", { chat_id: c.chat, user_id: botId })
      ]);
      if (info.ok && info.result.title && info.result.title !== c.title) renamed.push([c.id, info.result.title]);
      const name = esc(info.ok && info.result.title || c.title || c.chat);
      if (!info.ok) return `${fa(i + 1)}. ❌ <b>${name}</b> — کانال پیدا نشد یا ربات به آن دسترسی ندارد`;
      if (me.ok && ["administrator", "creator"].includes(me.result.status)) return `${fa(i + 1)}. ✅ <b>${name}</b> — ربات ادمین است`;
      return `${fa(i + 1)}. ⚠️ <b>${name}</b> — ربات ادمین نیست (عضویت بررسی نمی‌شود)`;
    })
  );
  if (renamed.length) await setChannelTitles(ctx.db, renamed);
  return lines.length ? `🔄 <b>وضعیت کانال‌ها:</b>
${lines.join("\n")}
` : "";
}
async function statsView(ctx) {
  const s = await botStats(ctx.db, ctx.now);
  const b = await activeBroadcast(ctx.db);
  return {
    text: [
      "📊 <b>آمار ربات</b>",
      "",
      `👥 کل کاربران: ${fa(s.users)}`,
      `🆕 کاربران جدید (۲۴ ساعت): ${fa(s.new_day)}`,
      `🟢 فعال در ۲۴ ساعت: ${fa(s.active_day)}`,
      `📆 فعال در ۷ روز: ${fa(s.active_week)}`,
      `🚫 ربات را بلاک کرده‌اند: ${fa(s.blocked)}`,
      "",
      `📝 کل کارها: ${fa(s.tasks)}`,
      `✅ کارهای انجام‌شده: ${fa(s.done)}`,
      b ? `
📣 ارسال همگانی در حال اجرا: ${fa(b.sent)} ارسال‌شده، ${fa(b.failed)} ناموفق` : "",
      "",
      `<i>🕓 ${formatDate(ctx.now, { now: ctx.now })}</i>`
    ].join("\n"),
    kb: inline([[btn("🔄 بروزرسانی", "A|st"), btn("🔙 پنل مدیریت", "A|h")]])
  };
}
async function prepareBroadcast(ctx, msg) {
  await setState(ctx.db, ctx.uid, null);
  const count = await countActiveUsers(ctx.db);
  return ctx.api.send(ctx.chatId, `📣 این پیام برای <b>${fa(count)}</b> کاربر ارسال شود؟`, {
    reply_to_message_id: msg.message_id,
    reply_markup: inline([[btn("✅ بله، ارسال کن", `A|bcy|${msg.message_id}`), btn("❌ لغو", "A|bcn")]])
  });
}
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
      return ctx.api.send(ctx.chatId, ADD_CHANNEL_PROMPT, { reply_markup: inline([[btn("❌ لغو", "A|ch")]]) });
    }
    const res = await addChannel2(ctx, parseChannelInput({ text: arg }));
    const v = await channelsView(ctx, res.text);
    return ctx.api.send(ctx.chatId, res.ok ? v.text : res.text, { reply_markup: res.ok ? v.kb : void 0 });
  }
  if (cmd === "/delchannel") {
    const ch = arg ? await resolveChannelRef(ctx, arg) : null;
    if (!ch) return ctx.api.send(ctx.chatId, "❗️ کانال پیدا نشد. نمونه: <code>/delchannel @username</code> یا <code>/delchannel 2</code> (شماره در لیست /channels)");
    await removeChannel2(ctx, ch.id);
    const v = await channelsView(ctx, `🗑 کانال <b>${esc(ch.title || ch.chat)}</b> حذف شد.
`);
    return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
  }
  return null;
}
async function onAdminState(ctx, msg) {
  if (ctx.state.a === "addch") {
    const res = await addChannel2(ctx, parseChannelInput(msg));
    if (!res.ok) return ctx.api.send(ctx.chatId, res.text, { reply_markup: inline([[btn("❌ لغو", "A|ch")]]) });
    await setState(ctx.db, ctx.uid, null);
    const v = await channelsView(ctx, res.text);
    return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
  }
  if (ctx.state.a === "bc") return prepareBroadcast(ctx, msg);
  return null;
}
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
      return ctx.toast(`⛔️ حداکثر ${fa(MAX_CHANNELS)} کانال؛ اول یکی را حذف کنید.`, true);
    case "ca": {
      const channels = await listChannels(ctx.db);
      if (channels.length >= MAX_CHANNELS) return ctx.toast(`⛔️ حداکثر ${fa(MAX_CHANNELS)} کانال؛ اول یکی را حذف کنید.`, true);
      await setState(ctx.db, ctx.uid, { a: "addch" });
      return ctx.show(ADD_CHANNEL_PROMPT, inline([[btn("🔙 لغو و بازگشت", "A|ch")]]));
    }
    case "cd": {
      const ch = await getChannel(ctx.db, Number(arg));
      if (!ch) return ctx.toast("این کانال قبلاً حذف شده.", true);
      return ctx.show(
        `🗑 کانال <b>${esc(ch.title || ch.chat)}</b> از جوین اجباری حذف شود؟`,
        inline([[btn("✅ بله، حذف شود", `A|cdy|${ch.id}`), btn("❌ نه", "A|ch")]])
      );
    }
    case "cdy": {
      const ch = await removeChannel2(ctx, Number(arg));
      const v = await channelsView(ctx, ch ? `🗑 کانال <b>${esc(ch.title || ch.chat)}</b> حذف شد.
` : "");
      await ctx.toast(ch ? "🗑 حذف شد" : "قبلاً حذف شده بود");
      return ctx.show(v.text, v.kb);
    }
    case "ck": {
      await ctx.toast("⏳ در حال بررسی...");
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
        "📣 <b>پیام همگانی</b>\n\nپیامی که می‌خواهید برای همه کاربران ارسال شود را بفرستید (متن، عکس، ویدیو، فایل یا فوروارد).",
        inline([[btn("🔙 لغو و بازگشت", "A|h")]])
      );
    }
    case "bcy": {
      if (await activeBroadcast(ctx.db)) return ctx.toast("⏳ یک ارسال همگانی دیگر در حال اجراست.", true);
      await createBroadcast(ctx.db, ctx.chatId, Number(arg), ctx.now);
      await ctx.toast("📣 ارسال شروع شد");
      return ctx.show("📣 ارسال همگانی شروع شد. پیام‌ها در پس‌زمینه ارسال می‌شوند و در پایان گزارش برایتان می‌آید.", null);
    }
    case "bcn":
      return ctx.show("❌ ارسال همگانی لغو شد.", null);
    default:
      return ctx.toast("دستور نامعتبر");
  }
}

// src/quickadd.js
var CATEGORY_RE = /^[\p{L}\p{M}\p{N}_ \-\u200c]+$/u;
var MAX_CATEGORY_BYTES = 40;
function cleanCategory(raw) {
  const name = String(raw || "").replace(/\s+/g, " ").replace(/^[\s\u200c]+|[\s\u200c]+$/g, "");
  if (!name || !CATEGORY_RE.test(name) || Array.from(name).length > MAX_CATEGORY_LEN) return null;
  if (new TextEncoder().encode(name).length > MAX_CATEGORY_BYTES) return null;
  return name;
}
function parseQuickAdd(input, now) {
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

// src/telegram.js
function createApi(env) {
  const token = secret(env, "BOT_TOKEN");
  const base = `${env.TELEGRAM_API || "https://api.telegram.org"}/bot${token}/`;
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
  return {
    call,
    sendDocument,
    send: (chatId, text, extra = {}) => call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra
    }),
    edit: (chatId, messageId, text, extra = {}) => call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra
    }),
    answer: (callbackId, text, showAlert = false) => call("answerCallbackQuery", { callback_query_id: callbackId, text, show_alert: showAlert }),
    botId: () => Number(token.split(":")[0])
  };
}
var isBlockedError = (r) => r && !r.ok && (r.error_code === 403 || /chat not found|blocked|deactivated/i.test(r.description || ""));

// src/bot.js
var { btn: btn2, esc: esc2, inline: inline2 } = ui_exports;
async function handleUpdate(env, update) {
  await ensureSchema(env.DB);
  const base = { env, api: createApi(env), db: env.DB, now: Date.now(), owner: ownerId(env) };
  if (update.message) return onMessage(base, update.message);
  if (update.callback_query) return onCallback(base, update.callback_query);
  return null;
}
async function buildCtx(base, from, chatId) {
  const user = await touchUser(base.db, from, base.now);
  return { ...base, from, chatId, user, uid: from.id, isOwner: from.id === base.owner, state: parseState(user) };
}
var clearState = (ctx) => {
  if (!ctx.state) return null;
  ctx.state = null;
  return setState(ctx.db, ctx.uid, null);
};
var setState2 = (ctx, state) => {
  ctx.state = state;
  return setState(ctx.db, ctx.uid, state);
};
var DEFAULT_CTX = "p.0";
function listFromCtx(lctx) {
  const i = (lctx || DEFAULT_CTX).lastIndexOf(".");
  return { filter: lctx.slice(0, i) || "p", page: Number(lctx.slice(i + 1)) || 0 };
}
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
    return ctx.api.send(ctx.chatId, "❓ دستور ناشناخته است. راهنما: /help");
  }
  const menu = MENU[text];
  if (menu && (menu !== showAdmin || ctx.isOwner)) {
    await clearState(ctx);
    return menu(ctx);
  }
  if (ctx.state) return onStateInput(ctx, msg, text);
  if (!text) return ctx.api.send(ctx.chatId, "📝 برای افزودن کار، متنش را به‌صورت پیام متنی بفرستید.");
  return quickAdd(ctx, text);
}
var COMMANDS = {
  "/start": sendWelcome,
  "/help": (ctx) => ctx.api.send(ctx.chatId, HELP_TEXT, { reply_markup: mainKeyboard(ctx.isOwner) }),
  "/list": (ctx) => sendList(ctx, "p", 0),
  "/today": (ctx) => sendList(ctx, "t", 0),
  "/done": (ctx) => sendList(ctx, "d", 0),
  "/add": (ctx, arg) => arg ? quickAdd(ctx, arg) : promptAdd(ctx),
  "/search": (ctx, arg) => arg ? sendSearch(ctx, arg) : promptSearch(ctx),
  "/stats": sendStats,
  "/categories": sendCategories,
  "/settings": (ctx) => sendSettings(ctx),
  "/cancel": (ctx) => ctx.api.send(ctx.chatId, "❌ لغو شد.", { reply_markup: mainKeyboard(ctx.isOwner) })
};
async function showAdmin(ctx) {
  return onAdminCommand(ctx, "/admin", "");
}
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
  const name = esc2(ctx.from.first_name || "دوست من");
  const text = [
    `👋 سلام ${name}!`,
    "به ربات <b>تودو لیست</b> خوش اومدی 🌱",
    "اینجا کارهات رو ثبت می‌کنی، اولویت و ددلاین می‌ذاری، یادآور می‌گیری و پیشرفتت رو می‌بینی.",
    "",
    QUICK_ADD_HINT,
    "",
    "از منوی پایین هم می‌تونی استفاده کنی 👇 (راهنمای کامل: /help)"
  ].join("\n");
  return ctx.api.send(ctx.chatId, text, { reply_markup: mainKeyboard(ctx.isOwner) });
}
function promptAdd(ctx) {
  return Promise.all([
    setState2(ctx, { a: "add" }),
    ctx.api.send(ctx.chatId, `✍️ متن کار جدید را بفرستید.

${QUICK_ADD_HINT}`, { reply_markup: cancelKb })
  ]);
}
function promptSearch(ctx) {
  return Promise.all([
    setState2(ctx, { a: "search" }),
    ctx.api.send(ctx.chatId, "🔍 عبارت مورد نظر را بفرستید (در متن، یادداشت و دسته‌ی کارها جستجو می‌شود):", { reply_markup: cancelKb })
  ]);
}
async function quickAdd(ctx, input) {
  const p = parseQuickAdd(input, ctx.now);
  if (!p.text) return ctx.api.send(ctx.chatId, "❗️ متن کار خالی است. یک متن بفرستید.");
  if (Array.from(p.text).length > MAX_TASK_LEN) return ctx.api.send(ctx.chatId, `❗️ متن کار حداکثر ${fa(MAX_TASK_LEN)} کاراکتر می‌تواند باشد.`);
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
  return sendCard(ctx, t, DEFAULT_CTX, "✅ <b>به لیست اضافه شد!</b>\n\n");
}
function sendCard(ctx, t, lctx = DEFAULT_CTX, prefix = "") {
  return ctx.api.send(ctx.chatId, prefix + taskCard(t, ctx.now), { reply_markup: taskCardKb(t, lctx) });
}
async function sendList(ctx, filter, page) {
  const v = await buildList(ctx, filter, page);
  return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
}
async function buildList(ctx, filter, page) {
  let { total, rows } = await listTasks(ctx.db, ctx.uid, filter, page, ctx.now);
  if (!rows.length && page > 0) {
    page = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
    ({ total, rows } = await listTasks(ctx.db, ctx.uid, filter, page, ctx.now));
  }
  return listView({ filter, page, total, rows, now: ctx.now });
}
async function sendSearch(ctx, query) {
  const q = query.trim().slice(0, 100);
  const rows = await searchTasks(ctx.db, ctx.uid, q);
  if (!rows.length) return ctx.api.send(ctx.chatId, `🔍 نتیجه‌ای برای «${esc2(q)}» پیدا نشد.`);
  const text = `🔍 <b>نتایج جستجو برای «${esc2(q)}»</b> (${fa(rows.length)})

${rows.map((t) => taskLine(t, ctx.now)).join("\n\n")}`;
  const kb = inline2(rows.map((t) => [btn2(`${t.done ? "✅" : PRIORITY[t.priority].icon} ${fa(t.num)}. ${truncate(t.text, 30)}`, cb("T", t.num, DEFAULT_CTX))]));
  return ctx.api.send(ctx.chatId, text, { reply_markup: kb });
}
async function sendCategories(ctx) {
  const cats = await listCategories(ctx.db, ctx.uid);
  if (!cats.length) {
    return ctx.api.send(
      ctx.chatId,
      "🗂 هنوز دسته‌ای نساخته‌اید.\n\nبرای دسته‌بندی، موقع افزودن کار از <code>#نام_دسته</code> استفاده کنید یا از دکمه «🗂 دسته» در کارت هر کار."
    );
  }
  const text = `🗂 <b>دسته‌های شما</b>

${cats.map((c) => `• <b>${esc2(c.category)}</b> — ${fa(c.pending)} در جریان از ${fa(c.total)}`).join("\n")}`;
  const kb = inline2(cats.map((c) => [btn2(`🗂 ${c.category} (${fa(c.pending)})`, `L|c${c.category}|0`)]));
  return ctx.api.send(ctx.chatId, text, { reply_markup: kb });
}
async function sendStats(ctx) {
  const s = await userStats(ctx.db, ctx.uid, ctx.now);
  const cats = await listCategories(ctx.db, ctx.uid);
  const ratio = s.total ? s.done / s.total : 0;
  const lines = [
    "📊 <b>آمار شما</b>",
    "",
    `📝 کل کارها: <b>${fa(s.total)}</b>`,
    `✅ انجام‌شده: <b>${fa(s.done)}</b>`,
    `⏳ در جریان: <b>${fa(s.pending)}</b>`,
    `⚠️ عقب‌افتاده: <b>${fa(s.overdue)}</b>`,
    `📅 ددلاین امروز: <b>${fa(s.today)}</b>`,
    `🏁 انجام‌شده امروز: <b>${fa(s.done_today)}</b>`,
    `🗓 انجام‌شده در ۷ روز اخیر: <b>${fa(s.week)}</b>`,
    `🔁 کارهای تکراری: <b>${fa(s.recurring)}</b> · ⏰ یادآورهای فعال: <b>${fa(s.reminders)}</b>`,
    "",
    `📈 پیشرفت کلی: ${progressBar(ratio)} ${fa(Math.round(ratio * 100))}٪`,
    "",
    `🔥 اولویت کارهای در جریان: 🔴 ${fa(s.p1)} · 🟡 ${fa(s.p2)} · 🟢 ${fa(s.p3)}`
  ];
  if (cats.length) lines.push(`🗂 دسته‌ها: ${cats.slice(0, 8).map((c) => `${esc2(c.category)} ${fa(c.pending)}/${fa(c.total)}`).join(" · ")}`);
  if (s.total && s.pending === 0) lines.push("", "🎉 همه کارها انجام شده؛ عالیه!");
  else if (s.overdue) lines.push("", "💪 چند کار عقب‌افتاده دارید؛ از «📅 امروز» شروع کنید.");
  return ctx.api.send(ctx.chatId, lines.join("\n"));
}
function settingsView(ctx) {
  const h = ctx.user.digest_hour;
  const text = [
    "⚙️ <b>تنظیمات</b>",
    "",
    `🌅 خلاصه روزانه: ${h === null || h === void 0 ? "خاموش" : `هر روز ساعت ${fa(`${String(h).padStart(2, "0")}:00`)}`}`,
    "",
    "📤 «خروجی فایل» یک فایل متنی از همه کارهایتان می‌فرستد.",
    "🧹 «پاکسازی» همه کارهای انجام‌شده را حذف می‌کند."
  ].join("\n");
  const kb = inline2([
    [btn2("🌅 خلاصه روزانه", "S|dg")],
    [btn2("📤 خروجی فایل", "S|ex"), btn2("🧹 پاکسازی انجام‌شده‌ها", "S|cl")]
  ]);
  return { text, kb };
}
function sendSettings(ctx) {
  const v = settingsView(ctx);
  return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
}
async function onStateInput(ctx, msg, text) {
  const s = ctx.state;
  if (ctx.isOwner && (s.a === "addch" || s.a === "bc")) return onAdminState(ctx, msg);
  if (!text) return ctx.api.send(ctx.chatId, "📝 لطفاً پیام متنی بفرستید (یا /cancel برای لغو).");
  if (s.a === "add") return quickAdd(ctx, text);
  if (s.a === "search") {
    await clearState(ctx);
    return sendSearch(ctx, text);
  }
  const t = s.n ? await getTask(ctx.db, ctx.uid, s.n) : null;
  if (!t) {
    await clearState(ctx);
    return ctx.api.send(ctx.chatId, "❗️ این کار پیدا نشد (شاید حذف شده).");
  }
  const lctx = s.c || DEFAULT_CTX;
  const retry = (message) => ctx.api.send(ctx.chatId, message, { reply_markup: inline2([[btn2("❌ لغو", cb("T", t.num, lctx))]]) });
  switch (s.a) {
    case "text": {
      if (Array.from(text).length > MAX_TASK_LEN) return retry(`❗️ حداکثر ${fa(MAX_TASK_LEN)} کاراکتر. دوباره بفرستید:`);
      await updateTask(ctx.db, ctx.uid, t.num, { text });
      break;
    }
    case "note": {
      if (Array.from(text).length > MAX_NOTE_LEN) return retry(`❗️ یادداشت حداکثر ${fa(MAX_NOTE_LEN)} کاراکتر می‌تواند باشد. دوباره بفرستید:`);
      await updateTask(ctx.db, ctx.uid, t.num, { note: text });
      break;
    }
    case "cat": {
      const name = cleanCategory(text.replace(/^#/, ""));
      if (!name) return retry("❗️ نام دسته فقط می‌تواند حروف، عدد، فاصله، نیم‌فاصله و _ داشته باشد و کوتاه باشد (حداکثر ۲۰ حرف). دوباره بفرستید:");
      await updateTask(ctx.db, ctx.uid, t.num, { category: name });
      break;
    }
    case "due": {
      const r = parseWhen(text, ctx.now, { defaultHour: 23, defaultMinute: 59 });
      if (!r) return retry("❗️ تاریخ را متوجه نشدم. نمونه‌ها: <code>فردا</code>، <code>شنبه</code>، <code>1405/08/10</code>، <code>فردا 18:00</code>");
      await updateTask(ctx.db, ctx.uid, t.num, { due_at: r.ts, due_time: r.hasTime ? 1 : 0 });
      break;
    }
    case "rem": {
      const r = parseWhen(text, ctx.now, { defaultHour: 9, defaultMinute: 0 });
      if (!r) return retry("❗️ زمان را متوجه نشدم. نمونه‌ها: <code>30 دقیقه دیگر</code>، <code>18:30</code>، <code>فردا ساعت 9</code>");
      if (r.ts <= ctx.now) return retry("❗️ این زمان گذشته است. یک زمان در آینده بفرستید:");
      await updateTask(ctx.db, ctx.uid, t.num, { remind_at: r.ts });
      break;
    }
    default:
      await clearState(ctx);
      return COMMANDS["/cancel"](ctx);
  }
  await clearState(ctx);
  return sendCard(ctx, await getTask(ctx.db, ctx.uid, t.num), lctx, "✏️ <b>ذخیره شد.</b>\n\n");
}
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
async function onJoinCheck(ctx) {
  const missing = ctx.isOwner ? [] : await checkJoin(ctx, ctx.uid, { force: true });
  if (missing.length) {
    await ctx.toast("❌ هنوز در همه کانال‌ها عضو نشده‌اید.", true);
    const v = joinGateView(missing);
    return ctx.show(v.text, v.kb);
  }
  await ctx.toast("✅ عضویت شما تأیید شد");
  await ctx.show("✅ عضویت شما تأیید شد. خوش آمدید!", null);
  return sendWelcome(ctx);
}
async function routeCallback(ctx, data) {
  if (data === "J") return onJoinCheck(ctx);
  if (!ctx.isOwner) {
    const missing = await checkJoin(ctx, ctx.uid);
    if (missing.length) {
      await ctx.toast("🔒 اول باید در کانال‌ها عضو شوید.", true);
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
      return ctx.show("❌ لغو شد.", null);
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
      if (!ctx.isOwner) return ctx.toast("⛔️ این بخش فقط برای مالک ربات است.", true);
      return onAdminCallback(ctx, p);
    case "SN":
      return onSnooze(ctx, Number(p[0]), Number(p[1]));
    default:
      return onTaskCallback(ctx, action, p);
  }
}
async function onTaskCallback(ctx, action, p) {
  const num = Number(p[0]);
  const t = Number.isInteger(num) ? await getTask(ctx.db, ctx.uid, num) : null;
  if (!t) {
    await ctx.toast("❗️ این کار پیدا نشد (شاید حذف شده).", true);
    const v = await buildList(ctx, "p", 0);
    return ctx.show(v.text, v.kb);
  }
  const lctx = action === "T" || action === "D" || action === "X" || action === "XX" ? p[1] || DEFAULT_CTX : p[2] || DEFAULT_CTX;
  const card = async (toast) => {
    if (toast) await ctx.toast(toast);
    const fresh = await getTask(ctx.db, ctx.uid, num);
    return ctx.show(taskCard(fresh, ctx.now), taskCardKb(fresh, lctx));
  };
  const backKb = (rows = []) => inline2([...rows, [btn2("🔙 بازگشت", cb("T", num, lctx))]]);
  switch (action) {
    case "T":
      await clearState(ctx);
      return card();
    case "D":
      return card(await toggleDone(ctx, t));
    case "X":
      return ctx.show(
        `🗑 کار «<b>${esc2(truncate(t.text, 60))}</b>» حذف شود؟`,
        inline2([[btn2("✅ بله، حذف شود", cb("XX", num, lctx)), btn2("❌ نه", cb("T", num, lctx))]])
      );
    case "XX": {
      await deleteTask(ctx.db, ctx.uid, num);
      await ctx.toast("🗑 حذف شد");
      const { filter, page } = listFromCtx(lctx);
      const v = await buildList(ctx, filter, page);
      return ctx.show(v.text, v.kb);
    }
    case "E":
      return onEditMenu(ctx, t, p[1], lctx, backKb);
    case "P":
      await updateTask(ctx.db, ctx.uid, num, { priority: Math.min(3, Math.max(1, Number(p[1]) || 2)) });
      return card(`اولویت: ${PRIORITY[Number(p[1])]?.label || "متوسط"}`);
    case "C": {
      await clearState(ctx);
      const name = p[1] === "-" ? null : cleanCategory(p[1]);
      await updateTask(ctx.db, ctx.uid, num, { category: name });
      return card(name ? `🗂 دسته: ${name}` : "🗂 دسته حذف شد");
    }
    case "DD": {
      await clearState(ctx);
      if (p[1] === "x") {
        await updateTask(ctx.db, ctx.uid, num, { due_at: null, due_time: 0 });
        return card("📅 ددلاین حذف شد");
      }
      const days = Number(p[1]) || 0;
      const base = days === 30 ? addRepeat(ctx.now, "m") : ctx.now + days * DAY;
      const lp = localParts(base);
      const ts = fromLocal(lp.y, lp.m, lp.d, 23, 59);
      await updateTask(ctx.db, ctx.uid, num, { due_at: ts, due_time: 0 });
      return card(`📅 ددلاین: ${formatShortDate(ts)}`);
    }
    case "RM": {
      await clearState(ctx);
      if (p[1] === "x") {
        await updateTask(ctx.db, ctx.uid, num, { remind_at: null });
        return card("⏰ یادآور حذف شد");
      }
      const ts = reminderPreset(ctx.now, p[1], t);
      if (!ts || ts <= ctx.now) return ctx.toast("❗️ این زمان گذشته است؛ زمان دیگری انتخاب کنید.", true);
      await updateTask(ctx.db, ctx.uid, num, { remind_at: ts });
      return card(`⏰ یادآور: ${formatDate(ts, { now: ctx.now })}`);
    }
    case "RP": {
      const repeat = ["d", "w", "m"].includes(p[1]) ? p[1] : null;
      await updateTask(ctx.db, ctx.uid, num, { repeat });
      return card(repeat ? `🔁 تکرار ${REPEAT_LABELS[repeat]}` : "🔁 تکرار خاموش شد");
    }
    case "NX":
      await clearState(ctx);
      await updateTask(ctx.db, ctx.uid, num, { note: null });
      return card("📝 یادداشت حذف شد");
    default:
      return ctx.toast("دستور نامعتبر");
  }
}
async function onEditMenu(ctx, t, field, lctx, backKb) {
  const num = t.num;
  const title = `<b>${fa(num)}. ${esc2(truncate(t.text, 60))}</b>

`;
  switch (field) {
    case "t":
      await setState2(ctx, { a: "text", n: num, c: lctx });
      return ctx.show(`${title}✏️ متن جدید این کار را بفرستید:

<code>${esc2(t.text)}</code>`, backKb());
    case "n":
      await setState2(ctx, { a: "note", n: num, c: lctx });
      return ctx.show(
        `${title}📝 یادداشت این کار را بفرستید${t.note ? " (جایگزین یادداشت فعلی می‌شود)" : ""}:${t.note ? `

<i>${esc2(t.note)}</i>` : ""}`,
        backKb(t.note ? [[btn2("🗑 حذف یادداشت", cb("NX", num, "", lctx))]] : [])
      );
    case "p":
      return ctx.show(`${title}🔥 اولویت را انتخاب کنید:`, priorityKb(num, lctx));
    case "c": {
      await setState2(ctx, { a: "cat", n: num, c: lctx });
      const cats = await listCategories(ctx.db, ctx.uid);
      return ctx.show(`${title}🗂 یک دسته انتخاب کنید یا <b>نام دسته جدید</b> را تایپ کنید:`, categoryKb(num, cats, t.category, lctx));
    }
    case "d":
      await setState2(ctx, { a: "due", n: num, c: lctx });
      return ctx.show(
        `${title}📅 ددلاین را انتخاب کنید یا تایپ کنید.
نمونه: <code>فردا</code>، <code>شنبه 18:00</code>، <code>1405/08/10</code>، <code>+5</code>`,
        dueKb(num, !!t.due_at, lctx)
      );
    case "r":
      await setState2(ctx, { a: "rem", n: num, c: lctx });
      return ctx.show(
        `${title}⏰ زمان یادآوری را انتخاب کنید یا تایپ کنید.
نمونه: <code>45 دقیقه دیگر</code>، <code>18:30</code>، <code>فردا ساعت 8</code>، <code>1405/08/10 10:00</code>`,
        reminderKb(num, t, lctx)
      );
    case "R":
      return ctx.show(
        `${title}🔁 تکرار این کار را انتخاب کنید.
با انجام هر نوبت، ددلاین (و یادآور) خودکار به نوبت بعد منتقل می‌شود.`,
        repeatKb(num, t.repeat, lctx)
      );
    default:
      return ctx.toast("دستور نامعتبر");
  }
}
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
async function toggleDone(ctx, t) {
  if (t.done) {
    await updateTask(ctx.db, ctx.uid, t.num, { done: 0, done_at: null });
    return "↩️ به کارهای در جریان برگشت";
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
    return `🔁 انجام شد! نوبت بعد: ${formatShortDate(next)}`;
  }
  await updateTask(ctx.db, ctx.uid, t.num, { done: 1, done_at: ctx.now, remind_at: null });
  return "✅ آفرین! انجام شد";
}
async function onSnooze(ctx, num, minutes) {
  const t = await getTask(ctx.db, ctx.uid, num);
  if (!t || t.done) return ctx.show("ℹ️ این کار دیگر در جریان نیست.", null);
  const ts = ctx.now + (minutes || 10) * MINUTE;
  await updateTask(ctx.db, ctx.uid, num, { remind_at: ts });
  await ctx.toast("😴 به تعویق افتاد");
  return ctx.show(
    `😴 یادآوری «<b>${esc2(t.text)}</b>» به ساعت ${formatTime(ts)} موکول شد.`,
    inline2([[btn2("📄 جزئیات کار", cb("T", num, DEFAULT_CTX))]])
  );
}
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
        rows.push(hours.slice(i, i + 4).map((h) => btn2(`${ctx.user.digest_hour === h ? "✓ " : ""}${fa(`${h}:00`)}`, `S|dh|${h}`)));
      }
      rows.push([btn2("🔕 خاموش", "S|dh|x"), btn2("🔙 بازگشت", "S|h")]);
      return ctx.show(
        "🌅 <b>خلاصه روزانه</b>\n\nهر روز در ساعت انتخابی، لیست کارهای امروز، کارهای عقب‌افتاده و کارهای مهم برایتان ارسال می‌شود.\nساعت را انتخاب کنید:",
        inline2(rows)
      );
    }
    case "dh": {
      const hour = arg === "x" ? null : Math.min(23, Math.max(0, Number(arg)));
      const last = hour !== null && localParts(ctx.now).hh >= hour ? localDateKey(ctx.now) : null;
      await setDigest(ctx.db, ctx.uid, hour, last);
      ctx.user.digest_hour = hour;
      await ctx.toast(hour === null ? "🔕 خلاصه روزانه خاموش شد" : `🌅 هر روز ساعت ${fa(hour)}:۰۰`);
      const v = settingsView(ctx);
      return ctx.show(v.text, v.kb);
    }
    case "ex": {
      const tasks = await allTasks(ctx.db, ctx.uid);
      if (!tasks.length) return ctx.toast("هنوز کاری ثبت نکرده‌اید.", true);
      await ctx.toast("📤 در حال آماده‌سازی فایل...");
      return ctx.api.sendDocument(ctx.chatId, `todo-${localDateKey(ctx.now)}.txt`, exportText(tasks, ctx.now), `📤 خروجی ${fa(tasks.length)} کار شما`);
    }
    case "cl":
      return ctx.show("🧹 همه کارهای <b>انجام‌شده</b> برای همیشه حذف شوند؟", inline2([[btn2("✅ بله، پاک کن", "S|cly"), btn2("❌ نه", "S|h")]]));
    case "cly": {
      const r = await clearDone(ctx.db, ctx.uid);
      await ctx.toast(`🧹 ${fa(r.meta.changes || 0)} کار انجام‌شده پاک شد`, true);
      const v = settingsView(ctx);
      return ctx.show(v.text, v.kb);
    }
    default:
      return ctx.toast("دستور نامعتبر");
  }
}
function exportText(tasks, now) {
  const pending = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const line = (t) => {
    const parts = [`${t.done ? "[✔]" : `[${PRIORITY[t.priority].icon}]`} #${t.num} ${t.text}`];
    if (t.category) parts.push(`دسته: ${t.category}`);
    if (t.due_at) parts.push(`ددلاین: ${formatDate(t.due_at, { time: !!t.due_time, now })}`);
    if (t.remind_at && !t.done) parts.push(`یادآور: ${formatDate(t.remind_at, { now })}`);
    if (t.repeat) parts.push(`تکرار: ${REPEAT_LABELS[t.repeat]}`);
    if (t.done_at) parts.push(`انجام: ${formatDate(t.done_at, { now })}`);
    return parts.join(" | ") + (t.note ? `
      یادداشت: ${t.note.replace(/\n/g, "\n      ")}` : "");
  };
  return [
    `خروجی تودو لیست — ${formatDate(now, { now })}`,
    "=".repeat(40),
    "",
    `⏳ در جریان (${pending.length})`,
    ...pending.map(line),
    "",
    `✅ انجام‌شده (${done.length})`,
    ...done.map(line),
    ""
  ].join("\n");
}

// src/cron.js
var transient = (r) => !r.ok && (r.error_code === 429 || r.error_code === 0 || r.error_code >= 500);
var COST = { reminder: 3, digest: 5, broadcastItem: 2, broadcastFixed: 5 };
function metered(env, limit) {
  let used = 0;
  const wrap = (stmt) => ({
    stmt,
    bind: (...args) => wrap(stmt.bind(...args)),
    first: (...args) => (used += 1, stmt.first(...args)),
    run: () => (used += 1, stmt.run()),
    all: () => (used += 1, stmt.all())
  });
  const db = {
    prepare: (sql) => wrap(env.DB.prepare(sql)),
    // Counted per statement: the docs don't say whether a batch counts once, so assume the worst.
    batch: (list) => (used += list.length, env.DB.batch(list.map((s) => s.stmt)))
  };
  const raw = createApi(env);
  const api = { ...raw, call: (...a) => (used += 1, raw.call(...a)), send: (...a) => (used += 1, raw.send(...a)) };
  return { db, api, left: () => limit - used };
}
var affordable = (ctx, fixed, each, max) => Math.max(0, Math.min(max, Math.floor((ctx.left() - fixed) / each)));
async function runCron(env, now) {
  const m = metered(env, CRON_SUBREQUESTS);
  await ensureSchema(m.db);
  await setSetting(m.db, "last_cron", String(Date.now()));
  const ctx = { env, now, ...m };
  const results = [];
  for (const job of [sendReminders, sendDigests, runBroadcast]) {
    try {
      results.push(await job(ctx));
    } catch (err) {
      console.error(`cron ${job.name} failed:`, err?.stack || err);
      results.push(0);
    }
  }
  return results;
}
async function sendReminders(ctx) {
  const n = affordable(ctx, 1, COST.reminder, CRON_BUDGET.reminders);
  if (!n) return 0;
  const tasks = await dueReminders(ctx.db, ctx.now, n);
  let sent = 0;
  await Promise.all(
    tasks.map(async (t) => {
      const next = t.repeat ? nextOccurrence(t.remind_at, t.repeat, ctx.now) : null;
      const claim = await ctx.db.prepare(`UPDATE tasks SET remind_at = ? WHERE id = ? AND remind_at = ?`).bind(next, t.id, t.remind_at).run();
      if (!claim.meta.changes) return;
      const r = await ctx.api.send(t.user_id, `⏰ <b>یادآوری</b>

${taskLine(t, ctx.now, Infinity)}${t.note ? `

📝 ${esc(t.note)}` : ""}`, {
        reply_markup: inline([
          [btn("✅ انجام شد", cb("D", t.num, "p.0")), btn("📄 جزئیات", cb("T", t.num, "p.0"))],
          [btn("😴 ۱۰ دقیقه بعد", `SN|${t.num}|10`), btn("😴 ۱ ساعت بعد", `SN|${t.num}|60`)]
        ])
      });
      if (r.ok) sent += 1;
      else if (isBlockedError(r)) await markBlocked(ctx.db, t.user_id);
      else if (transient(r)) await ctx.db.prepare(`UPDATE tasks SET remind_at = ? WHERE id = ?`).bind(t.remind_at, t.id).run();
    })
  );
  return sent;
}
function greeting(hour) {
  if (hour < 12) return "🌅 صبح بخیر";
  if (hour < 17) return "☀️ روز بخیر";
  return "🌙 عصر بخیر";
}
async function sendDigests(ctx) {
  const n = affordable(ctx, 1, COST.digest, CRON_BUDGET.digests);
  if (!n) return 0;
  const lp = localParts(ctx.now);
  const key = localDateKey(ctx.now);
  const users = await digestCandidates(ctx.db, lp.hh, key, n);
  let sent = 0;
  await Promise.all(
    users.map(async (u) => {
      const claim = await ctx.db.prepare(`UPDATE users SET digest_last = ? WHERE id = ? AND (digest_last IS NULL OR digest_last <> ?)`).bind(key, u.id, key).run();
      if (!claim.meta.changes) return;
      const [stats, tasks] = await Promise.all([userStats(ctx.db, u.id, ctx.now), pendingForDigest(ctx.db, u.id, ctx.now)]);
      const lines = [
        `${greeting(lp.hh)} ${esc(u.first_name || "")}!`,
        `📋 <b>خلاصه روزانه</b> — ${formatDate(ctx.now, { time: false, now: ctx.now })}`,
        "",
        `⏳ در جریان: <b>${fa(stats.pending)}</b> · 📅 امروز: <b>${fa(stats.today)}</b> · ⚠️ عقب‌افتاده: <b>${fa(stats.overdue)}</b>`,
        `🏁 در ۷ روز اخیر <b>${fa(stats.week)}</b> کار انجام داده‌اید.`,
        ""
      ];
      if (tasks.length) lines.push("<b>کارهای مهم امروز:</b>", "", tasks.map((t) => taskLine(t, ctx.now)).join("\n\n"));
      else lines.push("🎉 هیچ کار در جریانی ندارید. یک روز عالی داشته باشید!");
      const r = await ctx.api.send(u.id, lines.join("\n"), {
        reply_markup: inline([[btn("📋 همه کارها", "L|p|0"), btn("📅 کارهای امروز", "L|t|0")]])
      });
      if (r.ok) sent += 1;
      else if (isBlockedError(r)) await markBlocked(ctx.db, u.id);
      else if (transient(r)) await ctx.db.prepare(`UPDATE users SET digest_last = ? WHERE id = ?`).bind(u.digest_last, u.id).run();
    })
  );
  return sent;
}
async function runBroadcast(ctx) {
  const n = affordable(ctx, COST.broadcastFixed, COST.broadcastItem, CRON_BUDGET.broadcast);
  if (!n) return 0;
  const b = await activeBroadcast(ctx.db);
  if (!b) return 0;
  const targets = await broadcastTargets(ctx.db, b.cursor, n);
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
  const finished = targets.length < n;
  const cursor = targets.length ? targets[targets.length - 1] : b.cursor;
  await updateBroadcast(ctx.db, b.id, cursor, sent, failed, finished ? "done" : "running");
  if (finished) {
    const total = await getBroadcast(ctx.db, b.id);
    await ctx.api.send(
      ownerId(ctx.env),
      `📣 <b>ارسال همگانی تمام شد.</b>

✅ موفق: ${fa(total.sent)}
❌ ناموفق: ${fa(total.failed)}`
    );
  }
  return sent;
}

// src/index.js
var json = (data, status2 = 200) => new Response(JSON.stringify(data, null, 2), { status: status2, headers: { "content-type": "application/json; charset=utf-8" } });
var USER_COMMANDS = [
  { command: "start", description: "شروع و منوی اصلی" },
  { command: "list", description: "کارهای در جریان" },
  { command: "today", description: "کارهای امروز و عقب‌افتاده" },
  { command: "add", description: "افزودن کار جدید" },
  { command: "search", description: "جستجو در کارها" },
  { command: "categories", description: "دسته‌بندی‌ها" },
  { command: "stats", description: "آمار و پیشرفت" },
  { command: "settings", description: "تنظیمات، خلاصه روزانه و خروجی" },
  { command: "help", description: "راهنما" },
  { command: "cancel", description: "لغو عملیات جاری" }
];
var OWNER_COMMANDS = [
  ...USER_COMMANDS,
  { command: "admin", description: "پنل مدیریت" },
  { command: "channels", description: "کانال‌های جوین اجباری" },
  { command: "addchannel", description: "افزودن کانال جوین اجباری" },
  { command: "delchannel", description: "حذف کانال جوین اجباری" }
];
async function setup(request, env) {
  const url = new URL(request.url);
  const webhookSecret = secret(env, "WEBHOOK_SECRET");
  if (!secret(env, "BOT_TOKEN") || !webhookSecret) {
    return json({ ok: false, error: "BOT_TOKEN و WEBHOOK_SECRET را اول به‌صورت Secret تعریف کنید. / Set the BOT_TOKEN and WEBHOOK_SECRET secrets first." }, 500);
  }
  if (!WEBHOOK_SECRET_RE.test(webhookSecret)) {
    return json({ ok: false, error: "WEBHOOK_SECRET فقط می‌تواند حروف انگلیسی، عدد، _ و - داشته باشد. / WEBHOOK_SECRET may only contain A-Z a-z 0-9 _ -" }, 500);
  }
  if ((url.searchParams.get("secret") || "").trim() !== webhookSecret) return json({ ok: false, error: "wrong secret" }, 403);
  const api = createApi(env);
  const webhook = await api.call("setWebhook", {
    url: `${url.origin}/webhook`,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
    max_connections: 40
  });
  const commands = await api.call("setMyCommands", { commands: USER_COMMANDS });
  const ownerCommands = await api.call("setMyCommands", { commands: OWNER_COMMANDS, scope: { type: "chat", chat_id: ownerId(env) } });
  const me = await api.call("getMe");
  return json({
    ok: webhook.ok,
    webhook,
    commands,
    ownerCommands: ownerCommands.ok ? ownerCommands : `${ownerCommands.description} (the owner must /start the bot first, then open /setup again)`,
    bot: me.result
  });
}
async function status(request, env) {
  const origin = new URL(request.url).origin;
  const rows = [];
  const check = (ok, label, hint = "") => {
    rows.push({ ok, label, hint });
    return ok;
  };
  let dbOk = false;
  let dbError = "";
  if (env.DB && typeof env.DB.prepare === "function") {
    try {
      await ensureSchema(env.DB);
      dbOk = true;
    } catch (err) {
      dbError = String(err?.message || err);
    }
  }
  check(dbOk, "دیتابیس D1 با نام متغیر <code>DB</code>", dbError ? esc(dbError) : "یک دیتابیس D1 بسازید و در Bindings با Variable name دقیقاً <code>DB</code> به ورکر وصل کنید.");
  const token = secret(env, "BOT_TOKEN");
  const api = createApi(env);
  const me = token ? await api.call("getMe") : null;
  check(
    !!me?.ok,
    `توکن ربات <code>BOT_TOKEN</code>${me?.ok ? ` — @${esc(me.result.username)}` : ""}`,
    token ? `تلگرام توکن را قبول نکرد (${esc(me?.description || "")}). توکن را دوباره از BotFather کپی کنید.` : "یک Secret با نام <code>BOT_TOKEN</code> و مقدار توکن BotFather بسازید."
  );
  const webhookSecret = secret(env, "WEBHOOK_SECRET");
  check(
    WEBHOOK_SECRET_RE.test(webhookSecret),
    "رمز وبهوک <code>WEBHOOK_SECRET</code>",
    webhookSecret ? "فقط حروف انگلیسی، عدد، _ و - مجاز است (بدون فاصله)." : "یک Secret با نام <code>WEBHOOK_SECRET</code> بسازید (مثلاً <code>MyBot_2026_secret</code>)."
  );
  if (me?.ok) {
    const info = await api.call("getWebhookInfo");
    const hookOk = info.ok && info.result.url === `${origin}/webhook`;
    check(hookOk, "اتصال وبهوک تلگرام", `یک بار این آدرس را باز کنید: <code>${esc(origin)}/setup?secret=رمز_وبهوک</code>`);
    if (hookOk && info.result.last_error_message) {
      rows.push({ warn: true, label: `آخرین خطای تلگرام: ${esc(info.result.last_error_message)}`, hint: "اگر قدیمی است نگران نباشید." });
    }
  }
  if (dbOk) {
    const last = Number(await getSetting(env.DB, "last_cron")) || 0;
    const minutes = Math.floor((Date.now() - last) / 6e4);
    check(
      last > 0 && minutes < 3,
      `کرون یادآورها${last ? ` — آخرین اجرا ${minutes < 1 ? "کمتر از ۱ دقیقه" : `${fa(minutes)} دقیقه`} پیش` : ""}`,
      "در Settings ← Trigger events یک Cron Trigger با عبارت <code>* * * * *</code> اضافه کنید. شروع به کار کرون جدید ممکن است تا ۱۵ دقیقه طول بکشد."
    );
    const channels = await listChannels(env.DB);
    rows.push({ info: true, label: `کانال‌های جوین اجباری: ${fa(channels.length)} — مالک: <code>${ownerId(env)}</code>` });
  }
  const allOk = rows.every((r) => r.ok !== false);
  const items = rows.map((r) => {
    const icon = r.info ? "ℹ️" : r.warn ? "⚠️" : r.ok ? "✅" : "❌";
    const hint = r.ok === false || r.warn ? `<div class="hint">${r.hint}</div>` : "";
    return `<li><span>${icon}</span><div>${r.label}${hint}</div></li>`;
  }).join("");
  const html = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>وضعیت ربات</title>
<style>body{font-family:Vazirmatn,Tahoma,system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;line-height:1.9;background:#f7f7f8;color:#1d1d1f}
ul{list-style:none;padding:0}li{display:flex;gap:10px;background:#fff;border-radius:12px;padding:12px 14px;margin:8px 0;box-shadow:0 1px 2px #0001}
.hint{font-size:.9em;color:#a33}code{direction:ltr;unicode-bidi:embed;background:#eee;padding:0 4px;border-radius:4px}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}li{background:#1c1c1e}.hint{color:#f88}code{background:#333}}</style></head>
<body><h2>🤖 وضعیت ربات تودو لیست</h2><p>${allOk ? "🎉 همه‌چیز آماده است. ربات را در تلگرام /start کنید." : "موارد ❌ را طبق توضیح هرکدام درست کنید و این صفحه را دوباره باز کنید."}</p><ul>${items}</ul></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
var index_default = {
  async fetch(request, env) {
    setTzOffset(env.TZ_OFFSET_MINUTES);
    const url = new URL(request.url);
    if (url.pathname === "/webhook" && request.method === "POST") {
      const webhookSecret = secret(env, "WEBHOOK_SECRET");
      if (!webhookSecret || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== webhookSecret) {
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
    if (url.pathname === "/") return status(request, env);
    return new Response("not found", { status: 404 });
  },
  async scheduled(event, env, ctx) {
    setTzOffset(env.TZ_OFFSET_MINUTES);
    ctx.waitUntil(runCron(env, event.scheduledTime));
  }
};
export {
  index_default as default
};
