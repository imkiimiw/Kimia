// Entry points for the handlers. Each one catches everything (users never see a raw error),
// always answers a button press, and returns { trace } — every Bot API call it made — which
// `npx tgcloud run` prints. ctx.lang is the language of the person the update came from.
//
// Order of checks for a private message:
//   1. /start w_<id> (read a whisper)   — no forced join, no ban check: reading is always allowed
//   2. /cancel; random-chat controls (⏭ ❌ 🚩) end the chat whatever else was pending
//   3. a pending state                   — staff (STAFF_STATES, permission checked again): add_channel, ban,
//      unban, bc_wait, bc_btn, wake_chat, admin_add, cf_chat, ai_key, ai_model; users: block_add,
//      anon_send / anon_reply, inbox_search, word_add, qotd_custom, profile_*, cf_write / cf_options /
//      cf_comment, qb_chat / qb_ask / qb_answer, wm_wait / wm_to
//   4. banned users stop here            — the owner can't be banned
//   5. in a random chat, anything that isn't a command goes to the partner (lib/rchat.js)
//   6. /start cx_<id> (message a confession's author), /start q_<code> (a channel's question box),
//      /start a_<code> (anonymous link)  — the target is remembered first, so it survives the join screen
//   7. /admin                            — the owner or an admin (lib/staff.js), private chat only
//   8. first /start, or /lang            — the language picker, before anything else
//   9. forced join                       — everyone but the owner
//  10. /start [cm_<id> | cf | join] /help /whisper /anon /link /inbox /profile /privacy /history /settings /blocks
//
// callback_data (all ASCII, ≤ 64 bytes):
//   L:<lang> language · m main menu · hp[:w|:a] help · pv privacy · lg language picker · j re-check join
//   whispers:  s:<id> show (inline message) · ws section · h:s|r:<page> history · d:<id> details
//              n:<id> curious list · st, st:r, st:e:<sec> settings · bl, bl:add, bl:a, bk:<uid>, ub:<uid>
//              wm media whisper · wo:<id> open a media whisper in the chat
//   anonymous: an section · al, al:t, al:new link · ac:<cat> category · rt:<code>[:<n>] rating
//              aw:<code> write again · ar:<id> reply · ab:<id> (un)block · ap:<id>, apy:<id> report
//              ae:<id>:<i>[:i] reaction · ib:<folder>:<cat|->:<page> inbox · iv:<id> view · ia archive
//              ic:<id>[:<cat>] category · ix, ixy delete · ibb:<id> (un)block from the inbox · is:<folder> search
//              uba:<ref> unblock · qd, qd:d, qd:c, qd:0, qd:p question · cd cards · fs, fs:o|l|p|t|s|i filters
//              fw, fw:add, fw:rm:<i> · as, as:t, as:new, as:r settings · dd, ddy delete my data · pf… profile
//   question boxes: qb list · qb:n connect · qb:v|l|p|t|r|x|xy:<box>[:<i>] · qb:a|d|b:<question> · qba:<code>
//   random chat: rc home · rc:go, rc:x, rc:m, rc:e, rc:n, rc:r, rc:ry, rc:rn
//   confessions: cf, cw, co:c|d, cs · cm:<id>:<offset> comments · cc:<id> comment · cr:<cid> report · cxw:<id>
//   staff (a:*, ADMIN_ACTIONS gives the permission each needs): channels ch, add, rm, rmy, j · ban, unban
//              st · reports rp, rv, rb, rr, rd · confessions cf, cfv, cfa, cfr, cfb, cfh · broadcast bc, bcy,
//              bcn, bcc, bcs, bcp, bca, bcb, bcbx · owner only: admins ad, adn, adv, adp, adx, adxy ·
//              confession channel cfs, cfsc, cfst, cfsx · scheduler wk, wkc, wkp, wkg · health hl ·
//              smart filter ai, aik, aio, ait, aim, aims, aimc, aix
//
// poll: the bot's own wake (lib/wake.js) → a step of the due work. channel_post: a post in the wake
// channel ticks the outside clock → the due work; posts elsewhere only carry the usual side work.
import { OWNER_ID } from './config.js';
import * as admin from './admin.js';
import * as anon from './anon.js';
import * as anonset from './anonset.js';
import * as confess from './confess.js';
import { showCards } from './card.js';
import { langOf, t } from './i18n.js';
import * as inbox from './inbox.js';
import { afterUpdate } from './maint.js';
import * as menu from './menu.js';
import * as profile from './profile.js';
import * as qbox from './qbox.js';
import * as qotd from './qotd.js';
import { getBox } from './qstore.js';
import * as rchat from './rchat.js';
import { can, getStaff } from './staff.js';
import { isOurWake, isTickPost } from './wake.js';
import {
  clearState, getState, getUser, loadKv, touchUser,
} from './store.js';
import {
  answer, call, createCtx, describeError, send,
} from './tg.js';
import {
  handleChosen, handleDeepRead, handleInline, handleShowButton,
} from './whisper.js';
import * as wmedia from './wmedia.js';
import * as wpm from './wpm.js';

