/*
 * Entry points of the four handlers and the order of checks. Each returns { trace } (every Bot
 * API call with its view name) so `npx tgcloud run` shows what the bot did.
 *
 * message — private chats only (groups, channels and bots are ignored):
 *   1. upsert the user and count the message (anti-spam; the owner is exempt):
 *      muted → silence; over SPAM_MAX in SPAM_WINDOW → muted for SPAM_MUTE, one warning
 *   2. a command: /start [upload] /help /lang /my /cancel /upload, /setup (owner only)
 *   3. a meme (photo, animation, video, sticker, voice) → upload.onMedia
 *   4. text: a meme waits for keywords → upload.onKeywords; otherwise a hint
 *   5. other content (files, audio, round videos, …) → "unsupported"; service messages → nothing
 * callback_query — the user is ensured, muted users get an alert, then the table below; every
 *   query is answered exactly once.
 * inline_query / chosen_inline_result → lib/inline.js (no user row is created there).
 *
 * callback_data (all ≤ 64 bytes):
 *   lang:<code>[:u]                   language picked (u: show the upload help next)   lib/menu.js
 *   m:up | m:my | m:help | m:lang     main menu                                        lib/menu.js
 *   up:x:<mediaMsgId>                 cancel the pending upload of that media          lib/upload.js
 *   my:<page>                         "my memes" page (edits the list)                 lib/mine.js
 *   mv:<id>:<page>                    open a meme card                                 lib/mine.js
 *   md | mn | mx:<id>:<page>:<listId> delete? / keep / delete for real                 lib/mine.js
 */
import { SPAM_MAX, SPAM_MUTE, SPAM_WINDOW, START_UPLOAD } from './config.js';
import { isOwner } from './bot.js';
import { isLang, langOf, t } from './i18n.js';
import { onChosenResult, onInlineQuery } from './inline.js';
import { sendHelp, sendHint, sendLanguagePicker, sendUploadHow, sendWelcome } from './menu.js';
import { confirmDelete, doDelete, showCard, showList } from './mine.js';
import { setup } from './owner.js';
import * as store from './store.js';
import { answer, createCtx, edit, send } from './tg.js';
import * as upload from './upload.js';
import { now } from './util.js';

const OTHER_CONTENT = ['document', 'audio', 'video_note', 'contact', 'location', 'venue', 'poll', 'dice', 'game', 'story', 'paid_media', 'invoice'];

/* "/cmd@bot arg" → { name, arg }, or null. */
export function parseCommand(text) {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  return m ? { name: m[1].toLowerCase(), arg: (m[2] || '').trim() } : null;
}

async function onCommand(ctx, user, msg, cmd, owner, nowSec) {
  switch (cmd.name) {
    case 'start':
      if (!isLang(user.lang)) return sendLanguagePicker(ctx, cmd.arg === START_UPLOAD ? 'u' : '');
      return cmd.arg === START_UPLOAD ? sendUploadHow(ctx) : sendWelcome(ctx, msg.from, nowSec);
    case 'help':
      return sendHelp(ctx, nowSec);
    case 'lang':
      return sendLanguagePicker(ctx);
    case 'my':
      return showList(ctx, user.id, 0);
    case 'upload':
      return sendUploadHow(ctx);
    case 'cancel':
      return send(ctx, 'cancel', t(ctx.lang, (await upload.cancel(ctx, user)) ? 'cancel.done' : 'cancel.none'));
    case 'setup':
      if (owner) return setup(ctx, nowSec);
      return sendHint(ctx, '', nowSec);
    default:
      return sendHint(ctx, '', nowSec);
  }
}

