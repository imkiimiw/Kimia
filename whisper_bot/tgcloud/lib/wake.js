// The bot wakes itself up. The platform has no scheduler, and Telegram doesn't tell a bot when one
// of its polls closes by itself (tested on the platform: a poll with open_period, kept or deleted,
// brought no update in minutes) — but when the bot stops one of its polls with stopPoll, Telegram
// sends it a `poll` update at once, and that is a fresh run of the bot. So long work goes in steps:
// a step that leaves work behind calls wakeSoon(), which sends a tiny silent poll to the wake chat,
// stops it and deletes it; Telegram then runs the bot again (handlers/poll.js → isOurWake) for the
// next step. Work due at a time starts on the first update after that time (lib/maint.js).
//
// The wake chat is the owner's private chat, or a private channel the owner picks in the panel
// (/admin → ⏱), so nothing shows in their chat. At most one wake is pending at a time (kv
// wake_poll), and WAKE_MAX_PER_HOUR caps a runaway loop: past it, work goes on with other updates.
// An outside clock can also tick: a post in the wake channel (say, by a helper bot that a cron
// service tells to post there) runs the due work too (isTickPost).
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { OWNER_ID, WAKE_MAX_PER_HOUR, WAKE_STALE_SEC } from './config.js';
import { getKv, setKv } from './store.js';
import { call, describeError } from './tg.js';
import { nowSec } from './util.js';

const WAKE_KEYS = ['wake_chat', 'wake_chat_title', 'wake_last', 'wake_rate', 'tick_last'];

/** Claims the right to send the next wake: false while one is on its way (and not stale). */
async function claimWake(now) {
  const r = await db.run(sql`
    INSERT INTO kv (key, value) VALUES ('wake_poll', ${`claim@${now}`})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE kv.value IS NULL OR kv.value = ''
      OR CAST(substr(kv.value, instr(kv.value, '@') + 1) AS INTEGER) <= ${now - WAKE_STALE_SEC}`);
  return r.rowsAffected > 0;
}

/** Counts this wake against the hourly cap ("<hour>:<n>"); false once the cap is reached. */
async function underCap(now) {
  const h = String(Math.floor(now / 3600));
  const r = await db.run(sql`
    INSERT INTO kv (key, value) VALUES ('wake_rate', ${`${h}:1`})
    ON CONFLICT(key) DO UPDATE SET value = CASE
      WHEN substr(kv.value, 1, instr(kv.value, ':') - 1) = ${h}
        THEN ${h} || ':' || (CAST(substr(kv.value, instr(kv.value, ':') + 1) AS INTEGER) + 1)
      ELSE ${`${h}:1`} END
    RETURNING value`);
  const value = String((r.rows && r.rows[0] && r.rows[0].value) || '');
  return Number(value.split(':')[1] || 0) <= WAKE_MAX_PER_HOUR;
}

export function wakeChatOf(kv) {
  return Number(kv && kv.wake_chat) || OWNER_ID;
}

/**
 * Asks Telegram to run the bot again in a moment. Returns true if a wake is on its way; false if one
 * already was, the hourly cap is reached, or the wake chat refused the poll (the work then goes on
 * with the next update). Never throws.
 */
export async function wakeSoon(ctx, reason) {
  const now = nowSec();
  try {
    if (!(await claimWake(now))) return false;
    if (!(await underCap(now))) {
      await setKv('wake_poll', '');
      return false;
    }
    const chatId = wakeChatOf(await getKv(['wake_chat']));
    const m = await call(ctx, 'sendPoll', {
      chat_id: chatId,
      question: '⏱',
      options: [{ text: '·' }, { text: '··' }],
      is_anonymous: true,
      disable_notification: true,
    }, 'wake');
    // Recorded before the stop: the update the stop sends may arrive while this run goes on.
    await setKv('wake_poll', `${m.poll.id}@${now}`);
    await call(ctx, 'stopPoll', { chat_id: chatId, message_id: m.message_id }, 'wake');
    try {
      await call(ctx, 'deleteMessage', { chat_id: chatId, message_id: m.message_id }, 'wake');
    } catch (err) {
      // stays in the wake chat; harmless
    }
    ctx.woke = reason;
    return true;
  } catch (err) {
    console.warn(`wake (${reason}) failed: ${describeError(err)}`);
    await setKv('wake_poll', '').catch(() => {});
    return false;
  }
}

/** True for the `poll` update of our own pending wake (once: a repeat delivery finds it cleared). */
export async function isOurWake(poll) {
  if (!poll || !poll.id || !poll.is_closed) return false;
  const id = `${poll.id}@`;
  const r = await db.run(sql`
    UPDATE kv SET value = '' WHERE key = 'wake_poll' AND substr(value, 1, ${id.length}) = ${id}`);
  if (!r.rowsAffected) return false;
  await setKv('wake_last', nowSec());
  return true;
}

/** True for a post that ticks the outside clock: text in the wake channel (not our own polls). */
export async function isTickPost(post) {
  if (!post || !post.chat || post.poll) return false;
  const kv = await getKv(['wake_chat']);
  if (!kv.wake_chat || Number(post.chat.id) !== Number(kv.wake_chat)) return false;
  await setKv('tick_last', nowSec());
  return true;
}

/** For the owner's panel: where the wakes go and when the last ones ran. */
export async function wakeStatus() {
  const kv = await getKv(WAKE_KEYS);
  const now = nowSec();
  const [hour, n] = String(kv.wake_rate || '').split(':');
  return {
    chatId: kv.wake_chat ? Number(kv.wake_chat) : null,
    chatTitle: kv.wake_chat_title || null,
    lastWake: Number(kv.wake_last || 0),
    lastTick: Number(kv.tick_last || 0),
    thisHour: Number(hour) === Math.floor(now / 3600) ? Number(n || 0) : 0,
    cap: WAKE_MAX_PER_HOUR,
  };
}

export async function setWakeChat(chatId, title) {
  await setKv('wake_chat', chatId == null ? null : String(chatId));
  await setKv('wake_chat_title', chatId == null ? null : String(title || '').slice(0, 64));
}
