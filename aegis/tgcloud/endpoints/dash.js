/*
 * The statistics dashboard Mini App (webapp/dash.html, opened from a group's 📊 Statistics in the
 * panel): { chat } gives the page its texts and 30 days of numbers. Only for someone Telegram's init
 * data names (verified by the platform) who is an admin of that group with at least View access —
 * checked live, like every panel screen. Groups only (a channel has its own analytics).
 */
import { EndpointError } from 'sdk';
import * as errors from '../lib/core/errors.js';
import { createCtx } from '../lib/core/tg.js';
import { isoMinute, nowSec, toInt } from '../lib/core/util.js';
import * as admins from '../lib/engines/admins.js';
import * as chats from '../lib/engines/chats.js';
import * as punish from '../lib/engines/punish.js';
import { stats } from '../lib/engines/social.js';
import * as users from '../lib/engines/users.js';
import { isRtl, pickLang, t } from '../lib/i18n/index.js';

const plain = (s) => String(s).replace(/[\u200F\u2068\u2069]/g, '').replace(/<[^>]+>/g, '');
const WORDS = ['title', 'messages', 'active', 'members', 'hours', 'top', 'punish', 'today', 'd7', 'd30', 'count', 'joins', 'leaves', 'none', 'note', 'close',
  'k_warn', 'k_mute', 'k_restrict', 'k_quarantine', 'k_kick', 'k_ban', 'k_blacklist', 'k_demote'];

export default async function (input, pctx) {
  const init = (pctx && pctx.initData) || {};
  const user = init.user;
  if (!user) throw new EndpointError('No user', { code: 'NO_USER' });
  const u = await users.get(user.id);
  const lang = u && Number(u.lang_set) ? u.lang : pickLang(user.language_code);
  const c = toInt(input && input.chat);
  const chat = c ? await chats.get(c) : null;
  if (!chat || !Number(chat.active) || chat.type === 'channel') throw new EndpointError(plain(t(lang, 'chat.gone')), { code: 'GONE' });
  const ctx = createCtx({ kind: 'endpoint' });
  try {
    const acc = await admins.liveAccess(ctx, c, user.id);
    if (!acc.member || acc.level < admins.L.view) throw new EndpointError(plain(t(lang, 'soc.dbd_no_access')), { code: 'NO_ACCESS' });
    const now = nowSec();
    const days = (await stats.days(c, 30, now)).map((d) => ({ day: isoMinute(Number(d.day) * 86400).slice(0, 10), messages: Number(d.messages), active: Number(d.active),
      joins: Number(d.joins), leaves: Number(d.leaves) })).reverse();
    const hours = new Array(24).fill(0);
    for (const h of await stats.hours(c)) if (Number(h.hour) >= 0 && Number(h.hour) < 24) hours[Number(h.hour)] = Number(h.messages);
    const top = [];
    for (const r of await stats.top(c, 'messages', 10)) top.push({ name: plain(await users.displayName(Number(r.user_id))).slice(0, 40), messages: Number(r.messages) });
    const sum = async (n) => ({ ...(await stats.sum(c, n, now)), writers: await stats.activeSince(c, n, now) });
    return {
      lang, rtl: isRtl(lang), title: plain(chat.title || ''), members: Number(chat.member_count) || 0,
      totals: { d1: await sum(1), d7: await sum(7), d30: await sum(30) },
      days, hours, top, punish: await punish.kindCounts(c, now - 30 * 86400),
      text: Object.fromEntries(WORDS.map((w) => [w, plain(t(lang, `soc.dbd_${w}`))])),
    };
  } catch (err) {
    if (err instanceof EndpointError) throw err;
    await errors.record(ctx, err, { source: 'endpoint.dash', userId: user.id, chatId: c });
    throw err;
  }
}