export async function onMessage(msg) {
  const ctx = createCtx();
  if (!msg || !msg.from || msg.from.is_bot || !msg.chat || msg.chat.type !== 'private') return { trace: ctx.trace };
  const nowSec = now();
  const user = await store.touchUser(msg.from, nowSec, SPAM_WINDOW);
  Object.assign(ctx, { userId: user.id, chatId: msg.chat.id, lang: langOf(user, msg.from) });
  const owner = isOwner(user.id);
  if (!owner) {
    if (user.mute_until > nowSec) return { trace: ctx.trace, muted: true };
    if (user.spam_n > SPAM_MAX) {
      await store.mute(user.id, nowSec + SPAM_MUTE);
      await send(ctx, 'spam.muted', t(ctx.lang, 'spam.muted', { n: Math.round(SPAM_MUTE / 60) }));
      return { trace: ctx.trace, muted: true };
    }
  }
  const cmd = parseCommand(msg.text);
  if (cmd) await onCommand(ctx, user, msg, cmd, owner, nowSec);
  else if (upload.mediaOf(msg)) await upload.onMedia(ctx, user, msg, owner, nowSec);
  else if (typeof msg.text === 'string') {
    if (user.state === upload.STATE_KEYWORDS) await upload.onKeywords(ctx, user, msg, owner, nowSec);
    else await sendHint(ctx, msg.text, nowSec);
  } else if (OTHER_CONTENT.some((k) => msg[k] !== undefined)) {
    await send(ctx, 'upload.unsupported', t(ctx.lang, 'upload.unsupported'));
  }
  return { trace: ctx.trace };
}

const int = (s) => (/^\d{1,15}$/.test(s || '') ? Number(s) : null);

async function onButton(ctx, user, cq, nowSec) {
  const [code, a, b, c] = String(cq.data || '').split(':');
  const msgId = cq.message ? cq.message.message_id : null;
  if (!msgId) return;
  switch (code) {
    case 'lang': {
      if (!isLang(a)) return;
      await store.setLang(user.id, a);
      ctx.lang = a;
      await edit(ctx, 'lang.saved', msgId, t(a, 'lang.saved'), null);
      await answer(ctx);
      return b === 'u' ? sendUploadHow(ctx) : sendWelcome(ctx, cq.from, nowSec);
    }
    case 'm':
      await answer(ctx);
      if (a === 'up') return sendUploadHow(ctx);
      if (a === 'my') return showList(ctx, user.id, 0);
      if (a === 'help') return sendHelp(ctx, nowSec, msgId);
      if (a === 'lang') return sendLanguagePicker(ctx);
      return;
    case 'up': {
      const done = a === 'x' && (await upload.cancel(ctx, user, int(b)));
      if (done) await edit(ctx, 'cancel', msgId, t(ctx.lang, 'cancel.done'), null);
      return answer(ctx, t(ctx.lang, done ? 'cancel.done' : 'cancel.none'));
    }
    case 'my':
      await showList(ctx, user.id, int(a) || 0, msgId);
      return answer(ctx);
    case 'mv':
      if (int(a) === null) return;
      return showCard(ctx, user.id, int(a), int(b) || 0, msgId, nowSec);
    case 'md':
    case 'mn':
      if (int(a) === null) return;
      return confirmDelete(ctx, user.id, int(a), int(b) || 0, int(c) || 0, msgId, code === 'md');
    case 'mx':
      if (int(a) === null) return;
      return doDelete(ctx, user.id, int(a), int(b) || 0, int(c) || 0, msgId);
    default:
  }
}

export async function onCallback(cq) {
  const ctx = createCtx({ callbackId: cq && cq.id });
  if (!cq || !cq.from) return { trace: ctx.trace };
  const nowSec = now();
  try {
    const user = await store.ensureUser(cq.from, nowSec);
    Object.assign(ctx, { userId: user.id, chatId: cq.message ? cq.message.chat.id : cq.from.id, lang: langOf(user, cq.from) });
    if (!isOwner(user.id) && user.mute_until > nowSec) await answer(ctx, t(ctx.lang, 'spam.wait'), true);
    else await onButton(ctx, user, cq, nowSec);
  } finally {
    await answer(ctx);
  }
  return { trace: ctx.trace };
}

export async function onInline(q) {
  const ctx = createCtx();
  if (q && q.from && typeof q.id === 'string') await onInlineQuery(ctx, q);
  return { trace: ctx.trace };
}

export async function onChosen(r) {
  const ctx = createCtx();
  const counted = r ? await onChosenResult(ctx, r, now()) : false;
  return { trace: ctx.trace, counted };
}
