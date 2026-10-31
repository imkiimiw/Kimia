/*
 * Meme of the day (Phase 4), posted to ENV.motdChannelId — by default the bot's one channel,
 * @WangerChaos. There is no scheduler: the first message, button press or sent meme after
 * MOTD_HOUR Tehran time posts it (the day is recorded in kv; tries are claimed at most every
 * MOTD_RETRY seconds, so two updates never post twice). The meme: yesterday's best public meme by
 * that day's score, else the best of that week, else the best of all time — never one posted in
 * the last MOTD_NO_REPEAT days. Old counters are pruned at the same time. Off in ⚙ Settings.
 */
import { ENV } from './env.js';
import { MOTD_HOUR, MOTD_NO_REPEAT, MOTD_RETRY } from './config.js';
import * as admin from './adminstore.js';
import { alertOwner, botUsername } from './bot.js';
import { likeButton } from './collection.js';
import { date, t } from './i18n.js';
import { DEFAULT_LANG } from './locales/index.js';
import * as social from './socialstore.js';
import * as store from './store.js';
import { captionable, describeError, send, sendMeme } from './tg.js';
import { esc, iso, tehranDay, tehranHour, weekOfDay } from './util.js';

/* Returns true when it posted. */
export async function maybePostMotd(ctx, nowSec) {
  if (!ENV.motdChannelId || tehranHour(nowSec) < MOTD_HOUR) return false;
  const day = tehranDay(nowSec);
  const last = await store.kvGet('motd:day');
  if (last && last.n >= day) return false;
  if (!(await store.claimEvery('motd:try', nowSec, MOTD_RETRY))) return false;
  await social.pruneStats(nowSec);
  if (!(await admin.getSettings()).motd) {
    await store.kvSet('motd:day', 'off', day);
    return false;
  }
  const since = day - MOTD_NO_REPEAT;
  const m = (await social.pickOfDay(day - 1, since)) || (await social.pickOfWeek(weekOfDay(day - 1), since)) || (await social.pickOfAllTime(since));
  if (!m) {
    await store.kvSet('motd:day', 'none', day);
    return false;
  }
  const lang = DEFAULT_LANG;
  const bot = await botUsername(ctx, nowSec);
  const text = t(lang, 'motd.caption', { date: date(lang, day), kw: iso(m.keywords), uses: m.uses, likes: m.likes, bot: esc(bot) });
  const kb = [[likeButton(m.id, m.likes), { text: t(lang, 'motd.open'), url: `https://t.me/${bot}` }]];
  try {
    if (!captionable(m.kind)) await send(ctx, 'motd.text', text, null, { chatId: ENV.motdChannelId, rethrow: true });
    const r = await sendMeme(ctx, 'motd', ENV.motdChannelId, m.kind, m.file_id, captionable(m.kind) ? text : null, kb);
    await social.recordMotd(day, m.id, r.chat.id, r.message_id, nowSec);
    await store.kvSet('motd:day', String(m.id), day);
    return true;
  } catch (err) {
    await alertOwner(ctx, 'motd', 'owner.motd_fail', { err: esc(describeError(err)) }, nowSec);
    return false;
  }
}
