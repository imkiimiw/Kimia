/*
 * Phase 3: favourites and hashtags.
 *
 * Favourites: a user stars a meme by sending or forwarding it to the bot (the "already in the bot"
 * answer carries ⭐), or from a /my or /fav card. fv:<id> toggles it; the pressed button is swapped
 * inside the message's own keyboard (callback_query.message.reply_markup), so one handler serves
 * every message that shows it. /fav lists them (fl:<page>; fo:<id>:<page> opens one as a card).
 * In inline mode: "@bot fav [words]" (lib/inline.js). At most FAV_MAX per user. A user can star
 * public memes and their own (pending or private) ones.
 *
 * /tags lists the most used public #hashtags as buttons that start an inline search.
 *
 * Likes (Phase 4): 👍 under memes sent through inline mode (if the likebtn setting is on), under
 * channel posts, and on "already in the bot" answers. lk:<id> toggles; one like per user per meme,
 * not on your own memes. The pressed button shows the new total: an inline message is edited by
 * inline_message_id, any other message by swapping the button in its keyboard (in its own chat —
 * a channel post is edited in the channel). The score is uses + 3 × likes (lib/socialstore.js).
 *
 * callback_data: fv:<id> | fl:<page> | fo:<id>:<page> | lk:<id>
 */
import { APPROVED, FAV_MAX, KIND_ICON, MY_PAGE, PENDING, PRIVATE, TAGS_TOP } from './config.js';
import { botUsername } from './bot.js';
import { num, t } from './i18n.js';
import { firstWord } from './normalize.js';
import * as social from './socialstore.js';
import { bumpDay } from './statsstore.js';
import * as store from './store.js';
import { answer, call, captionable, edit, editKeyboard, keyboard, send, sendMeme } from './tg.js';
import { cut, esc, iso } from './util.js';

/* Can this user see (and so star) this meme? */
export const canSee = (m, uid) => !!m && (m.status === APPROVED || (m.uploader_id === uid && (m.status === PENDING || m.status === PRIVATE)));

export const favButton = (lang, id, on) => ({ text: t(lang, on ? 'fav.remove_btn' : 'fav.add_btn'), callback_data: `fv:${id}` });

export const likeButton = (id, n) => ({ text: n > 0 ? `\uD83D\uDC4D ${n}` : '\uD83D\uDC4D', callback_data: `lk:${id}` });

/* The buttons under "this meme is already in the bot": ⭐, and for someone else's public meme 👍 and 🚩. */
export function existingKeyboard(lang, m, uid, starred, withReport = true) {
  const rows = [];
  if (canSee(m, uid)) rows.push([favButton(lang, m.id, starred)]);
  if (m.status === APPROVED && m.uploader_id !== uid) {
    const row = [likeButton(m.id, m.likes || 0)];
    if (withReport) row.push({ text: t(lang, 'report.btn'), callback_data: `rp:${m.id}` });
    rows.push(row);
  }
  return rows.length ? rows : null;
}

/* Replaces the button whose callback_data is `data` in a message's keyboard; null if absent. */
function swapButton(markup, data, button) {
  const rows = markup && markup.inline_keyboard;
  if (!Array.isArray(rows)) return null;
  let found = false;
  const out = rows.map((row) => row.map((b) => {
    if (b.callback_data !== data) return b;
    found = true;
    return button;
  }));
  return found ? out : null;
}

/* fv:<id> */
export async function toggleFav(ctx, user, id, cq, nowSec) {
  const m = await store.memeById(id);
  const starred = await store.isFav(user.id, id);
  if (!starred && !canSee(m, user.id)) return answer(ctx, t(ctx.lang, 'fav.gone'), true);
  if (starred) {
    await store.removeFav(user.id, id);
  } else if ((await store.addFav(user.id, id, nowSec, FAV_MAX)) === 'full') {
    return answer(ctx, t(ctx.lang, 'fav.full', { n: FAV_MAX }), true);
  }
  const kb = cq.message ? swapButton(cq.message.reply_markup, `fv:${id}`, favButton(ctx.lang, id, !starred)) : null;
  if (kb) await editKeyboard(ctx, 'fav.toggle', cq.message.message_id, kb);
  return answer(ctx, t(ctx.lang, starred ? 'fav.removed' : 'fav.added'));
}

