/*
 * "My memes": the user's own uploads, MY_PAGE per page, newest first. Tapping one sends it as a
 * card (the media itself + 🗑 Delete / 🔎 Try it); delete asks for confirmation on the card, then
 * removes the meme and refreshes the list message. Every action re-checks that the meme is the
 * caller's own (ids from callback_data are never trusted).
 *
 * Phase 3: the card also has ✏ Edit keywords (me:…; the next text message is the new keywords,
 * users.state = 'edkw'), ⭐ (lib/collection.js) and, for a private meme, 🌍 Publish (mp:…). Edited
 * keywords of a public meme go back to the approval queue unless the user is trusted or an admin.
 *
 * callback_data (≤ 64 bytes): my:<page> | mv:<id>:<page> | md / mn / mx / me / mp:<id>:<page>:<listMsgId> | ek:x
 */
import { APPROVED, FAV_MAX, KIND_ICON, MY_PAGE, PENDING, PRIVATE } from './config.js';
import { keywordsChanged, memePublished, memeRemoved } from './backup.js';
import { canSee, favButton } from './collection.js';
import { ago, num, t } from './i18n.js';
import { firstWord, withOcr } from './normalize.js';
import * as store from './store.js';
import { answer, captionable, edit, editKeyboard, remove, send, sendMeme } from './tg.js';
import { checkKeywords, initialStatus, notifyQueue } from './upload.js';
import { cut, iso, parseJson } from './util.js';

export const STATE_EDIT = 'edkw';
const EDITABLE = [APPROVED, PENDING, PRIVATE];

async function listView(ctx, userId, page) {
  const n = await store.countOwn(userId);
  if (!n) return { text: t(ctx.lang, 'my.empty'), kb: null };
  const pages = Math.ceil(n / MY_PAGE);
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = await store.listOwn(userId, MY_PAGE, p * MY_PAGE);
  const mark = { [PENDING]: '⏳ ', [PRIVATE]: '🔒 ', hidden: '🙈 ', rejected: '❌ ' };
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

function cardKeyboard(ctx, m, page, listId, starred) {
  const rows = [[
    { text: t(ctx.lang, 'my.delete_btn'), callback_data: `md:${m.id}:${page}:${listId}` },
    ...(EDITABLE.includes(m.status) ? [{ text: t(ctx.lang, 'upload.try_btn'), switch_inline_query_current_chat: firstWord(m.keywords) }] : []),
  ]];
  if (EDITABLE.includes(m.status)) rows.push([{ text: t(ctx.lang, 'edit.btn'), callback_data: `me:${m.id}:${page}:${listId}` }, favButton(ctx.lang, m.id, starred)]);
  if (m.status === PRIVATE) rows.push([{ text: t(ctx.lang, 'publish.btn'), callback_data: `mp:${m.id}:${page}:${listId}` }]);
  return rows;
}

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
    await sendMeme(ctx, 'my.card', ctx.chatId, m.kind, m.file_id, caption, cardKeyboard(ctx, m, page, listId, await store.isFav(userId, m.id)));
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
  const kb = ask ? confirmKeyboard(ctx, m, page, listId) : cardKeyboard(ctx, m, page, listId, await store.isFav(userId, m.id));
  await editKeyboard(ctx, ask ? 'my.confirm' : 'my.card', cardId, kb);
  await answer(ctx);
}

/* mx: delete, remove the card, refresh the list it came from. */
export async function doDelete(ctx, userId, id, page, listId, cardId) {
  const before = await store.memeById(id);
  if (!(await store.deleteOwnMeme(id, userId))) return void (await answer(ctx, t(ctx.lang, 'my.gone'), true));
  await memeRemoved(ctx, before);
  if (!(await remove(ctx, 'my.card.delete', cardId))) await editKeyboard(ctx, 'my.card.deleted', cardId, null);
  if (listId) await showList(ctx, userId, page, listId);
  await answer(ctx, t(ctx.lang, 'my.deleted'));
}

