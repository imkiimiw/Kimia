/*
 * Entry points of the four handlers and the order of checks. Each returns { trace } (every Bot
 * API call with its view name) so `npx tgcloud run` shows what the bot did.
 *
 * message — private chats only (groups, channels and bots are ignored):
 *   1. upsert the user; role = owner | admin | null (fresh from the database)
 *   2. ordinary users: banned → one notice a day, then silence; muted → silence; over SPAM_MAX in
 *      SPAM_WINDOW → muted for SPAM_MUTE with one warning (admins are exempt from all three)
 *   3. /lang, and /start before a language is chosen, work without the join check
 *   4. forced join (lib/join.js): not a member → the lock message, nothing else
 *   5. a command: /start [upload|join] /help /lang /my /cancel /upload, /admin (admins), /setup (owner)
 *   6. an admin input in progress (users.state adm:*) → lib/admin.js / lib/broadcast.js
 *   7. a meme (photo, animation, video, sticker, voice) → upload.onMedia
 *   8. text: a meme waits for keywords → upload.onKeywords; otherwise a hint
 *   9. other content (files, audio, round videos, …) → "unsupported"; service messages → nothing
 *  10. a running broadcast sends a few more copies (lib/broadcast.js sideStep)
 * callback_query — the user is ensured; banned / muted users get an alert; "a:" buttons need a
 *   role (owner-only codes in admin.OWNER_ONLY); other buttons need the join check; every query is
 *   answered exactly once; then the broadcast side step.
 * inline_query / chosen_inline_result → lib/inline.js (no user row is created there).
 *
 * callback_data (all ≤ 64 bytes):
 *   lang:<code>[:u]                   language picked (u: show the upload help next)   lib/menu.js
 *   m:up | m:my | m:help | m:lang     main menu                                        lib/menu.js
 *   up:x:<mediaMsgId>                 cancel the pending upload of that media          lib/upload.js
 *   my:<page>                         "my memes" page (edits the list)                 lib/mine.js
 *   mv:<id>:<page>                    open a meme card                                 lib/mine.js
 *   md | mn | mx:<id>:<page>:<listId> delete? / keep / delete for real                 lib/mine.js
 *   rp:<id>[:<reason>|:x]             report a meme (reasons in config.REPORT_REASONS)  lib/review.js
 *   j:chk                             "I joined" (fresh membership check)              lib/join.js
 *   a:…                               admin panel (table in lib/admin.js, lib/review.js, lib/broadcast.js)
 *   nop                               a label button (does nothing)
 */
import { BAN_NOTICE_EVERY, SPAM_MAX, SPAM_MUTE, SPAM_WINDOW, START_UPLOAD } from './config.js';
import * as adminUi from './admin.js';
import * as adminStore from './adminstore.js';
import * as bc from './broadcast.js';
import { roleOf } from './bot.js';
import { isLang, langOf, t } from './i18n.js';
import { onChosenResult, onInlineQuery } from './inline.js';
import { checkJoin, lockKeyboard, sendLock } from './join.js';
import { sendHelp, sendHint, sendLanguagePicker, sendUploadHow, sendWelcome } from './menu.js';
import { confirmDelete, doDelete, showCard, showList } from './mine.js';
import { setup } from './owner.js';
import * as review from './review.js';
import * as store from './store.js';
import { answer, createCtx, edit, editKeyboard, send } from './tg.js';
import * as upload from './upload.js';
import { now } from './util.js';

const OTHER_CONTENT = ['document', 'audio', 'video_note', 'contact', 'location', 'venue', 'poll', 'dice', 'game', 'story', 'paid_media', 'invoice'];

/* "/cmd@bot arg" → { name, arg }, or null. */
export function parseCommand(text) {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  return m ? { name: m[1].toLowerCase(), arg: (m[2] || '').trim() } : null;
}

async function onCommand(ctx, user, msg, cmd, role, nowSec) {
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
      if (user.state && user.state.startsWith('adm:')) {
        await store.clearState(user.id);
        return send(ctx, 'cancel', t(ctx.lang, 'adm.input_cancelled'));
      }
      return send(ctx, 'cancel', t(ctx.lang, (await upload.cancel(ctx, user)) ? 'cancel.done' : 'cancel.none'));
    case 'admin':
      if (role) return adminUi.showPanel(ctx, role);
      return sendHint(ctx, '', nowSec);
    case 'setup':
      if (role === 'owner') return setup(ctx, nowSec);
      return sendHint(ctx, '', nowSec);
    default:
      return sendHint(ctx, '', nowSec);
  }
}

