// All database access. Every query on user data is filtered by user_id and served by an index
// (tasks: idx_tasks_user / idx_tasks_user_cat, categories: uq_categories_user_name), and every
// list is LIMITed, so no update ever scans a whole table. Raw SQL rows come back unconverted:
// integers as numbers, 0/1 flags as numbers.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { DEFAULT_CHANNELS, MAX_CHANNELS, MAX_CATEGORIES, PAGE_SIZE } from './config.js';

export const nowSec = () => Math.floor(Date.now() / 1000);

// ---------- users & state ----------

/** The user's row plus any pending state, in one query; null for a new user. */
export async function loadUser(userId) {
  const row = await db.get(sql`
    SELECT u.id, u.sort, u.last_search, s.state, s.data, s.updated_at AS state_at
    FROM users u LEFT JOIN user_state s ON s.user_id = u.id
    WHERE u.id = ${userId}`);
  if (!row) return null;
  let data = null;
  if (row.data) {
    try {
      data = JSON.parse(row.data);
    } catch {
      data = null;
    }
  }
  return {
    id: Number(row.id),
    sort: row.sort || 'p',
    lastSearch: row.last_search || null,
    state: row.state || null,
    stateData: data || {},
    stateAt: Number(row.state_at || 0),
  };
}

export async function createUser(userId, firstName) {
  const r = await db.run(sql`
    INSERT OR IGNORE INTO users (id, first_name, sort, created_at)
    VALUES (${userId}, ${firstName || null}, 'p', ${nowSec()})`);
  if (r.rowsAffected > 0) {
    await db.run(sql`
      INSERT INTO settings (key, value) VALUES ('users', '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`);
  }
  return { id: userId, sort: 'p', lastSearch: null, state: null, stateData: {}, stateAt: 0 };
}

export async function setSort(userId, sort) {
  await db.run(sql`UPDATE users SET sort = ${sort} WHERE id = ${userId}`);
}

export async function setLastSearch(userId, query) {
  await db.run(sql`UPDATE users SET last_search = ${query} WHERE id = ${userId}`);
}

export async function setState(userId, state, data = {}) {
  await db.run(sql`
    INSERT INTO user_state (user_id, state, data, updated_at)
    VALUES (${userId}, ${state}, ${JSON.stringify(data)}, ${nowSec()})
    ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`);
}

export async function clearState(userId) {
  await db.run(sql`DELETE FROM user_state WHERE user_id = ${userId}`);
}

// ---------- settings ----------

