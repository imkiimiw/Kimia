// Entry points for the four handlers. Each one catches everything (users never see a raw error),
// always answers a button press, and returns { trace } — every Bot API call it made — which
// `npx tgcloud run` prints. ctx.lang is the language of the person the update came from.
//
// Order of checks for a private message:
//   1. /start w_<id> (read a whisper)   — no forced join, no ban check: reading is always allowed
//   2. /cancel, then a pending state     — owner: add_channel / ban / unban / bc_wait; users: block_add,
//      anon_send / anon_reply, inbox_search, word_add, qotd_custom, profile_name / _bio / _photo
//   3. banned users stop here            — the owner can't be banned
//   4. /start a_<code> (anonymous link)  — remembers the target first, so it survives the join screen
//   5. /admin                            — owner only (numeric id), private chat only
//   6. first /start, or /lang            — the language picker, before anything else
//   7. forced join                       — everyone but the owner
//   8. /start /help /whisper /anon /link /inbox /profile /privacy /history /settings /blocks
//
// callback_data (all ASCII, ≤ 64 bytes):
//   L:<lang> language · m main menu · hp[:w|:a] help · pv privacy · lg language picker · j re-check join
//   whispers:  s:<id> show (inline message) · ws section · h:s|r:<page> history · d:<id> details
//              n:<id> curious list · st, st:r, st:e:<sec> settings · bl, bl:add, bl:a, bk:<uid>, ub:<uid>
//   anonymous: an section · al, al:t, al:new link · ac:<cat> category · rt:<code>[:<n>] rating
//              aw:<code> write again · ar:<id> reply · ab:<id> (un)block · ap:<id>, apy:<id> report
//              ib:<folder>:<cat|->:<page> inbox · iv:<id> view · ia archive · ic:<id>[:<cat>] category
//              ix, ixy delete · ibb:<id> (un)block from the inbox · is:<folder> search · uba:<ref> unblock
//              qd, qd:d, qd:c, qd:0 question · cd cards · fs, fs:o|l|t|s filters · fw, fw:add, fw:rm:<i>
//              as, as:t, as:new, as:r settings · dd, ddy delete my data · pf, pf:n|b|p|px|r|v profile
//   owner:     a, a:x, a:ch, a:add, a:rm:<id>, a:rmy:<id>, a:j, a:ban, a:unban, a:st, a:rp, a:rv:<id>,
//              a:rb|rr|rd:<id>, a:bc, a:bcy:<id>, a:bcn:<id>, a:bcc:<id>, a:bcs:<id>, a:bcp:<id>
import { OWNER_ID } from './config.js';
import * as admin from './admin.js';
import * as anon from './anon.js';
import * as anonset from './anonset.js';
import { showCards } from './card.js';
import { langOf, t } from './i18n.js';
import * as inbox from './inbox.js';
import { afterUpdate } from './maint.js';
import * as menu from './menu.js';
import * as profile from './profile.js';
import * as qotd from './qotd.js';
import {
  clearState, getState, getUser, loadKv, touchUser,
} from './store.js';
import {
  answer, call, createCtx, describeError, send,
} from './tg.js';
import {
  handleChosen, handleDeepRead, handleInline, handleShowButton,
} from './whisper.js';
import * as wpm from './wpm.js';

const OWNER_STATES = new Set(['add_channel', 'ban', 'unban', 'bc_wait']);
const PROFILE_STATES = new Set(['profile_name', 'profile_bio', 'profile_photo']);

function result(ctx) {
  const out = { trace: ctx.trace };
  if (ctx.error) out.error = ctx.error;
  if (ctx.gc) out.gc = ctx.gc;
  if (ctx.filtered) out.filtered = ctx.filtered;
  return out;
}

function parseCommand(text) {
  const m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  return m ? { cmd: m[1].toLowerCase(), arg: (m[2] || '').trim() } : null;
}

// ---------- messages ----------

