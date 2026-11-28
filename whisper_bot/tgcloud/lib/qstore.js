// Database access for channel question boxes (lib/qbox.js). Like lib/store.js: every query is
// index-backed and LIMITed; status changes are compare-and-set. The asker's id (from_id) is kept for
// the limits and for blocking only — no query here returns it to a screen.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { MAX_QBOXES } from './config.js';
import { bump, num } from './store.js';
import { nowSec, randomId } from './util.js';

const B_COLS = sql`id, owner_id, chat_id, title, username, code, open, asked, answered, lang, created_at`;
const Q_COLS = sql`id, box_id, from_id, body, status, answer, channel_msg, created_at, answered_at`;

function toBox(r) {
  if (!r) return null;
  return {
    id: num(r.id),
    ownerId: Number(r.owner_id),
    chatId: Number(r.chat_id),
    title: r.title || '',
    username: r.username || '',
    code: r.code,
    open: num(r.open) === 1,
    asked: num(r.asked),
    answered: num(r.answered),
    lang: r.lang || 'fa',
    createdAt: num(r.created_at),
  };
}

function toQuestion(r) {
  if (!r) return null;
  return {
    id: num(r.id),
    boxId: num(r.box_id),
    fromId: Number(r.from_id),
    body: r.body || '',
    status: r.status,
    answer: r.answer || '',
    channelMsg: r.channel_msg == null ? null : num(r.channel_msg),
    createdAt: num(r.created_at),
    answeredAt: num(r.answered_at),
  };
}

const isPositive = (id) => Number.isInteger(Number(id)) && Number(id) > 0;

