/*
 * Phase 5: stats in the admin panel (the owner and admins; not moderators).
 *   a:ss            overview: users, memes, uploads, searches (+ no-result share), sends, likes
 *   a:sq:<7|30>     the most searched queries of the last 7 / 30 days
 *   a:sm:<7|30>     the searches that found nothing — the memes people want and the bot lacks;
 *                   each has a 🔎 button to try it
 * How a search is counted (once per typed query, not per keystroke): lib/statsstore.js.
 */
import { STATS_TOP } from './config.js';
import { num, t } from './i18n.js';
import * as stats from './statsstore.js';
import { edit, send } from './tg.js';
import { cut, iso, tehranDay } from './util.js';

const back = (lang) => [{ text: t(lang, 'adm.back'), callback_data: 'a:p' }];
const pct = (part, whole) => (whole ? Math.round((100 * part) / whole) : 0);

async function show(ctx, view, messageId, text, kb) {
  if (messageId && (await edit(ctx, view, messageId, text, kb))) return;
  await send(ctx, view, text, kb);
}

export async function showOverview(ctx, nowSec, messageId = null) {
  const today = tehranDay(nowSec);
  const u = await stats.userCounts(nowSec);
  const m = await stats.memeCounts();
  const d1 = await stats.sumsSince(today);
  const d7 = await stats.sumsSince(today - 6);
  const d30 = await stats.sumsSince(today - 29);
  const text = t(ctx.lang, 'st.overview', {
    users: u.total, new1: u.new1, new7: u.new7, active7: u.active7, blocked: u.blocked, banned: u.banned,
    public: m.approved, pending: m.pending, private: m.private, removed: m.rejected + m.hidden,
    up1: d1.upload, up7: d7.upload, up30: d30.upload,
    s1: d1.search, s7: d7.search, s30: d30.search, miss7: pct(d7.search_miss, d7.search),
    send7: d7.send, like7: d7.like,
  });
  const kb = [
    [{ text: t(ctx.lang, 'st.top_btn'), callback_data: 'a:sq:7' }, { text: t(ctx.lang, 'st.misses_btn'), callback_data: 'a:sm:7' }],
    [{ text: t(ctx.lang, 'st.refresh'), callback_data: 'a:ss' }],
    back(ctx.lang),
  ];
  await show(ctx, 'stats', messageId, text, kb);
}

/* misses = only the searches that found nothing. */
export async function showQueries(ctx, misses, days, nowSec, messageId = null) {
  const d = days === 30 ? 30 : 7;
  const rows = await stats.topQueries(tehranDay(nowSec) - (d - 1), STATS_TOP, misses);
  const lines = rows.map((r, i) => `${num(ctx.lang, i + 1)}. ${iso(cut(r.q, 40))} — ${num(ctx.lang, r.n)}${!misses && r.miss ? ` (😕 ${num(ctx.lang, r.miss)})` : ''}`);
  const text = [
    t(ctx.lang, misses ? 'st.misses' : 'st.top', { n: d }),
    '',
    ...(lines.length ? lines : [t(ctx.lang, 'st.none')]),
    ...(misses && lines.length ? ['', t(ctx.lang, 'st.misses_hint')] : []),
  ].join('\n');
  const code = misses ? 'sm' : 'sq';
  const kb = [];
  if (misses) {
    const tries = rows.slice(0, 6).map((r) => ({ text: `🔎 ${cut(r.q, 20)}`, switch_inline_query_current_chat: r.q }));
    for (let i = 0; i < tries.length; i += 2) kb.push(tries.slice(i, i + 2));
  }
  kb.push([
    { text: `${d === 7 ? '• ' : ''}${t(ctx.lang, 'st.d7')}`, callback_data: `a:${code}:7` },
    { text: `${d === 30 ? '• ' : ''}${t(ctx.lang, 'st.d30')}`, callback_data: `a:${code}:30` },
  ]);
  kb.push([{ text: t(ctx.lang, 'st.back'), callback_data: 'a:ss' }]);
  await show(ctx, misses ? 'stats.misses' : 'stats.top', messageId, text, kb);
}