// What a staff member's pending input needs (lib/staff.js): checked again when the input arrives.
const STAFF_STATES = {
  add_channel: 'ch', ban: 'ban', unban: 'ban', bc_wait: 'bc', bc_btn: 'bc', wake_chat: 'owner', admin_add: 'owner', cf_chat: 'owner',
  ai_key: 'owner', ai_model: 'owner',
};
// What each panel button needs: 'any' = any staff member, 'owner' = the owner alone.
const ADMIN_ACTIONS = {
  '': 'any', x: 'any',
  ch: 'ch', add: 'ch', rm: 'ch', rmy: 'ch', j: 'ch',
  ban: 'ban', unban: 'ban',
  st: 'st',
  rp: 'rp', rv: 'rp', rb: 'rp', rr: 'rp', rd: 'rp',
  bc: 'bc', bcy: 'bc', bcn: 'bc', bcc: 'bc', bcs: 'bc', bcp: 'bc', bca: 'bc', bcb: 'bc', bcbx: 'bc',
  cf: 'cf', cfv: 'cf', cfa: 'cf', cfr: 'cf', cfb: 'cf', cfh: 'cf',
  cfs: 'owner', cfsc: 'owner', cfst: 'owner', cfsx: 'owner',
  ad: 'owner', adn: 'owner', adv: 'owner', adp: 'owner', adx: 'owner', adxy: 'owner',
  wk: 'owner', wkc: 'owner', wkp: 'owner', wkg: 'owner',
  hl: 'owner',
  ai: 'owner', aik: 'owner', aio: 'owner', ait: 'owner', aim: 'owner', aims: 'owner', aimc: 'owner', aix: 'owner',
};
const PROFILE_STATES = new Set(['profile_name', 'profile_bio', 'profile_photo']);

function result(ctx) {
  const out = { trace: ctx.trace };
  if (ctx.error) out.error = ctx.error;
  if (ctx.gc) out.gc = ctx.gc;
  if (ctx.filtered) out.filtered = ctx.filtered;
  if (ctx.woke) out.woke = ctx.woke;
  if (ctx.wake) out.wake = ctx.wake;
  if (ctx.ai) out.ai = ctx.ai; // what the smart filter said (lib/ai.js), never the text
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
  if (st && st.state === 'qb_ask') { // a question box's link was opened before the language or join screen
    const box = await getBox(st.data.box);
    if (box && box.open) return qbox.showAsk(ctx, box);
  }
  if (st && st.state === 'anon_send') {
    if (st.data.via === 'cf') return confess.showDmCard(ctx, st.data.cf); // to a confession's author: no profile
    const owner = await getUser(Number(st.data.to));
    if (owner && owner.anonOn) return anon.showProfileCard(ctx, owner, st.data);
  }
  return menu.showMain(ctx, user, kv, note);
}