/** { box } | 'full' (this person has MAX_QBOXES) | 'dup' (the channel has a box already). */
export async function createBox({ ownerId, chatId, title, username, lang }) {
  const mine = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM qboxes WHERE owner_id = ${ownerId} LIMIT ${MAX_QBOXES})`);
  if (num(mine && mine.n) >= MAX_QBOXES) return 'full';
  const r = await db.run(sql`
    INSERT INTO qboxes (owner_id, chat_id, title, username, code, open, lang, created_at)
    VALUES (${ownerId}, ${chatId}, ${title || null}, ${username || null}, ${randomId(10)}, 1, ${lang}, ${nowSec()})
    ON CONFLICT(chat_id) DO NOTHING
    RETURNING ${B_COLS}`);
  const row = r.rows && r.rows[0];
  return row ? { box: toBox(row) } : 'dup';
}

export async function getBox(id) {
  return isPositive(id) ? toBox(await db.get(sql`SELECT ${B_COLS} FROM qboxes WHERE id = ${Number(id)}`)) : null;
}

export async function getBoxByCode(code) {
  return toBox(await db.get(sql`SELECT ${B_COLS} FROM qboxes WHERE code = ${String(code)}`));
}

export async function getBoxByChat(chatId) {
  return toBox(await db.get(sql`SELECT ${B_COLS} FROM qboxes WHERE chat_id = ${Number(chatId)}`));
}

export async function listBoxes(ownerId) {
  const rows = await db.all(sql`SELECT ${B_COLS} FROM qboxes WHERE owner_id = ${ownerId} ORDER BY id LIMIT ${MAX_QBOXES}`);
  return rows.map(toBox);
}

export async function setBoxOpen(id, open) {
  await db.run(sql`UPDATE qboxes SET open = ${open ? 1 : 0} WHERE id = ${id}`);
}

/** A new link: the old one stops working at once. */
export async function renewBoxCode(id) {
  const code = randomId(10);
  await db.run(sql`UPDATE qboxes SET code = ${code} WHERE id = ${id}`);
  return code;
}

/** The box and its questions (up to 5000 of them: a box rarely has more). */
export async function deleteBox(id) {
  for (let i = 0; i < 5; i += 1) {
    const r = await db.run(sql`
      DELETE FROM qbox_questions WHERE id IN (SELECT id FROM qbox_questions WHERE box_id = ${id} LIMIT 1000)`);
    if (r.rowsAffected < 1000) break;
  }
  await db.run(sql`DELETE FROM qboxes WHERE id = ${id}`);
  await db.run(sql`DELETE FROM kv WHERE key = ${`qbn:${id}`}`);
}

/** Stores a question; a filtered one ('filtered') stays out of the owner's list and counts. */
export async function addQuestion(boxId, fromId, body, status = 'new') {
  const r = await db.run(sql`
    INSERT INTO qbox_questions (box_id, from_id, body, status, created_at)
    VALUES (${boxId}, ${fromId}, ${body}, ${status}, ${nowSec()})
    RETURNING id`);
  if (status === 'new') await db.run(sql`UPDATE qboxes SET asked = asked + 1 WHERE id = ${boxId}`);
  await bump('n_qbq', 1);
  return num(r.rows && r.rows[0] && r.rows[0].id);
}

export async function getQuestion(id) {
  return isPositive(id) ? toQuestion(await db.get(sql`SELECT ${Q_COLS} FROM qbox_questions WHERE id = ${Number(id)}`)) : null;
}

/** The `offset`-th new question of a box (oldest first) and how many are new (counted up to 1000). */
export async function newQuestionAt(boxId, offset) {
  const q = toQuestion(await db.get(sql`
    SELECT ${Q_COLS} FROM qbox_questions WHERE box_id = ${boxId} AND status = 'new' ORDER BY id LIMIT 1 OFFSET ${Math.max(0, offset)}`));
  return { q, total: await countNew(boxId) };
}

export async function countNew(boxId) {
  const r = await db.get(sql`
    SELECT count(*) AS n FROM (SELECT 1 FROM qbox_questions WHERE box_id = ${boxId} AND status = 'new' LIMIT 1000)`);
  return num(r && r.n);
}

/** new → answered, once (two presses can't post it twice). */
export async function claimAnswer(id, answer) {
  const r = await db.run(sql`
    UPDATE qbox_questions SET status = 'answered', answer = ${answer}, answered_at = ${nowSec()} WHERE id = ${id} AND status = 'new'`);
  return r.rowsAffected > 0;
}

/** The post to the channel failed after the answer was claimed: back to new. */
export async function unclaimAnswer(id) {
  await db.run(sql`UPDATE qbox_questions SET status = 'new', answer = NULL, answered_at = 0 WHERE id = ${id} AND status = 'answered'`);
}

export async function setPostedAnswer(id, boxId, channelMsg) {
  await db.run(sql`UPDATE qbox_questions SET channel_msg = ${channelMsg} WHERE id = ${id}`);
  await db.run(sql`UPDATE qboxes SET answered = answered + 1 WHERE id = ${boxId}`);
}

/** new → deleted (the owner's 🗑 or 🚫), once. */
export async function dropQuestion(id) {
  const r = await db.run(sql`UPDATE qbox_questions SET status = 'deleted' WHERE id = ${id} AND status = 'new'`);
  return r.rowsAffected > 0;
}

/** This person's questions since `since`, newest first (for the limits). */
export async function recentQuestionsBy(fromId, since, limit) {
  const rows = await db.all(sql`
    SELECT box_id, created_at FROM qbox_questions WHERE from_id = ${fromId} AND created_at >= ${since}
    ORDER BY created_at DESC LIMIT ${limit}`);
  return rows.map((r) => ({ boxId: num(r.box_id), at: num(r.created_at) }));
}

/** Lazy cleanup: filtered and deleted questions older than `before`, a batch at a time. */
export async function purgeOldQuestions(before, limit) {
  let n = 0;
  for (const status of ['filtered', 'deleted']) {
    const r = await db.run(sql`
      DELETE FROM qbox_questions WHERE id IN (
        SELECT id FROM qbox_questions WHERE status = ${status} AND created_at < ${before} ORDER BY created_at LIMIT ${limit})`);
    n += r.rowsAffected;
  }
  return n;
}

/** "Delete my data": their boxes go; the questions they asked no longer lead back to them. */
export async function forgetQboxUser(userId) {
  for (const b of await listBoxes(userId)) await deleteBox(b.id);
  await db.run(sql`
    UPDATE qbox_questions SET from_id = 0 WHERE id IN (
      SELECT id FROM qbox_questions WHERE from_id = ${userId} ORDER BY created_at LIMIT 1000)`);
}
