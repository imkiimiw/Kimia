import { DEFAULT_CHANNELS, PAGE_SIZE } from './config.js';
import { DAY, startOfLocalDay } from './time.js';

const SCHEMA = [
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
  )`,
];

let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  // Seed the initial mandatory channels exactly once; afterwards only the owner changes them.
  const seeded = await db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('seeded', '1')`).run();
  if (seeded.meta.changes) {
    const now = Date.now();
    await db.batch(
      DEFAULT_CHANNELS.map((chat) =>
        db
          .prepare(`INSERT OR IGNORE INTO channels (chat, link, created_at) VALUES (?, ?, ?)`)
          .bind(chat, `https://t.me/${chat.slice(1)}`, now),
      ),
    );
  }
  schemaReady = true;
}

// ---------- users ----------

export async function touchUser(db, from, now) {
  const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(from.id).first();
  const name = from.first_name || '';
  const username = from.username || null;
  if (!user) {
    await db
      .prepare(`INSERT INTO users (id, first_name, username, created_at, last_seen) VALUES (?, ?, ?, ?, ?)`)
      .bind(from.id, name, username, now, now)
      .run();
    return { id: from.id, first_name: name, username, created_at: now, last_seen: now, task_seq: 0, state: null, digest_hour: null, digest_last: null, blocked: 0, isNew: true };
  }
  if (user.first_name !== name || user.username !== username || user.blocked || now - user.last_seen > 10 * 60_000) {
    await db
      .prepare(`UPDATE users SET first_name = ?, username = ?, last_seen = ?, blocked = 0 WHERE id = ?`)
      .bind(name, username, now, from.id)
      .run();
  }
  return user;
}

export function parseState(user) {
  try {
    return user.state ? JSON.parse(user.state) : null;
  } catch {
    return null;
  }
}

export function setState(db, userId, state) {
  return db
    .prepare(`UPDATE users SET state = ? WHERE id = ?`)
    .bind(state ? JSON.stringify(state) : null, userId)
    .run();
}

export function setDigest(db, userId, hour, lastKey) {
  return db.prepare(`UPDATE users SET digest_hour = ?, digest_last = ? WHERE id = ?`).bind(hour, lastKey, userId).run();
}

export function markBlocked(db, userId) {
  return db.prepare(`UPDATE users SET blocked = 1 WHERE id = ?`).bind(userId).run();
}

// ---------- tasks ----------

const EDITABLE = new Set(['text', 'note', 'priority', 'category', 'due_at', 'due_time', 'remind_at', 'repeat', 'done', 'done_at']);

export async function addTask(db, userId, fields, now) {
  const seq = await db.prepare(`UPDATE users SET task_seq = task_seq + 1 WHERE id = ? RETURNING task_seq`).bind(userId).first();
  const num = seq.task_seq;
  await db
    .prepare(
      `INSERT INTO tasks (user_id, num, text, note, priority, category, due_at, due_time, remind_at, repeat, done, done_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
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
      now,
    )
    .run();
  return getTask(db, userId, num);
}

export function getTask(db, userId, num) {
  return db.prepare(`SELECT * FROM tasks WHERE user_id = ? AND num = ?`).bind(userId, num).first();
}

export function updateTask(db, userId, num, fields) {
  const keys = Object.keys(fields).filter((k) => EDITABLE.has(k));
  if (!keys.length) return null;
  return db
    .prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE user_id = ? AND num = ?`)
    .bind(...keys.map((k) => fields[k] ?? null), userId, num)
    .run();
}

export function deleteTask(db, userId, num) {
  return db.prepare(`DELETE FROM tasks WHERE user_id = ? AND num = ?`).bind(userId, num).run();
}

const PENDING_ORDER = `priority ASC, due_at IS NULL, due_at ASC, num ASC`;

function filterSql(filter, now) {
  if (filter === 'd') return { where: `done = 1`, order: `done_at DESC`, args: [] };
  if (filter === 't') return { where: `done = 0 AND due_at IS NOT NULL AND due_at < ?`, order: `due_at ASC, priority ASC`, args: [startOfLocalDay(now) + DAY] };
  if (filter === 'a') return { where: `1 = 1`, order: `done ASC, ${PENDING_ORDER}`, args: [] };
  if (filter.startsWith('c')) return { where: `category = ?`, order: `done ASC, ${PENDING_ORDER}`, args: [filter.slice(1)] };
  return { where: `done = 0`, order: PENDING_ORDER, args: [] };
}

export async function listTasks(db, userId, filter, page, now) {
  const f = filterSql(filter, now);
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND ${f.where}`).bind(userId, ...f.args),
    db
      .prepare(`SELECT * FROM tasks WHERE user_id = ? AND ${f.where} ORDER BY ${f.order} LIMIT ? OFFSET ?`)
      .bind(userId, ...f.args, PAGE_SIZE, page * PAGE_SIZE),
  ]);
  return { total: count.results[0].n, rows: rows.results };
}

export async function searchTasks(db, userId, query) {
  const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { results } = await db
    .prepare(
      `SELECT * FROM tasks WHERE user_id = ?1 AND (text LIKE ?2 ESCAPE '\\' OR note LIKE ?2 ESCAPE '\\' OR category LIKE ?2 ESCAPE '\\')
       ORDER BY done ASC, ${PENDING_ORDER} LIMIT 10`,
    )
    .bind(userId, like)
    .all();
  return results;
}

export async function listCategories(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT category, SUM(done = 0) AS pending, COUNT(*) AS total FROM tasks
       WHERE user_id = ? AND category IS NOT NULL GROUP BY category ORDER BY pending DESC, category LIMIT 30`,
    )
    .bind(userId)
    .all();
  return results;
}

