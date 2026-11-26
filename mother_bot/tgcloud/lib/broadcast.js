// Queued sending, for everything that goes to many people: the team's broadcasts, news to subscribers,
// "it works again" notices to people who asked, and club offers. There is no scheduler, so a running
// queue moves on in steps: a step that leaves people wakes the bot for the next one (lib/wake.js), and
// every other update sends a small chunk on the side (lib/maint.js).
//
// A broadcast has a list of audiences, walked one after another in user_id order:
//   m              everyone who opened the mother (and didn't block it or get banned)
//   c:<bot>        the users of a child bot, sent BY that bot with its token (lib/children.js)
//   s:<bot>:<bit>  the mother users subscribed to a bot's news who want that kind of news ('*' = all Wanger news)
//   w:<kind>:<ref> watchers (lib/incidents.js): people who asked to be told when a bot works again
//   club:<points>  club members with at least that many points
// A user reached through one audience is skipped in the others (bc_sent), so nobody gets it twice.
//
// content (JSON): { html, kb } a message the mother wrote; { copy: { chat, mid } } a team message to copy;
// { raw: { kind, text, entities, fileId, ... } } the same message in a form child bots can send.
//   403 → the user blocked that bot: marked, never retried. 429 → wait retry_after, then go on.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { BC_BATCH, BC_CHUNK, BC_LOCK_SEC, BC_PROGRESS_EVERY_SEC, WAKE_MAX_WAIT_SEC } from './config.js';
import { getBot } from './catalog.js';
import { childCall, childSendContent } from './children.js';
import { markBlocked, setKv } from './store.js';
import {
  btn, call, describeError, isApiError, send,
} from './tg.js';
import { fa, nowSec, parseJson } from './util.js';
import { wakeSoon } from './wake.js';

/** Creates a broadcast; with `start` it is running at once. Returns its id. */
export async function createBroadcast({ kind, title, content, audiences, createdBy = 0, start = true }) {
  const r = await db.run(sql`
    INSERT INTO broadcasts (kind, title, status, content, audiences, created_by, created_at)
    VALUES (${kind}, ${title || null}, ${start ? 'running' : 'draft'}, ${JSON.stringify(content)}, ${JSON.stringify(audiences)}, ${createdBy}, ${nowSec()})
    RETURNING id`);
  const id = Number(r.rows[0].id);
  if (start) await setKv('bc_on', '1');
  return id;
}

export async function getBroadcast(id) {
  const row = await db.get(sql`SELECT * FROM broadcasts WHERE id = ${Number(id)}`);
  if (!row) return null;
  return { ...row, content: parseJson(row.content, {}), audiences: parseJson(row.audiences, []) };
}

export async function startBroadcast(id) {
  const r = await db.run(sql`UPDATE broadcasts SET status = 'running', created_at = ${nowSec()} WHERE id = ${id} AND status = 'draft'`);
  if (r.rowsAffected) await setKv('bc_on', '1');
  return r.rowsAffected > 0;
}

export async function stopBroadcast(id) {
  const r = await db.run(sql`UPDATE broadcasts SET status = 'stopped', finished_at = ${nowSec()} WHERE id = ${id} AND status IN ('running', 'draft')`);
  return r.rowsAffected > 0;
}

export async function setProgressMessage(id, chat, mid) {
  await db.run(sql`UPDATE broadcasts SET progress_chat = ${chat}, progress_msg = ${mid}, progress_at = ${nowSec()} WHERE id = ${id}`);
}

export async function runningIds(limit = 3) {
  const rows = await db.all(sql`SELECT id FROM broadcasts WHERE status = 'running' ORDER BY id LIMIT ${limit}`);
  return rows.map((r) => Number(r.id));
}

const notBanned = (scopeA, scopeB, now) => sql`NOT EXISTS (SELECT 1 FROM bans bn WHERE bn.user_id = u.user_id AND bn.scope IN (${scopeA}, ${scopeB}) AND (bn.until = 0 OR bn.until > ${now}))`;