/* ---------- Phase 3: edit keywords, publish a private meme ---------- */

/* me:<id>:<page>:<listId> — ask for the new keywords. */
export async function startEdit(ctx, user, id, page, listId, nowSec) {
  const m = await ownMeme(ctx, user.id, id);
  if (!m) return;
  if (!EDITABLE.includes(m.status)) return answer(ctx, t(ctx.lang, 'edit.locked'), true);
  await store.setState(user.id, STATE_EDIT, { id, page, listId }, nowSec);
  await send(ctx, 'edit.ask', t(ctx.lang, 'edit.ask', { kw: iso(m.keywords) }), [[{ text: t(ctx.lang, 'upload.cancel_btn'), callback_data: 'ek:x' }]]);
  return answer(ctx);
}

/* The new keywords (text while users.state = 'edkw'). */
export async function onEditKeywords(ctx, user, msg, role, settings, nowSec) {
  const p = parseJson(user.state_data);
  const m = p ? await store.memeById(p.id) : null;
  if (!m || m.uploader_id !== user.id || !EDITABLE.includes(m.status)) {
    await store.clearState(user.id);
    return send(ctx, 'edit.locked', t(ctx.lang, 'edit.locked'));
  }
  const kw = await checkKeywords(ctx, msg);
  if (!kw) return null;
  const status = m.status === APPROVED ? initialStatus(user, role, settings) : m.status;
  await store.updateKeywords(m.id, user.id, kw.keywords, withOcr(kw.words, m.ocr), status, nowSec);
  await store.clearState(user.id);
  const backToQueue = m.status === APPROVED && status === PENDING;
  await send(ctx, 'edit.done', t(ctx.lang, backToQueue ? 'edit.done_pending' : 'edit.done', { kw: iso(kw.keywords) }));
  if (backToQueue) {
    await memeRemoved(ctx, m);
    await notifyQueue(ctx, nowSec);
  } else if (status === APPROVED) {
    await keywordsChanged(ctx, m.id, nowSec);
  }
  if (p.listId) await showList(ctx, user.id, p.page || 0, p.listId);
  return null;
}

/* ek:x — cancel editing. */
export async function cancelEdit(ctx, user, msgId) {
  if (user.state === STATE_EDIT) await store.clearState(user.id);
  await edit(ctx, 'edit.cancelled', msgId, t(ctx.lang, 'edit.cancelled'), null);
  return answer(ctx);
}

/* mp:<id>:<page>:<listId> — a private meme goes public (approval rules as for an upload). If the
   same file is public already, the user gets it as a favourite instead. */
export async function publish(ctx, user, role, id, page, listId, cardId, settings, nowSec) {
  const m = await store.memeById(id);
  if (!m || m.uploader_id !== user.id || m.status !== PRIVATE) return answer(ctx, t(ctx.lang, 'my.gone'), true);
  const status = initialStatus(user, role, settings);
  if (!(await store.publishPrivate(id, user.id, status, nowSec))) {
    const pub = await store.memeByUniqueId(store.publicKeyOf(m.file_unique_id));
    if (pub && canSee(pub, user.id)) {
      await store.addFav(user.id, pub.id, nowSec, FAV_MAX);
      return answer(ctx, t(ctx.lang, 'publish.exists'), true);
    }
    return answer(ctx, t(ctx.lang, 'my.gone'), true);
  }
  if (status === PENDING) await notifyQueue(ctx, nowSec);
  else await memePublished(ctx, id, nowSec);
  if (listId) {
    await editKeyboard(ctx, 'my.card', cardId, cardKeyboard(ctx, await store.memeById(id), page, listId, await store.isFav(user.id, id)));
    await showList(ctx, user.id, page, listId);
  } else {
    await editKeyboard(ctx, 'publish.done', cardId, null);
  }
  return answer(ctx, t(ctx.lang, status === PENDING ? 'publish.done_pending' : 'publish.done'), true);
}