export async function userStats(db, userId, now) {
  const today = startOfLocalDay(now);
  const row = await db
    .prepare(
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
       FROM tasks WHERE user_id = ?1`,
    )
    .bind(userId, now, today, today + DAY, now - 7 * DAY)
    .first();
  return row;
}

export async function allTasks(db, userId) {
  const { results } = await db.prepare(`SELECT * FROM tasks WHERE user_id = ? ORDER BY done ASC, ${PENDING_ORDER}`).bind(userId).all();
  return results;
}

export function clearDone(db, userId) {
  return db.prepare(`DELETE FROM tasks WHERE user_id = ? AND done = 1`).bind(userId).run();
}

// ---------- channels ----------

export async function listChannels(db) {
  const { results } = await db.prepare(`SELECT * FROM channels ORDER BY id`).all();
  return results;
}

export function addChannel(db, chat, title, link, now) {
  return db.prepare(`INSERT OR IGNORE INTO channels (chat, title, link, created_at) VALUES (?, ?, ?, ?)`).bind(chat, title, link, now).run();
}

export function removeChannel(db, id) {
  return db.prepare(`DELETE FROM channels WHERE id = ?`).bind(id).run();
}

export function getChannel(db, id) {
  return db.prepare(`SELECT * FROM channels WHERE id = ?`).bind(id).first();
}

export function setChannelTitle(db, id, title) {
  return db.prepare(`UPDATE channels SET title = ? WHERE id = ?`).bind(title, id).run();
}

// ---------- cron queries ----------

export async function dueReminders(db, now, limit) {
  const { results } = await db
    .prepare(
      `SELECT t.* FROM tasks t JOIN users u ON u.id = t.user_id
       WHERE t.remind_at IS NOT NULL AND t.remind_at <= ? AND t.done = 0 AND u.blocked = 0
       ORDER BY t.remind_at LIMIT ?`,
    )
    .bind(now, limit)
    .all();
  return results;
}

export async function digestCandidates(db, hour, dateKey, limit) {
  const { results } = await db
    .prepare(
      `SELECT * FROM users WHERE digest_hour IS NOT NULL AND digest_hour <= ? AND (digest_last IS NULL OR digest_last <> ?) AND blocked = 0
       ORDER BY id LIMIT ?`,
    )
    .bind(hour, dateKey, limit)
    .all();
  return results;
}

export async function pendingForDigest(db, userId, now) {
  const end = startOfLocalDay(now) + DAY;
  const { results } = await db
    .prepare(
      `SELECT * FROM tasks WHERE user_id = ? AND done = 0
       ORDER BY (due_at IS NOT NULL AND due_at < ?) DESC, ${PENDING_ORDER} LIMIT 10`,
    )
    .bind(userId, end)
    .all();
  return results;
}

// ---------- broadcasts & bot stats ----------

export function activeBroadcast(db) {
  return db.prepare(`SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id LIMIT 1`).first();
}

export function createBroadcast(db, fromChat, messageId, now) {
  return db.prepare(`INSERT INTO broadcasts (from_chat, message_id, created_at) VALUES (?, ?, ?)`).bind(fromChat, messageId, now).run();
}

export async function broadcastTargets(db, cursor, limit) {
  const { results } = await db.prepare(`SELECT id FROM users WHERE id > ? AND blocked = 0 ORDER BY id LIMIT ?`).bind(cursor, limit).all();
  return results.map((r) => r.id);
}

export function updateBroadcast(db, id, cursor, sent, failed, status) {
  return db
    .prepare(`UPDATE broadcasts SET cursor = ?, sent = sent + ?, failed = failed + ?, status = ? WHERE id = ?`)
    .bind(cursor, sent, failed, status, id)
    .run();
}

export function getBroadcast(db, id) {
  return db.prepare(`SELECT * FROM broadcasts WHERE id = ?`).bind(id).first();
}

export async function botStats(db, now) {
  const [u, t] = await db.batch([
    db
      .prepare(
        `SELECT COUNT(*) AS users, COALESCE(SUM(last_seen >= ?), 0) AS active_day, COALESCE(SUM(last_seen >= ?), 0) AS active_week,
           COALESCE(SUM(blocked = 1), 0) AS blocked, COALESCE(SUM(created_at >= ?), 0) AS new_day FROM users`,
      )
      .bind(now - DAY, now - 7 * DAY, now - DAY),
    db.prepare(`SELECT COUNT(*) AS tasks, COALESCE(SUM(done = 1), 0) AS done FROM tasks`),
  ]);
  return { ...u.results[0], ...t.results[0] };
}

export async function countActiveUsers(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE blocked = 0`).first();
  return row.n;
}