/** The next user ids of an audience after `cursor`. */
async function nextIds(audience, cursor, limit) {
  const now = nowSec();
  const [type, a, b] = String(audience).split(':');
  let rows = [];
  if (type === 'm') {
    rows = await db.all(sql`
      SELECT u.user_id FROM users u WHERE u.started = 1 AND u.blocked = 0 AND u.user_id > ${cursor} AND ${notBanned('*', 'mother', now)}
      ORDER BY u.user_id LIMIT ${limit}`);
  } else if (type === 'c') {
    rows = await db.all(sql`
      SELECT ub.user_id FROM user_bots ub WHERE ub.bot_key = ${a} AND ub.blocked = 0 AND ub.uses > 0 AND ub.user_id > ${cursor}
        AND NOT EXISTS (SELECT 1 FROM bans bn WHERE bn.user_id = ub.user_id AND bn.scope IN ('*', ${a}) AND (bn.until = 0 OR bn.until > ${now}))
      ORDER BY ub.user_id LIMIT ${limit}`);
  } else if (type === 's') {
    rows = await db.all(sql`
      SELECT ub.user_id FROM user_bots ub JOIN users u ON u.user_id = ub.user_id
      WHERE ub.bot_key = ${a} AND ub.sub = 1 AND ub.user_id > ${cursor} AND u.started = 1 AND u.blocked = 0
        AND (u.news_kinds & ${Number(b) || 15}) != 0 AND ${notBanned('*', 'mother', now)}
      ORDER BY ub.user_id LIMIT ${limit}`);
  } else if (type === 'w') {
    rows = await db.all(sql`
      SELECT w.user_id FROM watchers w JOIN users u ON u.user_id = w.user_id
      WHERE w.kind = ${a} AND w.ref = ${b} AND w.user_id > ${cursor} AND u.started = 1 AND u.blocked = 0
      ORDER BY w.user_id LIMIT ${limit}`);
  } else if (type === 'club') {
    rows = await db.all(sql`
      SELECT u.user_id FROM users u WHERE u.club = 1 AND u.started = 1 AND u.blocked = 0 AND u.points >= ${Number(a) || 0}
        AND u.user_id > ${cursor} AND ${notBanned('*', 'mother', now)}
      ORDER BY u.user_id LIMIT ${limit}`);
  }
  return rows.map((r) => Number(r.user_id));
}

const viaChild = (audience) => String(audience).startsWith('c:');