async function routeState(ctx, message, user, kv, st) {
  const isOwner = user.id === OWNER_ID;
  if (STAFF_STATES[st.state]) {
    if (!can(await getStaff(user.id), STAFF_STATES[st.state])) { // no longer staff, or lost the permission
      await clearState(user.id);
      return menu.showHint(ctx);
    }
    if (st.state === 'bc_wait') return admin.onBroadcastMessage(ctx, user, message);
    if (st.state === 'bc_btn') return admin.onBroadcastButton(ctx, user, message.text, st.data);
    if (st.state === 'add_channel') return admin.onChannelInput(ctx, user, kv, message.text);
    if (st.state === 'wake_chat') return admin.onWakeChatInput(ctx, user, kv, message);
    if (st.state === 'admin_add') return admin.onAdminInput(ctx, user, message);
    if (st.state === 'cf_chat') return confess.onChannelInput(ctx, user, kv, message);
    if (st.state === 'ai_key') return admin.onAiKey(ctx, user, message);
    if (st.state === 'ai_model') return admin.onAiModel(ctx, user, message);
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
    case 'cf_write':
    case 'cf_options': // new text replaces the draft
      return confess.onText(ctx, user, message);
    case 'cf_comment':
      return confess.onComment(ctx, user, kv, message, st);
    case 'qb_chat':
      return qbox.onChannelInput(ctx, user, kv, message);
    case 'qb_ask':
      return qbox.onQuestion(ctx, user, kv, message, st);
    case 'qb_answer':
      return qbox.onAnswer(ctx, user, kv, message, st);
    case 'wm_wait':
      return wmedia.onMedia(ctx, user, kv, message);
    case 'wm_to':
      return wmedia.onRecipients(ctx, user, kv, message, st);
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

  // The random chat's controls end the chat whatever else the user was in the middle of.
  if (user.rcPartner && rchat.isControl(message)) return rchat.onMessage(ctx, user, message);

  const st = await getState(user.id);
  if (st) {
    if (!c) return routeState(ctx, message, user, kv, st);
    if (!(c.cmd === 'start' && /^[aq]_/.test(c.arg))) await clearState(user.id); // a command replaces the state
  }

  if (user.banned && !isOwner) return send(ctx, 'banned', t(ctx.lang, 'e.banned'));

  // In a random chat, everything that isn't a command goes to the partner (lib/rchat.js).
  if (user.rcPartner && !c) return rchat.onMessage(ctx, user, message);

  if (c && c.cmd === 'start' && /^cx_\d+$/.test(c.arg)) { // an anonymous message to a confession's author
    if (!(await confess.prepareDm(ctx, user, Number(c.arg.slice(3))))) return null;
    if (!isOwner && !(await menu.requireJoin(ctx, user, kv))) return null; // the target waits in user_state
    return confess.showDmCard(ctx, Number(c.arg.slice(3)));
  }

  if (c && c.cmd === 'start' && /^q_[0-9A-Za-z]{10}$/.test(c.arg)) { // a channel's question box
    const box = await qbox.openBox(ctx, user, c.arg.slice(2));
    if (!box) return null;
    if (!isOwner && !(await menu.requireJoin(ctx, user, kv))) return null; // the box waits in user_state
    return qbox.showAsk(ctx, box);
  }

  if (c && c.cmd === 'start' && /^a_/.test(c.arg)) {
    const target = await anon.openLink(ctx, user, c.arg.slice(2));
    if (!target) return null;
    if (!isOwner && !(await menu.requireJoin(ctx, user, kv))) return null; // the target waits in user_state
    return anon.showProfileCard(ctx, target, (await getState(user.id)).data);
  }

  if (c && c.cmd === 'admin') {
    const staff = await getStaff(user.id);
    if (!staff) return send(ctx, 'admin_refused', t(ctx.lang, 'e.owner_only'));
    return admin.showPanel(ctx, kv, staff);
  }

  if ((c && c.cmd === 'lang') || (!user.lang && c && c.cmd === 'start')) return menu.showLangPicker(ctx);

  if (!isOwner && !(await menu.requireJoin(ctx, user, kv, { fresh: !!(c && c.cmd === 'start' && c.arg === 'join') }))) return null;

  switch (c && c.cmd) {
    case 'start':
      if (/^cm_\d+$/.test(c.arg)) return confess.showComments(ctx, user, Number(c.arg.slice(3))); // a post's 💬
      if (c.arg === 'cf') return confess.showHome(ctx, user, kv); // a post's "✍️ yours"
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
    const staff = isPrivate ? await getStaff(user.id) : null;
    if (!staff) return answer(ctx, t(ctx.lang, 'e.owner_only'), { alert: true });
    return routeAdmin(ctx, user, kv, staff, a1 || '', a2, parts[3]);
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
    case 'wm': // a media whisper: made here, posted with the inline query mw_<id>
      return wmedia.ask(ctx, user);
    case 'wo': // open a media whisper from its details (same checks as the deep link)
      await answer(ctx);
      return handleDeepRead(ctx, { from: { id: user.id, username: user.username, first_name: user.firstName } }, a1);
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
    // ----- random chat -----
    case 'rc':
      if (!a1) return rchat.showHome(ctx, user);
      if (a1 === 'go') return rchat.find(ctx, user);
      if (a1 === 'x') return rchat.cancelSearch(ctx, user);
      if (a1 === 'm') return rchat.toggleMedia(ctx, user);
      if (a1 === 'e') return rchat.end(ctx, user);
      if (a1 === 'n') return rchat.end(ctx, user, { next: true });
      if (a1 === 'r') return rchat.askReport(ctx, user);
      if (a1 === 'ry') return rchat.end(ctx, user, { report: true });
      return answer(ctx, t(ctx.lang, 'rc.report_cancelled'));
    // ----- channel question boxes -----
    case 'qb':
      return qbox.route(ctx, user, kv, a1, a2, parts[3]);
    case 'qba':
      return qbox.askAgain(ctx, user, a1);
    // ----- confessions -----
    case 'cf':
      await clearState(user.id);
      return confess.showHome(ctx, user, kv);
    case 'cw':
      return confess.startWrite(ctx, user, kv);
    case 'co':
      return confess.toggleOption(ctx, user, a1);
    case 'cs':
      return confess.submit(ctx, user, kv);
    case 'cm':
      await clearState(user.id);
      return confess.showComments(ctx, user, Number(a1), Number(a2) || 0);
    case 'cc':
      return confess.startComment(ctx, user, Number(a1));
    case 'cr':
      return confess.reportComment(ctx, user, Number(a1));
    case 'cxw':
      return confess.openDm(ctx, user, Number(a1));
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
    case 'ae': // a reaction to a received message (under it, or in the inbox view)
      if ((await anon.react(ctx, user, a1, a2, { inbox: parts[3] === 'i' })) && parts[3] === 'i') return inbox.showMessage(ctx, user, kv, a1);
      return null;
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
      if (a1 === 'p') return qotd.togglePush(ctx, user);
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

async function routeAdmin(ctx, user, kv, staff, action, arg, arg2) {
  const need = ADMIN_ACTIONS[action];
  if (!need) return answer(ctx, t(ctx.lang, 'e.old_button'));
  if (need !== 'any' && !can(staff, need)) return answer(ctx, t(ctx.lang, 'e.no_permission'), { alert: true });
  if (action === 'rb' && !can(staff, 'ban')) return answer(ctx, t(ctx.lang, 'e.no_permission'), { alert: true });
  switch (action) {
    case '':
    case 'x':
      await clearState(user.id);
      return admin.showPanel(ctx, kv, staff);
    case 'ch':
      return admin.showChannels(ctx, kv);
    case 'add':
      return admin.askChannel(ctx, user);
    case 'rm':
      return admin.confirmRemove(ctx, arg);
    case 'rmy':
      return admin.doRemove(ctx, kv, arg);
    case 'j':
      return admin.toggleJoin(ctx, kv, staff);
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
      await clearState(user.id); // also "cancel" while asked for the button
      return admin.showBroadcast(ctx, arg);
    case 'wk':
      await clearState(user.id);
      return admin.showClock(ctx);
    case 'wkc':
      return admin.askWakeChat(ctx, user);
    case 'wkp':
      return admin.resetWakeChat(ctx);
    case 'wkg':
      return admin.showClockGuide(ctx);
    case 'ad':
      await clearState(user.id);
      return admin.showAdmins(ctx);
    case 'adn':
      return admin.askAdmin(ctx, user);
    case 'adv':
      return admin.showAdmin(ctx, Number(arg));
    case 'adp':
      return admin.toggleAdminPerm(ctx, Number(arg), arg2);
    case 'adx':
      return admin.askRemoveAdmin(ctx, Number(arg));
    case 'adxy':
      return admin.doRemoveAdmin(ctx, Number(arg));
    case 'hl':
      await answer(ctx);
      return admin.showHealth(ctx, kv);
    case 'ai':
      await clearState(user.id);
      return admin.showAi(ctx);
    case 'aik':
      return admin.askAiKey(ctx, user);
    case 'aio':
      return admin.toggleAi(ctx);
    case 'ait':
      return admin.testAi(ctx);
    case 'aim':
      return admin.showAiModels(ctx);
    case 'aims':
      return admin.setAiModel(ctx, arg);
    case 'aimc':
      return admin.askAiModel(ctx, user);
    case 'aix':
      return admin.removeAiKey(ctx);
    case 'bca':
      return admin.setBroadcastAudience(ctx, arg, arg2);
    case 'bcb':
      return admin.askBroadcastButton(ctx, user, arg);
    case 'bcbx':
      return admin.removeBroadcastButton(ctx, arg);
    case 'cf':
      await clearState(user.id);
      return confess.showQueue(ctx, staff);
    case 'cfv':
      return confess.showForReview(ctx, staff, arg);
    case 'cfa':
      return confess.approve(ctx, staff, arg, kv);
    case 'cfr':
      return confess.reject(ctx, staff, arg);
    case 'cfb':
      return confess.rejectAndBan(ctx, staff, arg);
    case 'cfh':
      return confess.hideComment(ctx, staff, arg, kv);
    case 'cfs':
      await clearState(user.id);
      return confess.showSettings(ctx, kv);
    case 'cfsc':
      return confess.askChannel(ctx, user);
    case 'cfst':
      return confess.toggleOn(ctx, kv);
    case 'cfsx':
      return confess.removeChannel(ctx, kv);
    default:
      return answer(ctx, t(ctx.lang, 'e.old_button'));
  }
}

// ---------- the bot's own wakes, and the outside clock ----------

/** A poll changed: when it is our own wake (lib/wake.js), run a step of the due work. */
export async function onPoll(poll) {
  const ctx = createCtx({});
  try {
    if (!(await isOurWake(poll))) return result(ctx);
    ctx.wake = 'poll';
    await afterUpdate(ctx, null, { woken: true });
  } catch (err) {
    console.error('poll handler failed:', err);
    ctx.error = describeError(err);
  }
  return result(ctx);
}

/** A post in a channel the bot is in: in the wake channel, a tick of the outside clock (deleted). */
export async function onChannelPost(post) {
  const ctx = createCtx({});
  try {
    if (!post || !post.chat) return result(ctx);
    const tick = await isTickPost(post);
    if (tick) {
      ctx.wake = 'tick';
      try {
        await call(ctx, 'deleteMessage', { chat_id: post.chat.id, message_id: post.message_id }, 'tick');
      } catch (err) {
        // no right to delete: the post stays
      }
    }
    await afterUpdate(ctx, null, { woken: tick });
  } catch (err) {
    console.error('channel_post handler failed:', err);
    ctx.error = describeError(err);
  }
  return result(ctx);
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
