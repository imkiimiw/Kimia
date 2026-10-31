/*
 * Phase 4: profiles and the weekly leaderboard (private chat).
 *
 * /profile (m:me): the user's public memes, total uses and likes, this week's points and rank, and
 * a switch to show their name in the leaderboard as "anonymous" (pv:t).
 * /top (m:top): this week's (lb:w) or last week's (lb:l) top memes and uploaders. Weeks run
 * Saturday to Friday, Tehran time; points = uses + 3 × likes of public memes in that week. A top
 * meme opens as a card (lm:<id>: the meme, ⭐, 👍, try it); an uploader who didn't hide their name
 * opens their profile (pf:<uid>). Banned users are left out.
 */
import { APPROVED, KIND_ICON, LB_TOP, LIKE_WEIGHT } from './config.js';
import { favButton, likeButton } from './collection.js';
import { date, num, t } from './i18n.js';
import { firstWord } from './normalize.js';
import * as social from './socialstore.js';
import * as store from './store.js';
import { answer, captionable, edit, send, sendMeme } from './tg.js';
import { cut, firstDayOfWeek, iso, tehranWeek } from './util.js';

const MEDALS = ['🥇', '🥈', '🥉', '🏅', '🏅'];

async function profileText(lang, u, own, nowSec) {
  const st = await social.profileStats(u.id);
  const wr = await social.weekRank(u.id, tehranWeek(nowSec));
  const name = iso(cut(u.first_name || '—', 40));
  const lines = [
    t(lang, own ? 'profile.title_own' : 'profile.title', { name }),
    t(lang, 'profile.stats', { memes: st.memes, uses: st.uses, likes: st.likes }),
    wr.rank ? t(lang, 'profile.week', { n: wr.score, rank: wr.rank }) : t(lang, 'profile.week_none'),
  ];
  if (own) lines.push(t(lang, u.lb_hidden ? 'profile.hidden' : 'profile.visible'));
  return lines.join('\n');
}

/* /profile, m:me (messageId: edit that message instead of sending a new one). */
export async function showProfile(ctx, user, nowSec, messageId = null) {
  const text = await profileText(ctx.lang, user, true, nowSec);
  const kb = [
    [{ text: t(ctx.lang, user.lb_hidden ? 'profile.show_btn' : 'profile.hide_btn'), callback_data: 'pv:t' }],
    [{ text: t(ctx.lang, 'menu.top'), callback_data: 'lb:w' }],
  ];
  if (messageId && (await edit(ctx, 'profile', messageId, text, kb))) return;
  await send(ctx, 'profile', text, kb);
}

/* pv:t */
export async function toggleVisibility(ctx, user, messageId, nowSec) {
  user.lb_hidden = user.lb_hidden ? 0 : 1;
  await social.setLbHidden(user.id, user.lb_hidden);
  await showProfile(ctx, user, nowSec, messageId);
  return answer(ctx);
}

/* pf:<uid> — someone else's profile (from the leaderboard). */
export async function showOtherProfile(ctx, uid, nowSec) {
  const u = await store.getUser(uid);
  if (!u || u.lb_hidden || u.banned) return answer(ctx, t(ctx.lang, 'profile.private'), true);
  await send(ctx, 'profile.other', await profileText(ctx.lang, u, false, nowSec));
  return answer(ctx);
}

/* /top, m:top, lb:w | lb:l */
export async function showLeaderboard(ctx, which, nowSec, messageId = null) {
  const lang = ctx.lang;
  const week = tehranWeek(nowSec) - (which === 'l' ? 1 : 0);
  const start = firstDayOfWeek(week);
  const memes = await social.topMemes(week, LB_TOP);
  const ups = await social.topUploaders(week, LB_TOP);
  const memeLines = memes.map((m, i) => `${MEDALS[i]} ${KIND_ICON[m.kind] || ''} ${iso(cut(m.keywords, 32))} — ${t(lang, 'lb.points', { n: m.score })} (📤 ${num(lang, m.uses)} · 👍 ${num(lang, m.likes)})`);
  const upLines = ups.map((u, i) => `${MEDALS[i]} ${u.hidden ? t(lang, 'lb.anon') : iso(cut(u.first_name || '—', 24))} — ${t(lang, 'lb.points', { n: u.score })}`);
  const text = [
    t(lang, which === 'l' ? 'lb.last' : 'lb.this', { from: date(lang, start), to: date(lang, start + 6) }),
    '',
    t(lang, 'lb.memes'),
    ...(memeLines.length ? memeLines : [t(lang, 'lb.none')]),
    '',
    t(lang, 'lb.uploaders'),
    ...(upLines.length ? upLines : [t(lang, 'lb.none')]),
    '',
    t(lang, 'lb.rule', { w: LIKE_WEIGHT }),
  ].join('\n');
  const kb = [];
  if (memes.length) kb.push(memes.map((m, i) => ({ text: MEDALS[i], callback_data: `lm:${m.id}` })));
  const visible = ups.filter((u) => !u.hidden);
  for (let i = 0; i < visible.length; i += 2) {
    kb.push(visible.slice(i, i + 2).map((u) => ({ text: `👤 ${cut(u.first_name || String(u.id), 20)}`, callback_data: `pf:${u.id}` })));
  }
  kb.push([which === 'l' ? { text: t(lang, 'lb.this_btn'), callback_data: 'lb:w' } : { text: t(lang, 'lb.last_btn'), callback_data: 'lb:l' }]);
  if (messageId && (await edit(ctx, 'leaderboard', messageId, text, kb))) return;
  await send(ctx, 'leaderboard', text, kb);
}

/* lm:<id> — a public meme as a card: the meme, ⭐, 👍, try it. */
export async function showPublicCard(ctx, user, id) {
  const m = await store.memeById(id);
  if (!m || m.status !== APPROVED) return answer(ctx, t(ctx.lang, 'fav.gone'), true);
  const kb = [
    [favButton(ctx.lang, id, await store.isFav(user.id, id))],
    [likeButton(id, m.likes), { text: t(ctx.lang, 'upload.try_btn'), switch_inline_query_current_chat: firstWord(m.keywords) }],
  ];
  const caption = captionable(m.kind) ? t(ctx.lang, 'card.public', { kw: iso(m.keywords), uses: m.uses, likes: m.likes }) : null;
  try {
    await sendMeme(ctx, 'card.public', ctx.chatId, m.kind, m.file_id, caption, kb);
  } catch (err) {
    return answer(ctx, t(ctx.lang, 'error'), true);
  }
  return answer(ctx);
}