/** Sends one message of a broadcast to one user. Throws the API error. */
async function sendOne(ctx, bc, audience, uid, botCache) {
  const c = bc.content;
  if (viaChild(audience)) {
    const key = String(audience).split(':')[1];
    if (!botCache.has(key)) botCache.set(key, await getBot(key));
    const bot = botCache.get(key);
    if (!bot || !bot.token) {
      const err = new Error('no token');
      err.noToken = true;
      throw err;
    }
    if (c.raw) {
      const { changed } = await childSendContent(bot, uid, c.raw, ctx);
      if (changed) await db.run(sql`UPDATE broadcasts SET content = ${JSON.stringify(c)} WHERE id = ${bc.id}`);
    } else {
      await childCall(bot, 'sendMessage', { chat_id: uid, text: c.html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, ctx, 'child_broadcast');
    }
    return;
  }
  const markup = c.kb ? { reply_markup: { inline_keyboard: c.kb } } : {};
  if (c.copy) {
    await call(ctx, 'copyMessage', { chat_id: uid, from_chat_id: c.copy.chat, message_id: c.copy.mid, ...markup }, `bc_${bc.kind}`);
  } else {
    await call(ctx, 'sendMessage', {
      chat_id: uid, text: c.html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...markup,
    }, `bc_${bc.kind}`);
  }
}

async function lock(id) {
  const now = nowSec();
  const r = await db.run(sql`
    UPDATE broadcasts SET lock_until = ${now + BC_LOCK_SEC}
    WHERE id = ${id} AND status = 'running' AND lock_until <= ${now} AND next_at <= ${now}`);
  return r.rowsAffected > 0;
}

async function saveProgress(b) {
  await db.run(sql`
    UPDATE broadcasts SET aidx = ${b.aidx}, cursor = ${b.cursor}, sent = ${b.sent}, failed = ${b.failed},
      blocked = ${b.blocked}, skipped = ${b.skipped}, next_at = ${b.next_at}
    WHERE id = ${b.id}`);
}

/** Sends up to `limit` messages. Returns { ran, done, b }. */
export async function processBatch(ctx, id, limit) {
  if (!(await lock(id))) return { ran: false, b: await getBroadcast(id) };
  const b = await getBroadcast(id);
  const botCache = new Map();
  let left = limit;
  let done = false;
  let limited = false;
  try {
    while (left > 0 && b.aidx < b.audiences.length) {
      const audience = b.audiences[b.aidx];
      const want = left;
      const ids = await nextIds(audience, b.cursor, want);
      let skipAudience = false;
      for (const uid of ids) {
        b.cursor = uid;
        const fresh = await db.run(sql`INSERT INTO bc_sent (bc_id, user_id) VALUES (${b.id}, ${uid}) ON CONFLICT(bc_id, user_id) DO NOTHING`);
        if (!fresh.rowsAffected) {
          b.skipped += 1;
          continue;
        }
        left -= 1;
        try {
          await sendOne(ctx, b, audience, uid, botCache);
          b.sent += 1;
        } catch (err) {
          if (err && err.noToken) {
            // the bot has no token (any more): this audience can't be reached
            await db.run(sql`DELETE FROM bc_sent WHERE bc_id = ${b.id} AND user_id = ${uid}`);
            console.warn(`broadcast ${b.id}: ${audience} has no token, skipped`);
            skipAudience = true;
            break;
          }
          if (err && err.code === 429) {
            await db.run(sql`DELETE FROM bc_sent WHERE bc_id = ${b.id} AND user_id = ${uid}`);
            b.cursor = uid - 1; // retried after the wait
            b.next_at = nowSec() + Math.max(1, Number((err.parameters && err.parameters.retry_after) || 5));
            limited = true;
            break;
          }
          if (err && err.code === 403) {
            b.blocked += 1;
            if (viaChild(audience)) {
              await db.run(sql`UPDATE user_bots SET blocked = 1 WHERE user_id = ${uid} AND bot_key = ${String(audience).split(':')[1]}`);
            } else {
              await markBlocked(uid);
            }
          } else {
            b.failed += 1;
            console.warn(`broadcast ${b.id} to ${uid} failed: ${describeError(err)}`);
          }
        }
        await saveProgress(b); // after every send: a killed step never sends twice
      }
      if (limited) break;
      if (skipAudience || ids.length < want) {
        b.aidx += 1; // this audience is finished
        b.cursor = 0;
      }
      await saveProgress(b);
    }
    if (!limited && b.aidx >= b.audiences.length) done = true;
    if (done) {
      const r = await db.run(sql`UPDATE broadcasts SET status = 'done', finished_at = ${nowSec()} WHERE id = ${b.id} AND status = 'running'`);
      if (r.rowsAffected) {
        b.status = 'done';
        b.finished_at = nowSec();
      }
      await db.run(sql`DELETE FROM bc_sent WHERE bc_id = ${b.id}`);
      if (!(await runningIds(1)).length) await setKv('bc_on', null);
    }
  } finally {
    await db.run(sql`UPDATE broadcasts SET lock_until = 0 WHERE id = ${b.id}`);
  }
  return { ran: true, done, limited, b };
}

export function progressText(b) {
  const status = { running: '⏳ در حال ارسال', done: '✅ تمام شد', stopped: '⛔️ متوقف شد', draft: '📝 پیش‌نویس' }[b.status] || b.status;
  const lines = [
    `📣 <b>ارسال #${fa(b.id)}</b>${b.title ? ` — ${b.title}` : ''}`,
    `وضعیت: ${status}`,
    '',
    `✅ ارسال‌شده: ${fa(b.sent)}`,
    `⛔️ بلاک‌کرده: ${fa(b.blocked)} · ❌ ناموفق: ${fa(b.failed)}`,
  ];
  if (b.skipped) lines.push(`↩️ تکراری (از مسیر دیگری رسیده): ${fa(b.skipped)}`);
  if (b.status === 'running') lines.push(`🎯 مخاطب ${fa(Math.min(b.aidx + 1, b.audiences.length))} از ${fa(b.audiences.length)}`);
  return lines.join('\n');
}

export function progressKb(b) {
  if (b.status !== 'running') return [[btn('🏠 پنل', 'a')]];
  return [[btn('▶️ ادامه', `abcc:${b.id}`), btn('⛔️ توقف', `abcs:${b.id}`)], [btn('🏠 پنل', 'a')]];
}

async function updateProgress(ctx, b) {
  if (!b.progress_chat || !b.progress_msg) return;
  try {
    await call(ctx, 'editMessageText', {
      chat_id: b.progress_chat, message_id: b.progress_msg, text: progressText(b), parse_mode: 'HTML', reply_markup: { inline_keyboard: progressKb(b) },
    }, 'bc_progress');
  } catch (err) {
    if (!/not modified/i.test(isApiError(err) ? err.description : '')) console.warn(`bc progress: ${describeError(err)}`);
  }
  await db.run(sql`UPDATE broadcasts SET progress_at = ${nowSec()} WHERE id = ${b.id}`);
}

/** One step of a running broadcast (on the side of an update, or woken for it). Never throws. */
export async function broadcastStep(ctx, id, limit = BC_CHUNK) {
  try {
    const r = await processBatch(ctx, id, limit);
    const b = r.b;
    if (!b) return;
    if (r.ran && r.done) {
      await updateProgress(ctx, b);
      if (b.created_by && b.progress_msg) {
        await send(ctx, 'bc_report', `${progressText(b)}\n\n${b.finished_at && b.created_at ? `⏱ ${fa(Math.max(1, Math.round((b.finished_at - b.created_at) / 60)))} دقیقه` : ''}`, [[btn('🏠 پنل', 'a')]], b.created_by);
      }
      return;
    }
    if (r.ran && nowSec() - Number(b.progress_at || 0) >= BC_PROGRESS_EVERY_SEC) await updateProgress(ctx, b);
    const waitOk = !r.ran && b.status === 'running' && Number(b.next_at) - nowSec() <= WAKE_MAX_WAIT_SEC;
    if ((r.ran && !r.done) || waitOk) await wakeSoon(ctx, 'broadcast');
  } catch (err) {
    console.warn(`broadcast step failed: ${describeError(err)}`);
  }
}

/** Steps every running broadcast (woken: a full batch each). */
export async function broadcastTick(ctx, { woken = false } = {}) {
  const ids = await runningIds(3);
  if (!ids.length) {
    await setKv('bc_on', null);
    return;
  }
  for (const id of ids) await broadcastStep(ctx, id, woken ? BC_BATCH : BC_CHUNK);
}