/* After the user checks: admin input, meme, keywords, hint, unsupported. */
async function onContent(ctx, user, msg, role, settings, nowSec) {
  if (role && user.state && user.state.startsWith('adm:')) {
    if (user.state === bc.STATE_BROADCAST && role === 'owner') return bc.onDraft(ctx, user, msg, nowSec);
    if (await adminUi.onInput(ctx, user, role, msg, nowSec)) return;
  }
  if (upload.mediaOf(msg)) return upload.onMedia(ctx, user, msg, role, nowSec);
  if (typeof msg.text === 'string') {
    if (user.state === upload.STATE_KEYWORDS) return upload.onKeywords(ctx, user, msg, role, settings, nowSec);
    return sendHint(ctx, msg.text, nowSec);
  }
  if (OTHER_CONTENT.some((k) => msg[k] !== undefined)) await send(ctx, 'upload.unsupported', t(ctx.lang, 'upload.unsupported'));
}

export async function onMessage(msg) {
  const ctx = createCtx();
  if (!msg || !msg.from || msg.from.is_bot || !msg.chat || msg.chat.type !== 'private') return { trace: ctx.trace };
  const nowSec = now();
  const user = await store.touchUser(msg.from, nowSec, SPAM_WINDOW);
  Object.assign(ctx, { userId: user.id, chatId: msg.chat.id, lang: langOf(user, msg.from) });
  const role = await roleOf(user.id);
  if (!role) {
    if (user.banned) {
      if (await adminStore.claimBanNotice(user.id, nowSec, BAN_NOTICE_EVERY)) await send(ctx, 'ban.notice', t(ctx.lang, 'ban.notice'));
      return { trace: ctx.trace, banned: true };
    }
    if (user.mute_until > nowSec) return { trace: ctx.trace, muted: true };
    if (user.spam_n > SPAM_MAX) {
      await store.mute(user.id, nowSec + SPAM_MUTE);
      await send(ctx, 'spam.muted', t(ctx.lang, 'spam.muted', { n: Math.round(SPAM_MUTE / 60) }));
      return { trace: ctx.trace, muted: true };
    }
  }
  const cmd = parseCommand(msg.text);
  if (cmd && (cmd.name === 'lang' || (cmd.name === 'start' && !isLang(user.lang)))) {
    await onCommand(ctx, user, msg, cmd, role, nowSec);
  } else {
    const settings = await adminStore.getSettings();
    const join = await checkJoin(ctx, user, settings, nowSec, { role });
    if (!join.ok) await sendLock(ctx, join.missing);
    else if (cmd) await onCommand(ctx, user, msg, cmd, role, nowSec);
    else await onContent(ctx, user, msg, role, settings, nowSec);
  }
  await bc.sideStep(ctx, nowSec);
  return { trace: ctx.trace };
}

const int = (s) => (/^\d{1,15}$/.test(s || '') ? Number(s) : null);
const chatIdOf = (s) => (/^-?\d{1,16}$/.test(s || '') ? Number(s) : null);

/* "a:<op>:<x>:<y>" — the admin panel. The role is checked here, fresh, for every press. */
async function onAdminButton(ctx, user, role, cq, [op, x, y], msgId, nowSec) {
  if (!role || (adminUi.OWNER_ONLY.includes(op) && role !== 'owner')) return answer(ctx, t(ctx.lang, 'adm.denied'), true);
  const id = int(x);
  const needId = ['qs', 'ok', 'no', 'nb', 'nby', 'qk', 'rs', 'rk', 'rd', 'rb', 'rby', 'rq', 'uc', 'ub', 'uu', 'uh', 'uhy', 'adr', 'bcy', 'bcn', 'bcx', 'bcs'];
  if (needId.includes(op) && id === null) return answer(ctx);
  switch (op) {
    case 'p': await answer(ctx); return adminUi.showPanel(ctx, role, msgId);
    case 'x': return adminUi.cancelInput(ctx, user, msgId);
    case 'q': await answer(ctx); return review.showQueue(ctx, 0, nowSec);
    case 'qs': await answer(ctx); return review.showQueue(ctx, id, nowSec);
    case 'ok':
    case 'no': return review.decide(ctx, cq.from, id, op === 'ok', msgId, await adminStore.getSettings(), nowSec);
    case 'nb': return review.askBan(ctx, id, msgId, 'nby', 'qk');
    case 'nby': return review.rejectAndBan(ctx, cq.from, id, msgId, nowSec);
    case 'qk': return review.restoreQueueCard(ctx, id, msgId);
    case 'r': await answer(ctx); return review.showReports(ctx, 0, nowSec);
    case 'rs': await answer(ctx); return review.showReports(ctx, id, nowSec);
    case 'rk': return review.resolve(ctx, cq.from, id, 'keep', msgId, nowSec);
    case 'rd': return review.resolve(ctx, cq.from, id, 'remove', msgId, nowSec);
    case 'rb': return review.askBan(ctx, id, msgId, 'rby', 'rq');
    case 'rby': return review.resolve(ctx, cq.from, id, 'ban', msgId, nowSec);
    case 'rq': return review.restoreReportCard(ctx, id, msgId);
    case 'u': await answer(ctx); return adminUi.askInput(ctx, user, adminUi.STATE_USER, 'adm.user_ask', nowSec);
    case 'uc': await answer(ctx); return adminUi.showUser(ctx, id, nowSec, msgId);
    case 'ub':
    case 'uu': return adminUi.setBan(ctx, cq.from, id, op === 'ub', msgId, nowSec);
    case 'uh':
    case 'uhy': return adminUi.hideAll(ctx, cq.from, id, op === 'uhy', msgId, nowSec);
    case 'bl': await answer(ctx); return adminUi.showBanned(ctx, id || 0, msgId);
    case 'ad': await answer(ctx); return adminUi.showAdmins(ctx, msgId);
    case 'ada': await answer(ctx); return adminUi.askInput(ctx, user, adminUi.STATE_ADMIN, 'adm.admin_ask', nowSec);
    case 'adr': return adminUi.removeAdmin(ctx, id, msgId);
    case 'st':
      if (x) return adminUi.changeSetting(ctx, x, y, msgId);
      await answer(ctx);
      return adminUi.showSettings(ctx, msgId);
    case 'ch': await answer(ctx); return adminUi.showChannels(ctx, msgId);
    case 'cha': await answer(ctx); return adminUi.askInput(ctx, user, adminUi.STATE_CHANNEL, 'adm.channel_ask', nowSec);
    case 'chr': return chatIdOf(x) === null ? answer(ctx) : adminUi.removeChannel(ctx, chatIdOf(x), msgId);
    case 'bc': await answer(ctx); return bc.askMessage(ctx, user, nowSec);
    case 'bcy': return bc.confirm(ctx, id, msgId, nowSec);
    case 'bcn': return bc.cancelDraft(ctx, id, msgId);
    case 'bcx': return bc.nextBatch(ctx, id, msgId, nowSec);
    case 'bcs': return bc.stop(ctx, id, msgId, nowSec);
    default: return answer(ctx);
  }
}