export async function onMessage(message) {
  const ctx = createCtx({ userId: message && message.from && message.from.id, chatId: message && message.chat && message.chat.id });
  let kv = null;
  try {
    if (!message || !message.from || !message.chat || message.from.is_bot) return result(ctx);
    if (message.chat.type !== 'private') return result(ctx); // whispers work inline; groups need nothing
    kv = await loadKv();
    const user = await touchUser(message.from, { started: true });
    ctx.lang = langOf(user, message.from);
    await routeMessage(ctx, message, user, kv);
    await menu.ensureBotTexts(ctx, kv);
  } catch (err) {
    console.error('message handler failed:', err);
    ctx.error = describeError(err);
    await send(ctx, 'error', t(ctx.lang, 'e.generic'));
  } finally {
    await afterUpdate(ctx, kv);
  }
  return result(ctx);
}

/** After the language is chosen or the join check passes: continue a link visit, else the main menu. */
async function continueOrMain(ctx, user, kv, note = '') {
  if (user.id !== OWNER_ID && !(await menu.requireJoin(ctx, user, kv))) return null;
  const st = await getState(user.id);
  if (st && st.state === 'anon_send') {
    const owner = await getUser(Number(st.data.to));
    if (owner && owner.anonOn) return anon.showProfileCard(ctx, owner, st.data);
  }
  return menu.showMain(ctx, user, kv, note);
}

async function routeState(ctx, message, user, kv, st) {
  const isOwner = user.id === OWNER_ID;
  if (isOwner && OWNER_STATES.has(st.state)) {
    if (st.state === 'bc_wait') return admin.onBroadcastMessage(ctx, user, message);
    if (st.state === 'add_channel') return admin.onChannelInput(ctx, user, kv, message.text);
    return admin.onBanInput(ctx, user, message.text, st.state === 'ban');
  }
  if (user.banned && !isOwner) return send(ctx, 'banned', t(ctx.lang, 'e.banned'));
  if (!isOwner && !(await menu.requireJoin(ctx, user, kv))) return null; // the state waits
  switch (st.state) {
    case 'block_add':
      return wpm.onBlockInput(ctx, user, message.text);
    case 'anon_send':
    case 'anon_reply':
      return anon.onAnonMessage(ctx, user, message, st);
    case 'inbox_search':
      return inbox.onSearch(ctx, user, message.text, st.data);
    case 'word_add':
      return anonset.onWordInput(ctx, user, message.text);
    case 'qotd_custom':
      return qotd.onCustomQuestion(ctx, user, message.text);
    default:
      if (PROFILE_STATES.has(st.state)) return profile.onProfileInput(ctx, user, message, st.state);
      await clearState(user.id);
      return menu.showHint(ctx);
  }
}

