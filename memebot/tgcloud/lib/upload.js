/*
 * Upload flow (private chat): the user sends a meme → the bot checks duplicates and the daily
 * limit and asks for keywords (users.state = 'kw', the media's ids in state_data) → the user
 * writes keywords → the meme is saved, backed up to the channel, and the user gets a "try it"
 * button. One pending meme per user; a new one replaces it. Albums are refused.
 *
 * Moderation (Phase 2): a new meme is `pending` (only its uploader sees it) unless moderation is
 * off, the uploader is an admin, or they are trusted (settings.trust admin-approved memes). Admins
 * are told about waiting memes (throttled). Sending a meme that already exists answers with its
 * state; for someone else's public meme it offers 🚩 Report (lib/review.js).
 *
 * Phase 3: "🔒 Save privately" on the keywords question (up:p:<mediaMsgId>) saves the meme to the
 * user's private collection: status private, no approval, only they see it, stored under
 * store.privateKey so it never blocks a public upload of the same file. Keywords may hold #tags.
 */
import { APPROVED, DAILY_UPLOADS, HIDDEN, KW_MAX_CHARS, PENDING, PENDING_TTL, PRIVATE, REJECTED } from './config.js';
import * as admin from './adminstore.js';
import { backupMeme } from './backup.js';
import { botUsername, notifyAdmins } from './bot.js';
import { t } from './i18n.js';
import { existingKeyboard } from './collection.js';
import { cleanKeywords, firstWord, indexWords } from './normalize.js';
import * as store from './store.js';
import { answer, editKeyboard, send } from './tg.js';
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

const dailyMax = (role) => (role ? 1e9 : DAILY_UPLOADS);

/* The meme already exists: say in what state; offer ⭐ (and 🚩 for someone else's public meme). */
async function sayDuplicate(ctx, user, dup, replyTo) {
  const kb = existingKeyboard(ctx.lang, dup, user.id, await store.isFav(user.id, dup.id));
  if (dup.uploader_id === user.id) {
    const key = dup.status === PRIVATE ? 'upload.dup_private' : 'upload.dup_own';
    const text = t(ctx.lang, key, { kw: iso(dup.keywords), status: t(ctx.lang, `status.${dup.status}`) });
    const rows = dup.status === PRIVATE ? [[{ text: t(ctx.lang, 'publish.btn'), callback_data: `mp:${dup.id}:0:0` }]] : kb;
    return send(ctx, key, text, rows, { replyTo });
  }
  if (dup.status === APPROVED) return send(ctx, 'upload.dup', t(ctx.lang, 'upload.dup', { kw: iso(dup.keywords) }), kb, { replyTo });
  const key = { [PENDING]: 'upload.dup_pending', [HIDDEN]: 'upload.dup_hidden', [REJECTED]: 'upload.dup_rejected' }[dup.status] || 'upload.dup_pending';
  return send(ctx, key, t(ctx.lang, key), null, { replyTo });
}

/* Public at once, or waiting for an admin? (also used when keywords change and when a private
   meme is published) */
export function initialStatus(user, role, settings) {
  if (!settings.moderation || role) return APPROVED;
  if (settings.trust > 0 && user.approved_n >= settings.trust) return APPROVED;
  return PENDING;
}

/* Validates keywords typed by a user (links refused, length, at least one word). Returns
   { keywords, words }, or null after telling the user what is wrong. */
export async function checkKeywords(ctx, msg) {
  const keywords = cleanKeywords(msg.text);
  const words = indexWords(keywords);
  let error = null;
  if (hasLink(msg)) error = ['kw.links'];
  else if (charCount(keywords) > KW_MAX_CHARS) error = ['kw.long', { max: KW_MAX_CHARS }];
  else if (!words.length) error = ['kw.empty'];
  if (!error) return { keywords, words };
  await send(ctx, error[0], t(ctx.lang, error[0], error[1]));
  return null;
}

const askKeyboard = (lang, msgId, priv) => [
  [{ text: t(lang, priv ? 'upload.private_on' : 'upload.private_off'), callback_data: `up:p:${msgId}` }],
  [{ text: t(lang, 'upload.cancel_btn'), callback_data: `up:x:${msgId}` }],
];