/* After the language: the join lock, or the welcome / upload help. */
async function afterLanguage(ctx, user, role, from, next, nowSec) {
  const join = await checkJoin(ctx, user, await adminStore.getSettings(), nowSec, { role });
  if (!join.ok) return sendLock(ctx, join.missing);
  return next === 'u' ? sendUploadHow(ctx) : sendWelcome(ctx, from, nowSec);
}

async function onButton(ctx, user, role, cq, nowSec) {
  const parts = String(cq.data || '').split(':');
  const [code, a, b, c] = parts;
  const msgId = cq.message ? cq.message.message_id : null;
  if (!msgId || code === 'nop') return;
  if (code === 'a') return onAdminButton(ctx, user, role, cq, parts.slice(1), msgId, nowSec);
  if (code === 'lang') {
    if (!isLang(a)) return;
    await store.setLang(user.id, a);
    ctx.lang = a;
    await edit(ctx, 'lang.saved', msgId, t(a, 'lang.saved'), null);
    await answer(ctx);
    return afterLanguage(ctx, user, role, cq.from, b, nowSec);
  }
  const settings = await adminStore.getSettings();
  const join = await checkJoin(ctx, user, settings, nowSec, { role, fresh: code === 'j' });
  if (code === 'j') {
    if (!join.ok) {
      await editKeyboard(ctx, 'join.lock', msgId, lockKeyboard(ctx.lang, join.missing));
      return answer(ctx, t(ctx.lang, 'join.still'), true);
    }
    await edit(ctx, 'join.ok', msgId, t(ctx.lang, 'join.ok'), null);
    await answer(ctx);
    return sendWelcome(ctx, cq.from, nowSec);
  }
  if (!join.ok) {
    await answer(ctx, t(ctx.lang, 'join.alert'), true);
    return sendLock(ctx, join.missing);
  }
  switch (code) {
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
    case 'rp':
      if (int(a) === null) return;
      if (b) return review.fileReport(ctx, user, int(a), b, msgId, settings, nowSec);
      return review.pickReason(ctx, user, int(a), msgId);
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
    const role = await roleOf(user.id);
    if (!role && user.banned) await answer(ctx, t(ctx.lang, 'ban.alert'), true);
    else if (!role && user.mute_until > nowSec) await answer(ctx, t(ctx.lang, 'spam.wait'), true);
    else await onButton(ctx, user, role, cq, nowSec);
  } finally {
    await answer(ctx);
  }
  await bc.sideStep(ctx, nowSec);
  return { trace: ctx.trace };
}

export async function onInline(q) {
  const ctx = createCtx();
  if (q && q.from && typeof q.id === 'string') await onInlineQuery(ctx, q, now());
  return { trace: ctx.trace };
}

export async function onChosen(r) {
  const ctx = createCtx();
  const counted = r ? await onChosenResult(ctx, r, now()) : false;
  return { trace: ctx.trace, counted };
}