async function routeMessage(ctx, message, user, kv) {
  const c = parseCommand(message.text);
  const isOwner = user.id === OWNER_ID;

  if (c && c.cmd === 'start' && /^w_[0-9A-Za-z]{8,9}$/.test(c.arg)) return handleDeepRead(ctx, message, c.arg.slice(2));

  if (c && c.cmd === 'cancel') {
    await clearState(user.id);
    return send(ctx, 'cancelled', t(ctx.lang, 'e.cancelled'), menu.mainKeyboard(ctx));
  }

  const st = await getState(user.id);
  if (st) {
    if (!c) return routeState(ctx, message, user, kv, st);
    if (!(c.cmd === 'start' && /^a_/.test(c.arg))) await clearState(user.id); // a command replaces the state
  }

  if (user.banned && !isOwner) return send(ctx, 'banned', t(ctx.lang, 'e.banned'));

  if (c && c.cmd === 'start' && /^a_/.test(c.arg)) {
    const target = await anon.openLink(ctx, user, c.arg.slice(2));
    if (!target) return null;
    if (!isOwner && !(await menu.requireJoin(ctx, user, kv))) return null; // the target waits in user_state
    return anon.showProfileCard(ctx, target, (await getState(user.id)).data);
  }

  if (c && c.cmd === 'admin') {
    if (!isOwner) return send(ctx, 'admin_refused', t(ctx.lang, 'e.owner_only'));
    return admin.showPanel(ctx, kv);
  }

  if ((c && c.cmd === 'lang') || (!user.lang && c && c.cmd === 'start')) return menu.showLangPicker(ctx);

  if (!isOwner && !(await menu.requireJoin(ctx, user, kv, { fresh: !!(c && c.cmd === 'start' && c.arg === 'join') }))) return null;

  switch (c && c.cmd) {
    case 'start':
      return menu.showMain(ctx, user, kv, c.arg === 'join' ? t(ctx.lang, 'join.welcome_back') : '');
    case 'help':
      return menu.showHelp(ctx, kv);
    case 'whisper':
      return menu.showWhisperSection(ctx, kv);
    case 'anon':
      return anon.showSection(ctx, user, kv);
    case 'link':
      return anon.showAnonLink(ctx, user, kv);
    case 'inbox':
      return inbox.showInbox(ctx, user, 0, '-', 0);
    case 'profile':
      return profile.showProfile(ctx, user);
    case 'privacy':
      return menu.showPrivacy(ctx);
    case 'history':
      return wpm.showHistory(ctx, user, 's', 0);
    case 'settings':
      return wpm.showSettings(ctx, user);
    case 'blocks':
      return wpm.showBlocks(ctx, user);
    default:
      return menu.showHint(ctx);
  }
}

// ---------- button presses ----------

export async function onCallback(cq) {
  const msg = cq && cq.message;
  const ctx = createCtx({
    userId: cq && cq.from && cq.from.id,
    chatId: msg && msg.chat ? msg.chat.id : null,
    messageId: msg ? msg.message_id : null,
    callbackId: cq && cq.id,
  });
  let kv = null;
  try {
    const data = String((cq && cq.data) || '');
    const isPrivate = !!(msg && msg.chat && msg.chat.type === 'private');
    if (data.startsWith('s:')) {
      // Opening a whisper: no forced join and no ban check, the recipient must always be able to read.
      ctx.lang = langOf(await getUser(cq.from.id), cq.from);
      await handleShowButton(ctx, cq, data.slice(2));
      await touchUser(cq.from);
    } else {
      kv = await loadKv();
      const user = await touchUser(cq.from, { started: isPrivate });
      ctx.lang = langOf(user, cq.from);
      await routeCallback(ctx, data, user, kv, isPrivate);
    }
  } catch (err) {
    console.error('callback handler failed:', err);
    ctx.error = describeError(err);
    await answer(ctx, t(ctx.lang, 'e.generic'), { alert: true });
  } finally {
    if (!ctx.answered) await answer(ctx); // Telegram keeps the button spinning until it is answered
    await afterUpdate(ctx, kv);
  }
  return result(ctx);
}