/* A meme arrived. */
export async function onMedia(ctx, user, msg, role, nowSec) {
  if (msg.media_group_id) {
    if (await store.claimAlbum(user.id, msg.media_group_id)) await send(ctx, 'upload.album', t(ctx.lang, 'upload.album'));
    return;
  }
  const media = mediaOf(msg);
  const dup = (await store.memeByUniqueId(media.fileUniqueId)) || (await store.memeByUniqueId(store.privateKey(user.id, media.fileUniqueId)));
  if (dup) return sayDuplicate(ctx, user, dup, msg.message_id);
  if (user.up_day === tehranDay(nowSec) && user.up_count >= dailyMax(role)) {
    await send(ctx, 'upload.limit', t(ctx.lang, 'upload.limit', { limit: DAILY_UPLOADS }));
    return;
  }
  const replaced = user.state === STATE_KEYWORDS && nowSec - user.state_at < PENDING_TTL;
  const text = (replaced ? t(ctx.lang, 'upload.replaced') + '\n\n' : '') + t(ctx.lang, 'upload.ask');
  const ask = await send(ctx, 'upload.ask', text, askKeyboard(ctx.lang, msg.message_id, false), { replyTo: msg.message_id });
  await store.setState(user.id, STATE_KEYWORDS, {
    kind: media.kind,
    fileId: media.fileId,
    fileUniqueId: media.fileUniqueId,
    msgId: msg.message_id,
    askId: ask ? ask.message_id : 0,
    priv: false,
  }, nowSec);
}

/* up:p:<mediaMsgId> — the "save privately" switch on the keywords question. */
export async function togglePrivate(ctx, user, msgId, askMsgId, nowSec) {
  const p = user.state === STATE_KEYWORDS ? parseJson(user.state_data) : null;
  if (!p || p.msgId !== msgId) return answer(ctx, t(ctx.lang, 'upload.expired'), true);
  p.priv = !p.priv;
  await store.setState(user.id, STATE_KEYWORDS, p, nowSec);
  await editKeyboard(ctx, 'upload.ask', askMsgId, askKeyboard(ctx.lang, msgId, p.priv));
  return answer(ctx, t(ctx.lang, p.priv ? 'upload.private_toast_on' : 'upload.private_toast_off'));
}

/* Text while a meme waits for keywords. */
export async function onKeywords(ctx, user, msg, role, settings, nowSec) {
  const p = parseJson(user.state_data);
  if (!p || nowSec - user.state_at >= PENDING_TTL) {
    await store.clearState(user.id);
    await send(ctx, 'upload.expired', t(ctx.lang, 'upload.expired'));
    return;
  }
  const kw = await checkKeywords(ctx, msg);
  if (!kw) return;
  const { keywords, words } = kw;

  await store.clearState(user.id);
  if (p.askId) await editKeyboard(ctx, 'upload.ask.done', p.askId, null);
  const day = tehranDay(nowSec);
  const used = await store.consumeUpload(user.id, day, dailyMax(role));
  if (used === null) return void (await send(ctx, 'upload.limit', t(ctx.lang, 'upload.limit', { limit: DAILY_UPLOADS })));
  const status = p.priv ? PRIVATE : initialStatus(user, role, settings);
  const key = p.priv ? store.privateKey(user.id, p.fileUniqueId) : p.fileUniqueId;
  const id = await store.insertMeme({ fileId: p.fileId, fileUniqueId: key, kind: p.kind, keywords, uploaderId: user.id, words, t: nowSec, status });
  if (!id) {
    await store.refundUpload(user.id, day);
    const dup = await store.memeByUniqueId(key);
    if (dup) await sayDuplicate(ctx, user, dup, p.msgId);
    return;
  }
  await backupMeme(ctx, { id, kind: p.kind, file_id: p.fileId }, user.id, p.msgId, nowSec);

  const bot = await botUsername(ctx, nowSec);
  const q = firstWord(keywords);
  const textKey = { [PENDING]: 'upload.saved_pending', [PRIVATE]: 'upload.saved_private' }[status] || 'upload.saved';
  const text = t(ctx.lang, textKey, { kw: iso(keywords), bot: esc(bot), q: esc(q), used, limit: role ? '∞' : DAILY_UPLOADS });
  await send(ctx, textKey, text, [[{ text: t(ctx.lang, 'upload.try_btn'), switch_inline_query_current_chat: q }]], { replyTo: p.msgId });
  if (status === PENDING) await notifyQueue(ctx, nowSec);
}

/* Tells the admins that memes wait for approval (throttled in notifyAdmins). */
export async function notifyQueue(ctx, nowSec) {
  const n = await admin.countStatus(PENDING);
  await notifyAdmins(ctx, 'queue', (lang) => [t(lang, 'notify.queue', { n }), [[{ text: t(lang, 'adm.queue_btn', { n }), callback_data: 'a:q' }]]], nowSec);
}

/* /cancel or the cancel button (msgId = the media message the button belongs to, if any). */
export async function cancel(ctx, user, msgId = null) {
  const p = user.state === STATE_KEYWORDS ? parseJson(user.state_data) : null;
  if (!p || (msgId !== null && p.msgId !== msgId)) return false;
  await store.clearState(user.id);
  return true;
}
