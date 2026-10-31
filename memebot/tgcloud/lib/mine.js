/*
 * "My memes": the user's own uploads, MY_PAGE per page, newest first. Tapping one sends it as a
 * card (the media itself + 🗑 Delete / 🔎 Try it); delete asks for confirmation on the card, then
 * removes the meme and refreshes the list message. Every action re-checks that the meme is the
 * caller's own (ids from callback_data are never trusted).
 *
 * callback_data (≤ 64 bytes): my:<page> | mv:<id>:<page> | md / mn / mx:<id>:<page>:<listMsgId>
 */
import { APPROVED, KIND_ICON, MY_PAGE, PENDING } from './config.js';
import { ago, num, t } from './i18n.js';
import { firstWord } from './normalize.js';
import * as store from './store.js';
import { answer, captionable, edit, editKeyboard, remove, send, sendMeme } from './tg.js';
import { cut, iso } from './util.js';

async function listView(ctx, userId, page) {
  const n = await store.countOwn(userId);
  if (!n) return { text: t(ctx.lang, 'my.empty'), kb: null };
  const pages = Math.ceil(n / MY_PAGE);
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = await store.listOwn(userId, MY_PAGE, p * MY_PAGE);
  const mark = { [PENDING]: '⏳ ', hidden: '🙈 ', rejected: '❌ ' };
  const kb = rows.map((m) => [{ text: `${mark[m.status] || ''}${KIND_ICON[m.kind] || ''} ${cut(m.keywords, 30)} · ${num(ctx.lang, m.uses)}`, callback_data: `mv:${m.id}:${p}` }]);
  const nav = [];
  if (p > 0) nav.push({ text: t(ctx.lang, 'my.prev'), callback_data: `my:${p - 1}` });
  if (p < pages - 1) nav.push({ text: t(ctx.lang, 'my.next'), callback_data: `my:${p + 1}` });
  if (nav.length) kb.push(nav);
  return { text: t(ctx.lang, 'my.title', { n, p: p + 1, pages }), kb };
}

/* Sends the list (or, with messageId, edits that message into it). */
export async function showList(ctx, userId, page, messageId = null) {
  const v = await listView(ctx, userId, page);
  if (messageId) await edit(ctx, 'my.list', messageId, v.text, v.kb);
  else await send(ctx, 'my.list', v.text, v.kb);
}

const cardKeyboard = (ctx, m, page, listId) => [[
  { text: t(ctx.lang, 'my.delete_btn'), callback_data: `md:${m.id}:${page}:${listId}` },
  ...(m.status === APPROVED || m.status === PENDING ? [{ text: t(ctx.lang, 'upload.try_btn'), switch_inline_query_current_chat: firstWord(m.keywords) }] : []),
]];

const confirmKeyboard = (ctx, m, page, listId) => [[
  { text: t(ctx.lang, 'my.yes'), callback_data: `mx:${m.id}:${page}:${listId}` },
  { text: t(ctx.lang, 'my.no'), callback_data: `mn:${m.id}:${page}:${listId}` },
]];

async function ownMeme(ctx, userId, id) {
  const m = await store.memeById(id);
  if (m && m.uploader_id === userId) return m;
  await answer(ctx, t(ctx.lang, 'my.gone'), true);
  return null;
}

/* mv: send the meme card. */
export async function showCard(ctx, userId, id, page, listId, nowSec) {
  const m = await ownMeme(ctx, userId, id);
  if (!m) return;
  const caption = captionable(m.kind) ? t(ctx.lang, 'my.card', { kw: iso(m.keywords), n: m.uses, ago: ago(ctx.lang, m.created_at, nowSec), status: t(ctx.lang, `status.${m.status}`) }) : null;
  try {
    await sendMeme(ctx, 'my.card', ctx.chatId, m.kind, m.file_id, caption, cardKeyboard(ctx, m, page, listId));
  } catch (err) {
    await answer(ctx, t(ctx.lang, 'error'), true);
    return;
  }
  await answer(ctx);
}

/* md / mn: ask to confirm the deletion, or go back to the card's buttons. */
export async function confirmDelete(ctx, userId, id, page, listId, cardId, ask) {
  const m = await ownMeme(ctx, userId, id);
  if (!m) return;
  await editKeyboard(ctx, ask ? 'my.confirm' : 'my.card', cardId, (ask ? confirmKeyboard : cardKeyboard)(ctx, m, page, listId));
  await answer(ctx);
}

/* mx: delete, remove the card, refresh the list it came from. */
export async function doDelete(ctx, userId, id, page, listId, cardId) {
  if (!(await store.deleteOwnMeme(id, userId))) return void (await answer(ctx, t(ctx.lang, 'my.gone'), true));
  if (!(await remove(ctx, 'my.card.delete', cardId))) await editKeyboard(ctx, 'my.card.deleted', cardId, null);
  if (listId) await showList(ctx, userId, page, listId);
  await answer(ctx, t(ctx.lang, 'my.deleted'));
}
