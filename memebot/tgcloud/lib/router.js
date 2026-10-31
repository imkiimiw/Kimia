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
 *   5. a command: /start [upload|join|fav] /help /lang /my /fav /tags /top /profile /cancel /upload,
 *      /admin (staff), /setup and /aikey (owner)
 *   6. an input in progress: admin (users.state adm:*) → lib/admin.js / lib/broadcast.js;
 *      new keywords for a meme (edkw) → lib/mine.js
 *   7. a meme (photo, animation, video, sticker, voice) → upload.onMedia
 *   8. text: a meme waits for keywords → upload.onKeywords; otherwise a hint
 *   9. other content (files, audio, round videos, …) → "unsupported"; service messages → nothing
 *  10. side tasks (lib/jobs.js): the next broadcast batch, the meme of the day
 * callback_query — the user is ensured; banned / muted users get an alert. Outside the private
 *   chat (an inline message, a channel post) only 👍 (lk) works, and nothing is ever sent to that
 *   chat. "a:" buttons need a role (owner-only codes in admin.OWNER_ONLY; a moderator may only use
 *   admin.MOD_ALLOWED — the approval queue); other buttons need the
 *   join check (not lk); every query is answered exactly once; then the side tasks.
 * inline_query → lib/inline.js (no user row is created there).
 * chosen_inline_result → usage count (lib/inline.js), then the side tasks.
 *
 * callback_data (all ≤ 64 bytes):
 *   lang:<code>[:u|:f]                language picked (then u: upload help, f: favourites) lib/menu.js
 *   m:up | m:my | m:help | m:lang     main menu                                        lib/menu.js
 *   up:x:<mediaMsgId>                 cancel the pending upload of that media          lib/upload.js
 *   up:p:<mediaMsgId>                 toggle "save privately" for that media           lib/upload.js
 *   up:s:<mediaMsgId>                 save with the AI's suggested keywords            lib/upload.js
 *   my:<page>                         "my memes" page (edits the list)                 lib/mine.js
 *   mv:<id>:<page>                    open a meme card                                 lib/mine.js
 *   md | mn | mx:<id>:<page>:<listId> delete? / keep / delete for real                 lib/mine.js
 *   me | mp:<id>:<page>:<listId>      edit keywords / publish a private meme            lib/mine.js
 *   ek:x                              cancel editing keywords                          lib/mine.js
 *   fv:<id> | fl:<page> | fo:<id>:<page>  favourite toggle / list / card                 lib/collection.js
 *   m:fav | m:tags                    menu: favourites, hashtags                       lib/collection.js
 *   lk:<id>                           like / unlike (any chat, inline messages too)    lib/collection.js
 *   lb:w | lb:l                       leaderboard this / last week                     lib/social.js
 *   lm:<id> | pf:<uid> | pv:t         top meme card / someone's profile / hide my name lib/social.js
 *   m:top | m:me                      menu: leaderboard, my profile                    lib/social.js
 *   rp:<id>[:<reason>|:x]             report a meme (reasons in config.REPORT_REASONS)  lib/review.js
 *   j:chk                             "I joined" (fresh membership check)              lib/join.js
 *   a:…                               admin panel (table in lib/admin.js, lib/review.js, lib/broadcast.js)
 *   nop                               a label button (does nothing)
 */