async function routeCallback(ctx, data, user, kv, isPrivate) {
  const parts = data.split(':');
  const [head, a1, a2] = parts;
  const isOwner = user.id === OWNER_ID;

  if (head === 'a') {
    if (!isOwner || !isPrivate) return answer(ctx, t(ctx.lang, 'e.owner_only'), { alert: true });
    return routeAdmin(ctx, user, kv, a1 || '', a2);
  }
  if (!isPrivate) return answer(ctx, t(ctx.lang, 'e.private_only'));
  if (head === 'L') return menu.chooseLang(ctx, user, kv, a1, (c, u, k) => continueOrMain(c, u, k));
  if (user.banned && !isOwner) return answer(ctx, t(ctx.lang, 'e.banned'), { alert: true });
  if (head === 'j') return menu.recheckJoin(ctx, user, kv, (c, u, k) => continueOrMain(c, u, k, t(c.lang, 'join.welcome_back')));
  // Blocking is protection, so it works even before joining the channels.
  if (head === 'bk') return wpm.blockUser(ctx, user, a1);
  if (head === 'ab') return anon.toggleBlock(ctx, user, a1);

  if (!isOwner && !(await menu.requireJoin(ctx, user, kv))) return answer(ctx, t(ctx.lang, 'join.first'));

  switch (head) {
    // ----- shell -----
    case 'm':
      await clearState(user.id);
      return menu.showMain(ctx, user, kv);
    case 'hp':
      return menu.showHelp(ctx, kv, a1 || '');
    case 'pv':
      return menu.showPrivacy(ctx);
    case 'lg':
      return menu.showLangPicker(ctx);
    // ----- whispers -----
    case 'ws':
      return menu.showWhisperSection(ctx, kv);
    case 'h':
      return wpm.showHistory(ctx, user, a1 === 'r' ? 'r' : 's', a2);
    case 'd':
      return wpm.showDetails(ctx, user, a1);
    case 'n':
      return wpm.showCurious(ctx, user, a1);
    case 'st':
      if (a1 === 'r') return wpm.toggleReceipts(ctx, user);
      if (a1 === 'e') return wpm.setExpiry(ctx, user, a2);
      return wpm.showSettings(ctx, user);
    case 'bl':
      if (a1 === 'add') return wpm.askBlock(ctx, user);
      await clearState(user.id);
      return wpm.showBlocks(ctx, user, '', a1 === 'a' ? 'fs' : 'ws');
    case 'ub':
      return wpm.unblockUser(ctx, user, a1);
    case 'uba':
      await anon.unblockByRef(ctx, user, a1);
      return wpm.showBlocks(ctx, user);
    // ----- anonymous: section, link, visiting -----
    case 'an':
      await clearState(user.id);
      return anon.showSection(ctx, user, kv);
    case 'al':
      if (a1 === 't') return anon.toggleAnon(ctx, user, kv);
      if (a1 === 'new') return anon.newAnonLink(ctx, user, kv);
      return anon.showAnonLink(ctx, user, kv);
    case 'ac':
      return anon.pickCategory(ctx, user, a1);
    case 'rt':
      return anon.rate(ctx, user, a1, a2);
    case 'aw':
      return anon.writeAgain(ctx, user, a1);
    case 'ar':
      return anon.startReply(ctx, user, a1);
    case 'ap':
      return anon.askReport(ctx, user, a1);
    case 'apy':
      return anon.confirmReport(ctx, user, a1);
    // ----- anonymous: inbox -----
    case 'ib':
      return inbox.showInbox(ctx, user, a1, a2, parts[3]);
    case 'iv':
      return inbox.showMessage(ctx, user, kv, a1);
    case 'ia':
      return inbox.toggleArchive(ctx, user, kv, a1);
    case 'ic':
      return inbox.recategorize(ctx, user, kv, a1, a2);
    case 'ix':
      return inbox.askDelete(ctx, user, a1);
    case 'ixy':
      return inbox.doDelete(ctx, user, a1);
    case 'ibb':
      await anon.toggleBlock(ctx, user, a1, { fromInbox: true });
      return inbox.showMessage(ctx, user, kv, a1);
    case 'is':
      return inbox.askSearch(ctx, user, a1);
    // ----- anonymous: question, cards, filters, settings, profile -----
    case 'qd':
      if (a1) return qotd.setMode(ctx, user, a1 === 'd' ? 'd' : a1 === 'c' ? 'c' : '0');
      return qotd.showQotd(ctx, user);
    case 'cd':
      return showCards(ctx, user, kv);
    case 'fs':
      if (a1) return anonset.toggle(ctx, user, a1);
      return anonset.showFilters(ctx, user);
    case 'fw':
      if (a1 === 'add') return anonset.askWord(ctx, user);
      if (a1 === 'rm') return anonset.removeWordAt(ctx, user, a2);
      await clearState(user.id);
      return anonset.showWords(ctx, user);
    case 'as':
      if (a1 === 't') await anon.setPaused(ctx, user, user.anonOn);
      if (a1 === 'new') await anon.renewLink(ctx, user);
      if (a1 === 'r') await profile.setRatingVisible(ctx, user, !user.showRating);
      return anonset.showSettings(ctx, user);
    case 'dd':
      return anonset.askDeleteData(ctx);
    case 'ddy':
      return anonset.deleteData(ctx, user);
    case 'pf':
      await clearState(user.id);
      if (a1 === 'n' || a1 === 'b' || a1 === 'p') return profile.ask(ctx, user, a1);
      if (a1 === 'px') return profile.removePhoto(ctx, user);
      if (a1 === 'r') return profile.toggleRating(ctx, user);
      if (a1 === 'v') return profile.preview(ctx, user);
      return profile.showProfile(ctx, user);
    default:
      return answer(ctx, t(ctx.lang, 'e.old_button'));
  }
}