export async function getSettings() {
  const rows = await db.all(sql`SELECT key, value FROM settings WHERE key IN ('join', 'seeded', 'users')`);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setSetting(key, value) {
  await db.run(sql`
    INSERT INTO settings (key, value) VALUES (${key}, ${value})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
}

// ---------- channels ----------

function channelRow(r) {
  return {
    id: Number(r.id),
    username: r.username,
    chatId: r.chat_id === null || r.chat_id === undefined ? null : Number(r.chat_id),
    title: r.title || null,
    warnedAt: Number(r.warned_at || 0),
  };
}

/**
 * The mandatory channels. On the very first run (empty table, never seeded) the default
 * channels are inserted first. Once seeded, an empty list stays empty (the owner removed them all).
 */
export async function getChannels(settings) {
  const rows = await db.all(sql`SELECT * FROM channels ORDER BY id LIMIT ${MAX_CHANNELS + 5}`);
  if (rows.length || settings.seeded === '1') return rows.map(channelRow);
  const now = nowSec();
  for (const username of DEFAULT_CHANNELS) {
    await db.run(sql`
      INSERT OR IGNORE INTO channels (uname, username, created_at)
      VALUES (${username.toLowerCase()}, ${username}, ${now})`);
  }
  await setSetting('seeded', '1');
  settings.seeded = '1';
  const seeded = await db.all(sql`SELECT * FROM channels ORDER BY id LIMIT ${MAX_CHANNELS + 5}`);
  return seeded.map(channelRow);
}

export async function getChannel(id) {
  const r = await db.get(sql`SELECT * FROM channels WHERE id = ${id}`);
  return r ? channelRow(r) : null;
}

export async function findChannelByName(username) {
  const r = await db.get(sql`SELECT * FROM channels WHERE uname = ${username.toLowerCase()}`);
  return r ? channelRow(r) : null;
}

export async function countChannels() {
  const r = await db.get(sql`SELECT count(*) AS n FROM channels`);
  return Number((r && r.n) || 0);
}

/** Inserts a channel; false if it is already in the list. */
export async function insertChannel({ username, chatId, title }) {
  const r = await db.run(sql`
    INSERT OR IGNORE INTO channels (uname, username, chat_id, title, created_at)
    VALUES (${username.toLowerCase()}, ${username}, ${chatId}, ${title || null}, ${nowSec()})`);
  return r.rowsAffected > 0;
}

export async function deleteChannel(id) {
  const r = await db.run(sql`DELETE FROM channels WHERE id = ${id}`);
  return r.rowsAffected > 0;
}

/** Claims the right to warn the owner about a channel; false if someone did within `intervalSec`. */
export async function claimChannelWarning(id, intervalSec) {
  const now = nowSec();
  const r = await db.run(sql`
    UPDATE channels SET warned_at = ${now}
    WHERE id = ${id} AND warned_at <= ${now - intervalSec}`);
  return r.rowsAffected > 0;
}

// ---------- tasks ----------

function taskRow(r) {
  return {
    id: Number(r.id),
    text: r.text,
    done: Number(r.done) === 1,
    priority: Number(r.priority) || 2,
    dueDate: r.due_date || null,
    categoryId: r.category_id === null || r.category_id === undefined ? null : Number(r.category_id),
    category: r.category || null,
    createdAt: Number(r.created_at || 0),
  };
}

export async function countTasks(userId) {
  const r = await db.get(sql`SELECT count(*) AS n FROM tasks WHERE user_id = ${userId}`);
  return Number((r && r.n) || 0);
}

export async function addTask(userId, text) {
  const r = await db.run(sql`
    INSERT INTO tasks (user_id, text, done, priority, created_at)
    VALUES (${userId}, ${text}, 0, 2, ${nowSec()})
    RETURNING id`);
  return Number(r.rows[0].id);
}

/** One task, only if it belongs to the user. */
export async function getTask(userId, taskId) {
  const r = await db.get(sql`
    SELECT t.*, c.name AS category
    FROM tasks t LEFT JOIN categories c ON c.id = t.category_id AND c.user_id = t.user_id
    WHERE t.id = ${taskId} AND t.user_id = ${userId}`);
  return r ? taskRow(r) : null;
}

const ORDER = {
  // open first, then high priority first, then the nearest due date, then newest
  p: sql.raw('done ASC, priority ASC, due_date IS NULL, due_date ASC, id DESC'),
  d: sql.raw('done ASC, due_date IS NULL, due_date ASC, priority ASC, id DESC'),
  n: sql.raw('done ASC, id DESC'),
};

export async function countList(userId, categoryId) {
  const r = categoryId
    ? await db.get(sql`SELECT count(*) AS n FROM tasks WHERE user_id = ${userId} AND category_id = ${categoryId}`)
    : await db.get(sql`SELECT count(*) AS n FROM tasks WHERE user_id = ${userId}`);
  return Number((r && r.n) || 0);
}

export async function listTasks(userId, { categoryId = 0, sort = 'p', page = 0 }) {
  const order = ORDER[sort] || ORDER.p;
  const offset = page * PAGE_SIZE;
  const rows = categoryId
    ? await db.all(sql`
        SELECT * FROM tasks WHERE user_id = ${userId} AND category_id = ${categoryId}
        ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${offset}`)
    : await db.all(sql`
        SELECT * FROM tasks WHERE user_id = ${userId}
        ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${offset}`);
  return rows.map(taskRow);
}

/** Flips done/undone; returns the new state, or null if the task isn't the user's. */
export async function toggleTask(userId, taskId) {
  const r = await db.run(sql`
    UPDATE tasks
    SET done = 1 - done, done_at = CASE WHEN done = 0 THEN ${nowSec()} ELSE NULL END
    WHERE id = ${taskId} AND user_id = ${userId}
    RETURNING done`);
  return r.rows.length ? Number(r.rows[0].done) === 1 : null;
}

export async function updateTaskText(userId, taskId, text) {
  const r = await db.run(sql`UPDATE tasks SET text = ${text} WHERE id = ${taskId} AND user_id = ${userId}`);
  return r.rowsAffected > 0;
}

export async function setPriority(userId, taskId, priority) {
  const r = await db.run(sql`UPDATE tasks SET priority = ${priority} WHERE id = ${taskId} AND user_id = ${userId}`);
  return r.rowsAffected > 0;
}

export async function setDueDate(userId, taskId, isoDate) {
  const r = await db.run(sql`UPDATE tasks SET due_date = ${isoDate} WHERE id = ${taskId} AND user_id = ${userId}`);
  return r.rowsAffected > 0;
}

export async function setTaskCategory(userId, taskId, categoryId) {
  const r = await db.run(sql`UPDATE tasks SET category_id = ${categoryId} WHERE id = ${taskId} AND user_id = ${userId}`);
  return r.rowsAffected > 0;
}

export async function deleteTask(userId, taskId) {
  const r = await db.run(sql`DELETE FROM tasks WHERE id = ${taskId} AND user_id = ${userId}`);
  return r.rowsAffected > 0;
}

export async function stats(userId, todayIso) {
  const r = await db.get(sql`
    SELECT count(*) AS total,
           coalesce(sum(done), 0) AS done,
           coalesce(sum(CASE WHEN done = 0 AND due_date IS NOT NULL AND due_date < ${todayIso} THEN 1 ELSE 0 END), 0) AS overdue
    FROM tasks WHERE user_id = ${userId}`);
  const total = Number(r.total || 0);
  const done = Number(r.done || 0);
  return { total, done, open: total - done, overdue: Number(r.overdue || 0) };
}

export async function clearDone(userId) {
  const r = await db.run(sql`DELETE FROM tasks WHERE user_id = ${userId} AND done = 1`);
  return r.rowsAffected;
}

// Case-insensitive for Latin letters (lower() is ASCII-only in SQLite; Persian has no case).
export async function countSearch(userId, query) {
  const r = await db.get(sql`
    SELECT count(*) AS n FROM tasks WHERE user_id = ${userId} AND instr(lower(text), lower(${query})) > 0`);
  return Number((r && r.n) || 0);
}

export async function searchTasks(userId, query, page) {
  const rows = await db.all(sql`
    SELECT * FROM tasks WHERE user_id = ${userId} AND instr(lower(text), lower(${query})) > 0
    ORDER BY done ASC, priority ASC, id DESC LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`);
  return rows.map(taskRow);
}

// ---------- categories ----------

/** The user's categories with their number of open tasks. */
export async function listCategories(userId) {
  const rows = await db.all(sql`
    SELECT c.id, c.name,
           (SELECT count(*) FROM tasks t WHERE t.user_id = c.user_id AND t.category_id = c.id AND t.done = 0) AS open
    FROM categories c WHERE c.user_id = ${userId}
    ORDER BY c.name LIMIT ${MAX_CATEGORIES}`);
  return rows.map((r) => ({ id: Number(r.id), name: r.name, open: Number(r.open || 0) }));
}

export async function getCategory(userId, categoryId) {
  const r = await db.get(sql`SELECT id, name FROM categories WHERE id = ${categoryId} AND user_id = ${userId}`);
  return r ? { id: Number(r.id), name: r.name } : null;
}

export async function countCategories(userId) {
  const r = await db.get(sql`SELECT count(*) AS n FROM categories WHERE user_id = ${userId}`);
  return Number((r && r.n) || 0);
}

/** Creates a category; returns { id, created } (created = false when the name already existed). */
export async function addCategory(userId, name) {
  const r = await db.run(sql`
    INSERT OR IGNORE INTO categories (user_id, name, created_at) VALUES (${userId}, ${name}, ${nowSec()})`);
  const row = await db.get(sql`SELECT id FROM categories WHERE user_id = ${userId} AND name = ${name}`);
  return { id: Number(row.id), created: r.rowsAffected > 0 };
}

/** Deletes a category; its tasks are kept and become uncategorized (children first, no FKs). */
export async function deleteCategory(userId, categoryId) {
  await db.run(sql`UPDATE tasks SET category_id = NULL WHERE user_id = ${userId} AND category_id = ${categoryId}`);
  const r = await db.run(sql`DELETE FROM categories WHERE id = ${categoryId} AND user_id = ${userId}`);
  return r.rowsAffected > 0;
}

// ---------- broadcasts ----------

function broadcastRow(r) {
  return {
    id: Number(r.id),
    fromChat: Number(r.from_chat),
    messageId: Number(r.message_id),
    status: r.status,
    total: Number(r.total || 0),
    lastUser: Number(r.last_user || 0),
    sent: Number(r.sent || 0),
    failed: Number(r.failed || 0),
  };
}

/** The newest broadcast. Only the newest one can still be a draft or running. */
export async function latestBroadcast() {
  const r = await db.get(sql`SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1`);
  return r ? broadcastRow(r) : null;
}

export async function getBroadcast(id) {
  const r = await db.get(sql`SELECT * FROM broadcasts WHERE id = ${id}`);
  return r ? broadcastRow(r) : null;
}

/** Creates a draft (stopping any previous unfinished one) and returns its id. */
export async function createBroadcast(fromChat, messageId, total) {
  const prev = await latestBroadcast();
  if (prev && (prev.status === 'draft' || prev.status === 'running')) {
    await db.run(sql`UPDATE broadcasts SET status = 'stopped', locked_until = 0 WHERE id = ${prev.id}`);
  }
  const r = await db.run(sql`
    INSERT INTO broadcasts (from_chat, message_id, status, total, last_user, sent, failed, locked_until, created_at)
    VALUES (${fromChat}, ${messageId}, 'draft', ${total}, 0, 0, 0, 0, ${nowSec()})
    RETURNING id`);
  return Number(r.rows[0].id);
}

export async function startBroadcast(id) {
  const r = await db.run(sql`UPDATE broadcasts SET status = 'running' WHERE id = ${id} AND status = 'draft'`);
  return r.rowsAffected > 0;
}

export async function stopBroadcast(id) {
  const r = await db.run(sql`
    UPDATE broadcasts SET status = 'stopped', locked_until = 0 WHERE id = ${id} AND status IN ('draft', 'running')`);
  return r.rowsAffected > 0;
}

/** Claims the next batch, so a double tap can't send it twice; false while another batch is going out. */
export async function lockBroadcast(id) {
  const now = nowSec();
  const r = await db.run(sql`
    UPDATE broadcasts SET locked_until = ${now + 120}
    WHERE id = ${id} AND status = 'running' AND locked_until < ${now}`);
  return r.rowsAffected > 0;
}

export async function saveBroadcastProgress(id, { lastUser, sent, failed, done }) {
  await db.run(sql`
    UPDATE broadcasts
    SET last_user = ${lastUser}, sent = ${sent}, failed = ${failed}, locked_until = 0,
        status = CASE WHEN ${done ? 1 : 0} = 1 AND status = 'running' THEN 'done' ELSE status END
    WHERE id = ${id}`);
}

/** Users with an id above `afterId`, in id order (a primary-key range: reads only these rows). */
export async function usersAfter(afterId, limit) {
  const rows = await db.all(sql`SELECT id FROM users WHERE id > ${afterId} ORDER BY id LIMIT ${limit}`);
  return rows.map((r) => Number(r.id));
}