import { BAN_NOTICE_EVERY, SPAM_MAX, SPAM_MUTE, SPAM_WINDOW, START_FAV, START_UPLOAD } from './config.js';
import * as adminUi from './admin.js';
import * as adminStore from './adminstore.js';
import * as bc from './broadcast.js';
import { roleOf } from './bot.js';
import { isLang, langOf, t } from './i18n.js';
import { onChosenResult, onInlineQuery } from './inline.js';
import { checkJoin, lockKeyboard, sendLock } from './join.js';
import { sendHelp, sendHint, sendLanguagePicker, sendUploadHow, sendWelcome } from './menu.js';
import { showFavCard, showFavs, showTags, toggleFav, toggleLike } from './collection.js';
import { sideTasks } from './jobs.js';
import { showLeaderboard, showOtherProfile, showProfile, showPublicCard, toggleVisibility } from './social.js';
import { showOverview, showQueries } from './stats.js';
import * as mine from './mine.js';
import { confirmDelete, doDelete, showCard, showList } from './mine.js';
import { setAiKey, setup } from './owner.js';
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
      if (!isLang(user.lang)) return sendLanguagePicker(ctx, { [START_UPLOAD]: 'u', [START_FAV]: 'f' }[cmd.arg] || '');
      if (cmd.arg === START_UPLOAD) return sendUploadHow(ctx);
      if (cmd.arg === START_FAV) return showFavs(ctx, user, 0, nowSec);
      return sendWelcome(ctx, msg.from, nowSec);
    case 'help':
      return sendHelp(ctx, nowSec);
    case 'lang':
      return sendLanguagePicker(ctx);
    case 'my':
      return showList(ctx, user.id, 0);
    case 'fav':
      return showFavs(ctx, user, 0, nowSec);
    case 'tags':
      return showTags(ctx, nowSec);
    case 'top':
      return showLeaderboard(ctx, 'w', nowSec);
    case 'profile':
      return showProfile(ctx, user, nowSec);
    case 'upload':
      return sendUploadHow(ctx);
    case 'cancel':
      if (user.state && user.state.startsWith('adm:')) {
        await store.clearState(user.id);
        return send(ctx, 'cancel', t(ctx.lang, 'adm.input_cancelled'));
      }
      if (user.state === mine.STATE_EDIT) {
        await store.clearState(user.id);
        return send(ctx, 'cancel', t(ctx.lang, 'edit.cancelled'));
      }
      return send(ctx, 'cancel', t(ctx.lang, (await upload.cancel(ctx, user)) ? 'cancel.done' : 'cancel.none'));
    case 'admin':
      if (role) return adminUi.showPanel(ctx, role);
      return sendHint(ctx, '', nowSec);
    case 'setup':
      if (role === 'owner') return setup(ctx, nowSec);
      return sendHint(ctx, '', nowSec);
    case 'aikey':
      if (role === 'owner') return setAiKey(ctx, msg, cmd.arg, nowSec);
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
  if (upload.mediaOf(msg)) return upload.onMedia(ctx, user, msg, role, settings, nowSec);
  if (typeof msg.text === 'string') {
    if (user.state === upload.STATE_KEYWORDS) return upload.onKeywords(ctx, user, msg, role, settings, nowSec);
    if (user.state === mine.STATE_EDIT) return mine.onEditKeywords(ctx, user, msg, role, settings, nowSec);
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
  await sideTasks(ctx, nowSec);
  return { trace: ctx.trace };
}

const int = (s) => (/^\d{1,15}$/.test(s || '') ? Number(s) : null);
const chatIdOf = (s) => (/^-?\d{1,16}$/.test(s || '') ? Number(s) : null);