async function routeAdmin(ctx, user, kv, action, arg) {
  switch (action) {
    case '':
    case 'x':
      await clearState(user.id);
      return admin.showPanel(ctx, kv);
    case 'ch':
      return admin.showChannels(ctx, kv);
    case 'add':
      return admin.askChannel(ctx, user);
    case 'rm':
      return admin.confirmRemove(ctx, arg);
    case 'rmy':
      return admin.doRemove(ctx, kv, arg);
    case 'j':
      return admin.toggleJoin(ctx, kv);
    case 'ban':
      return admin.askBan(ctx, user, true);
    case 'unban':
      return admin.askBan(ctx, user, false);
    case 'st':
      return admin.showStats(ctx);
    case 'rp':
      return admin.showReports(ctx);
    case 'rv':
      return admin.showReport(ctx, arg);
    case 'rb':
      return admin.actOnReport(ctx, arg, 'b');
    case 'rr':
      return admin.actOnReport(ctx, arg, 'r');
    case 'rd':
      return admin.actOnReport(ctx, arg, 'd');
    case 'bc':
      return admin.askBroadcast(ctx, user);
    case 'bcy':
      return admin.confirmBroadcast(ctx, arg);
    case 'bcn':
      return admin.cancelBroadcast(ctx, arg);
    case 'bcc':
      return admin.runBatch(ctx, arg);
    case 'bcs':
      return admin.stopBroadcast(ctx, arg);
    case 'bcp':
      return admin.showBroadcast(ctx, arg);
    default:
      return answer(ctx, t(ctx.lang, 'e.old_button'));
  }
}

// ---------- inline mode ----------

export async function onInlineQuery(q) {
  const ctx = createCtx({ userId: q && q.from && q.from.id });
  let kv = null;
  try {
    if (!q || !q.from) return result(ctx);
    kv = await loadKv();
    const user = await touchUser(q.from);
    ctx.lang = langOf(user, q.from);
    await handleInline(ctx, q, user, kv);
  } catch (err) {
    console.error('inline handler failed:', err);
    ctx.error = describeError(err);
    if (!ctx.trace.some((e) => e.m === 'answerInlineQuery')) {
      try {
        await call(ctx, 'answerInlineQuery', {
          inline_query_id: q.id,
          results: [],
          cache_time: 0,
          is_personal: true,
          button: { text: t(ctx.lang, 'e.inline'), start_parameter: 'help' },
        }, 'inline_error');
      } catch (e) {
        console.warn(`answerInlineQuery failed: ${describeError(e)}`);
      }
    }
  } finally {
    await afterUpdate(ctx, kv, { gc: false }); // keep the keystroke path short: no cleanup here
  }
  return result(ctx);
}

export async function onChosenInlineResult(c) {
  const ctx = createCtx({ userId: c && c.from && c.from.id });
  let kv = null;
  try {
    if (!c || !c.from) return result(ctx);
    kv = await loadKv();
    const user = await touchUser(c.from);
    ctx.lang = langOf(user, c.from);
    ctx.chosen = await handleChosen(ctx, c, user, kv);
  } catch (err) {
    console.error('chosen_inline_result handler failed:', err);
    ctx.error = describeError(err);
  } finally {
    await afterUpdate(ctx, kv);
  }
  const out = result(ctx);
  if (ctx.chosen) out.chosen = ctx.chosen;
  return out;
}