/* lk:<id> — like / unlike (from an inline message, a channel post or the private chat). */
export async function toggleLike(ctx, user, id, cq, nowSec) {
  const m = await store.memeById(id);
  if (!m || m.status !== APPROVED) return answer(ctx, t(ctx.lang, 'like.gone'), true);
  if (m.uploader_id === user.id) return answer(ctx, t(ctx.lang, 'like.own'), true);
  const r = await social.toggleLike(user.id, id, nowSec);
  if (!r) return answer(ctx, t(ctx.lang, 'like.gone'), true);
  if (r.liked) await bumpDay('like', nowSec);
  const button = likeButton(id, r.likes);
  if (cq.inline_message_id) {
    try {
      await call(ctx, 'editMessageReplyMarkup', { inline_message_id: cq.inline_message_id, reply_markup: keyboard([[button]]) }, 'like.inline');
    } catch (err) {
      /* "message is not modified" or an old message: the like still counts */
    }
  } else if (cq.message) {
    const kb = swapButton(cq.message.reply_markup, `lk:${id}`, button);
    if (kb) await editKeyboard(ctx, 'like.toggle', cq.message.message_id, kb, cq.message.chat.id);
  }
  return answer(ctx, t(ctx.lang, r.liked ? 'like.added' : 'like.removed'));
}

/* /fav, /start fav, fl:<page> */
export async function showFavs(ctx, user, page, nowSec, messageId = null) {
  const n = await store.countFav(user.id);
  let text;
  let kb = null;
  if (!n) {
    text = t(ctx.lang, 'fav.empty', { bot: esc(await botUsername(ctx, nowSec)) });
  } else {
    const pages = Math.ceil(n / MY_PAGE);
    const p = Math.min(Math.max(0, page), pages - 1);
    const rows = await store.favList(user.id, null, MY_PAGE, p * MY_PAGE);
    kb = rows.map((m) => [{ text: `${KIND_ICON[m.kind] || ''} ${cut(m.keywords, 30)}`, callback_data: `fo:${m.id}:${p}` }]);
    const nav = [];
    if (p > 0) nav.push({ text: t(ctx.lang, 'my.prev'), callback_data: `fl:${p - 1}` });
    if (p < pages - 1) nav.push({ text: t(ctx.lang, 'my.next'), callback_data: `fl:${p + 1}` });
    if (nav.length) kb.push(nav);
    text = t(ctx.lang, 'fav.title', { n, p: p + 1, pages, bot: esc(await botUsername(ctx, nowSec)) });
  }
  if (messageId && (await edit(ctx, 'fav.list', messageId, text, kb))) return;
  await send(ctx, 'fav.list', text, kb);
}

/* fo:<id>:<page> — a favourite as a card: the meme, ⭐ toggle, 🔎 try it. */
export async function showFavCard(ctx, user, id) {
  const m = await store.memeById(id);
  if (!canSee(m, user.id)) return answer(ctx, t(ctx.lang, 'fav.gone'), true);
  const kb = [[favButton(ctx.lang, id, await store.isFav(user.id, id)), { text: t(ctx.lang, 'upload.try_btn'), switch_inline_query_current_chat: firstWord(m.keywords) }]];
  const caption = captionable(m.kind) ? t(ctx.lang, 'fav.card', { kw: iso(m.keywords) }) : null;
  try {
    await sendMeme(ctx, 'fav.card', ctx.chatId, m.kind, m.file_id, caption, kb);
  } catch (err) {
    return answer(ctx, t(ctx.lang, 'error'), true);
  }
  return answer(ctx);
}

/* /tags */
export async function showTags(ctx, nowSec) {
  const rows = await store.topTags(TAGS_TOP);
  const bot = esc(await botUsername(ctx, nowSec));
  if (!rows.length) return send(ctx, 'tags', t(ctx.lang, 'tags.empty'));
  const kb = [];
  for (let i = 0; i < rows.length; i += 2) {
    kb.push(rows.slice(i, i + 2).map((r) => ({ text: `${r.tag} · ${num(ctx.lang, r.n)}`, switch_inline_query_current_chat: r.tag })));
  }
  return send(ctx, 'tags', t(ctx.lang, 'tags.title', { bot }), kb);
}