/* "a:<op>:<x>:<y>" — the admin panel. The role is checked here, fresh, for every press. */
async function onAdminButton(ctx, user, role, cq, [op, x, y], msgId, nowSec) {
  if (!role || (adminUi.OWNER_ONLY.includes(op) && role !== 'owner') || (role === 'mod' && !adminUi.MOD_ALLOWED.includes(op))) {
    return answer(ctx, t(ctx.lang, 'adm.denied'), true);
  }
  const id = int(x);
  const needId = ['qs', 'ok', 'no', 'nb', 'nby', 'qk', 'rs', 'rk', 'rd', 'rb', 'rby', 'rq', 'uc', 'ub', 'uu', 'uh', 'uhy', 'adr', 'adt', 'bcy', 'bcn', 'bcx', 'bcs'];
  if (needId.includes(op) && id === null) return answer(ctx);
  switch (op) {
    case 'p': await answer(ctx); return adminUi.showPanel(ctx, role, msgId);
    case 'x': return adminUi.cancelInput(ctx, user, msgId);
    case 'q': await answer(ctx); return review.showQueue(ctx, 0, nowSec, role);
    case 'qs': await answer(ctx); return review.showQueue(ctx, id, nowSec, role);
    case 'ok':
    case 'no': return review.decide(ctx, cq.from, id, op === 'ok', msgId, await adminStore.getSettings(), nowSec, role);
    case 'nb': return review.askBan(ctx, id, msgId, 'nby', 'qk');
    case 'nby': return review.rejectAndBan(ctx, cq.from, id, msgId, nowSec);
    case 'qk': return review.restoreQueueCard(ctx, id, msgId, role);
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
    case 'ada': await answer(ctx); return adminUi.askInput(ctx, user, adminUi.STATE_ADMIN, 'adm.admin_ask', nowSec, { role: 'admin' });
    case 'adm': await answer(ctx); return adminUi.askInput(ctx, user, adminUi.STATE_ADMIN, 'adm.mod_ask', nowSec, { role: 'mod' });
    case 'adt': return adminUi.switchRole(ctx, id, msgId);
    case 'adr': return adminUi.removeAdmin(ctx, id, msgId);
    case 'ss': await answer(ctx); return showOverview(ctx, nowSec, msgId);
    case 'sq':
    case 'sm': await answer(ctx); return showQueries(ctx, op === 'sm', id === 30 ? 30 : 7, nowSec, msgId);
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
  if (next === 'u') return sendUploadHow(ctx);
  if (next === 'f') return showFavs(ctx, user, 0, nowSec);
  return sendWelcome(ctx, from, nowSec);
}

async function onButton(ctx, user, role, cq, inPrivate, nowSec) {
  const parts = String(cq.data || '').split(':');
  const [code, a, b, c] = parts;
  if (code === 'lk') return int(a) === null ? undefined : toggleLike(ctx, user, int(a), cq, nowSec);
  if (!inPrivate || code === 'nop') return;
  const msgId = cq.message.message_id;
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
      if (a === 'fav') return showFavs(ctx, user, 0, nowSec);
      if (a === 'tags') return showTags(ctx, nowSec);
      if (a === 'top') return showLeaderboard(ctx, 'w', nowSec);
      if (a === 'me') return showProfile(ctx, user, nowSec);
      return;
    case 'up': {
      if (a === 'p') return int(b) === null ? answer(ctx) : upload.togglePrivate(ctx, user, int(b), msgId, nowSec);
      if (a === 's') return int(b) === null ? answer(ctx) : upload.useSuggestions(ctx, user, int(b), role, settings, nowSec);
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
    case 'me':
      if (int(a) === null) return;
      return mine.startEdit(ctx, user, int(a), int(b) || 0, int(c) || 0, nowSec);
    case 'ek':
      return mine.cancelEdit(ctx, user, msgId);
    case 'mp':
      if (int(a) === null) return;
      return mine.publish(ctx, user, role, int(a), int(b) || 0, int(c) || 0, msgId, settings, nowSec);
    case 'fv':
      if (int(a) === null) return;
      return toggleFav(ctx, user, int(a), cq, nowSec);
    case 'fl':
      await answer(ctx);
      return showFavs(ctx, user, int(a) || 0, nowSec, msgId);
    case 'fo':
      if (int(a) === null) return;
      return showFavCard(ctx, user, int(a));
    case 'lb':
      await answer(ctx);
      return showLeaderboard(ctx, a === 'l' ? 'l' : 'w', nowSec, msgId);
    case 'lm':
      if (int(a) === null) return;
      return showPublicCard(ctx, user, int(a));
    case 'pf':
      if (int(a) === null) return;
      return showOtherProfile(ctx, int(a), nowSec);
    case 'pv':
      return toggleVisibility(ctx, user, msgId, nowSec);
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
    const inPrivate = !!cq.message && cq.message.chat && cq.message.chat.type === 'private';
    /* Replies go to the user's private chat, never to a channel or group the button was in. */
    Object.assign(ctx, { userId: user.id, chatId: inPrivate ? cq.message.chat.id : cq.from.id, lang: langOf(user, cq.from) });
    const role = await roleOf(user.id);
    if (!role && user.banned) await answer(ctx, t(ctx.lang, 'ban.alert'), true);
    else if (!role && user.mute_until > nowSec) await answer(ctx, t(ctx.lang, 'spam.wait'), true);
    else await onButton(ctx, user, role, cq, inPrivate, nowSec);
  } finally {
    await answer(ctx);
  }
  await sideTasks(ctx, nowSec);
  return { trace: ctx.trace };
}

export async function onInline(q) {
  const ctx = createCtx();
  if (q && q.from && typeof q.id === 'string') await onInlineQuery(ctx, q, now());
  return { trace: ctx.trace };
}

export async function onChosen(r) {
  const ctx = createCtx();
  const nowSec = now();
  const counted = r ? await onChosenResult(ctx, r, nowSec) : false;
  await sideTasks(ctx, nowSec);
  return { trace: ctx.trace, counted };
}
