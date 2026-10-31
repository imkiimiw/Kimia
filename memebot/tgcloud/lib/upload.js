/*
 * Upload flow (private chat): the user sends a meme → the bot checks duplicates and the daily
 * limit and asks for keywords (users.state = 'kw', the media's ids in state_data) → the user
 * writes keywords → the meme is saved, backed up to the channel, and the user gets a "try it"
 * button. One pending meme per user; a new one replaces it. Albums are refused.
 */
import { DAILY_UPLOADS, KW_MAX_CHARS, PENDING_TTL } from './config.js';
import { backupMeme } from './backup.js';
import { botUsername } from './bot.js';
import { t } from './i18n.js';
import { cleanKeywords, firstWord, indexWords } from './normalize.js';
import * as store from './store.js';
import { editKeyboard, send } from './tg.js';
import { charCount, esc, iso, parseJson, tehranDay } from './util.js';

export const STATE_KEYWORDS = 'kw';

function largestPhoto(sizes) {
  let best = sizes[0];
  for (const s of sizes) if ((s.width || 0) * (s.height || 0) >= (best.width || 0) * (best.height || 0)) best = s;
  return best;
}

/* The meme in a message, or null: { kind, fileId, fileUniqueId }. */
export function mediaOf(msg) {
  let kind = null;
  let file = null;
  if (msg.animation) [kind, file] = ['animation', msg.animation];
  else if (Array.isArray(msg.photo) && msg.photo.length) [kind, file] = ['photo', largestPhoto(msg.photo)];
  else if (msg.video) [kind, file] = ['video', msg.video];
  else if (msg.sticker) [kind, file] = ['sticker', msg.sticker];
  else if (msg.voice) [kind, file] = ['voice', msg.voice];
  if (!file || !file.file_id || !file.file_unique_id) return null;
  return { kind, fileId: file.file_id, fileUniqueId: file.file_unique_id };
}

/* Links, @usernames and e-mails are refused in keywords (they'd be advertising in inline results). */
const LINK_RE = /(https?:\/\/|www\.|t\.me\/|telegram\.(me|dog)\/|tg:\/\/|@[a-z0-9_]{4,})/i;
const LINK_ENTITIES = ['url', 'text_link', 'mention', 'text_mention', 'email'];

function hasLink(msg) {
  return LINK_RE.test(msg.text || '') || (msg.entities || []).some((e) => LINK_ENTITIES.includes(e.type));
}

const dailyMax = (owner) => (owner ? 1e9 : DAILY_UPLOADS);

async function sayDuplicate(ctx, user, dup, replyTo) {
  const key = dup.uploader_id === user.id ? 'upload.dup_own' : 'upload.dup';
  await send(ctx, 'upload.dup', t(ctx.lang, key, { kw: iso(dup.keywords) }), null, { replyTo });
}

/* A meme arrived. */
export async function onMedia(ctx, user, msg, owner, nowSec) {
  if (msg.media_group_id) {
    if (await store.claimAlbum(user.id, msg.media_group_id)) await send(ctx, 'upload.album', t(ctx.lang, 'upload.album'));
    return;
  }
  const media = mediaOf(msg);
  const dup = await store.memeByUniqueId(media.fileUniqueId);
  if (dup) return sayDuplicate(ctx, user, dup, msg.message_id);
  if (user.up_day === tehranDay(nowSec) && user.up_count >= dailyMax(owner)) {
    await send(ctx, 'upload.limit', t(ctx.lang, 'upload.limit', { limit: DAILY_UPLOADS }));
    return;
  }
  const replaced = user.state === STATE_KEYWORDS && nowSec - user.state_at < PENDING_TTL;
  const text = (replaced ? t(ctx.lang, 'upload.replaced') + '\n\n' : '') + t(ctx.lang, 'upload.ask');
  const kb = [[{ text: t(ctx.lang, 'upload.cancel_btn'), callback_data: `up:x:${msg.message_id}` }]];
  const ask = await send(ctx, 'upload.ask', text, kb, { replyTo: msg.message_id });
  await store.setState(user.id, STATE_KEYWORDS, {
    kind: media.kind,
    fileId: media.fileId,
    fileUniqueId: media.fileUniqueId,
    msgId: msg.message_id,
    askId: ask ? ask.message_id : 0,
  }, nowSec);
}

/* Text while a meme waits for keywords. */
export async function onKeywords(ctx, user, msg, owner, nowSec) {
  const p = parseJson(user.state_data);
  if (!p || nowSec - user.state_at >= PENDING_TTL) {
    await store.clearState(user.id);
    await send(ctx, 'upload.expired', t(ctx.lang, 'upload.expired'));
    return;
  }
  if (hasLink(msg)) return void (await send(ctx, 'kw.links', t(ctx.lang, 'kw.links')));
  const keywords = cleanKeywords(msg.text);
  if (charCount(keywords) > KW_MAX_CHARS) return void (await send(ctx, 'kw.long', t(ctx.lang, 'kw.long', { max: KW_MAX_CHARS })));
  const words = indexWords(keywords);
  if (!words.length) return void (await send(ctx, 'kw.empty', t(ctx.lang, 'kw.empty')));

  await store.clearState(user.id);
  if (p.askId) await editKeyboard(ctx, 'upload.ask.done', p.askId, null);
  const day = tehranDay(nowSec);
  const used = await store.consumeUpload(user.id, day, dailyMax(owner));
  if (used === null) return void (await send(ctx, 'upload.limit', t(ctx.lang, 'upload.limit', { limit: DAILY_UPLOADS })));
  const id = await store.insertMeme({ fileId: p.fileId, fileUniqueId: p.fileUniqueId, kind: p.kind, keywords, uploaderId: user.id, words, t: nowSec });
  if (!id) {
    await store.refundUpload(user.id, day);
    const dup = await store.memeByUniqueId(p.fileUniqueId);
    if (dup) await sayDuplicate(ctx, user, dup, p.msgId);
    return;
  }
  await backupMeme(ctx, { id, kind: p.kind, file_id: p.fileId }, user.id, p.msgId, nowSec);

  const bot = await botUsername(ctx, nowSec);
  const q = firstWord(keywords);
  const text = t(ctx.lang, 'upload.saved', { kw: iso(keywords), bot: esc(bot), q: esc(q), used, limit: owner ? '∞' : DAILY_UPLOADS });
  await send(ctx, 'upload.saved', text, [[{ text: t(ctx.lang, 'upload.try_btn'), switch_inline_query_current_chat: q }]], { replyTo: p.msgId });
}

/* /cancel or the cancel button (msgId = the media message the button belongs to, if any). */
export async function cancel(ctx, user, msgId = null) {
  const p = user.state === STATE_KEYWORDS ? parseJson(user.state_data) : null;
  if (!p || (msgId !== null && p.msgId !== msgId)) return false;
  await store.clearState(user.id);
  return true;
}
