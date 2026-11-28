// The daily question push, for users who turned it on (🌟 سؤال روز → 🔔, users.qd_push). There is no
// scheduler, so from DAILY_QUESTION_HOUR (Tehran time) on, the first update of the day claims the day
// (kv qd_day, compare-and-set: one run starts it) and the push goes out in user-id order from the
// cursor kv qd_cursor: a small chunk on the side of a user's update, a full batch when the bot was
// woken for it — and a batch that leaves people to do wakes the bot for the next (lib/wake.js), like
// a broadcast. kv qd_lock keeps two runs from sending the same batch.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { BC_CHUNK, DAILY_BATCH, DAILY_QUESTION_HOUR } from './config.js';
import { langOf, t } from './i18n.js';
import { questionOfDay } from './qotd.js';
import {
  claimTurn, getUser, markInactive, setKv,
} from './store.js';
import {
  btn, call, describeError, inlineBtn, isApiError,
} from './tg.js';
import { esc, localDay, localHour } from './util.js';
import { wakeSoon } from './wake.js';

const LOCK_SEC = 60;

/** today's day for qd_day, once: true for the one run that moved it. */
async function claimDay(today, seen) {
  const r = seen
    ? await db.run(sql`UPDATE kv SET value = ${today} WHERE key = 'qd_day' AND value = ${seen}`)
    : await db.run(sql`INSERT INTO kv (key, value) VALUES ('qd_day', ${today}) ON CONFLICT(key) DO NOTHING`);
  return r.rowsAffected > 0;
}

async function subscribersAfter(cursor, limit) {
  const rows = await db.all(sql`
    SELECT user_id FROM users WHERE qd_push = 1 AND started = 1 AND active = 1 AND banned = 0 AND user_id > ${cursor}
    ORDER BY user_id LIMIT ${limit}`);
  return rows.map((r) => Number(r.user_id));
}

/** The question, in their language, with a way to share their link with it and to stop these. */
async function sendQuestion(ctx, id) {
  const u = await getUser(id);
  const lang = langOf(u);
  try {
    await call(ctx, 'sendMessage', {
      chat_id: id,
      text: t(lang, 'qd.push', { q: esc(questionOfDay(lang)) }),
      parse_mode: 'HTML',
      disable_notification: false,
      reply_markup: {
        inline_keyboard: [
          [btn(t(lang, 'qd.btn_use'), 'qd:d'), inlineBtn(t(lang, 'qd.btn_share'), '')],
          [btn(t(lang, 'qd.btn_stop'), 'qd:p')],
        ],
      },
    }, 'daily_question');
  } catch (err) {
    if (isApiError(err) && err.code === 403) await markInactive(id);
    else console.warn(`daily question to ${id} failed: ${describeError(err)}`);
  }
}

/** On the side of every update (not inline keystrokes); never throws. */
export async function dailyTick(ctx, kv, { woken = false } = {}) {
  try {
    if (localHour() < DAILY_QUESTION_HOUR) return;
    const today = localDay();
    let cursor = kv.qd_cursor;
    if (kv.qd_day !== today) {
      if (!(await claimDay(today, kv.qd_day || null))) return; // another run started today's
      cursor = '0';
      await setKv('qd_cursor', cursor);
    }
    if (cursor === 'done') return;
    if (!(await claimTurn('qd_lock', LOCK_SEC))) return; // a batch is being sent
    const limit = woken ? DAILY_BATCH : BC_CHUNK;
    const ids = await subscribersAfter(Number(cursor || 0), limit);
    for (const id of ids) {
      await sendQuestion(ctx, id);
      await setKv('qd_cursor', String(id)); // after every send: a killed run never sends twice
    }
    const done = ids.length < limit;
    if (done) await setKv('qd_cursor', 'done');
    await setKv('qd_lock', '0');
    if (!done) await wakeSoon(ctx, 'daily');
  } catch (err) {
    console.warn(`daily question push failed: ${describeError(err)}`);
  }
}
