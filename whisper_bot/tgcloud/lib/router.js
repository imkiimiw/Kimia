// Entry points for the four handlers. Each one catches everything (users never see a raw error),
// always answers a button press, and returns { trace } — every Bot API call it made — which
// `npx tgcloud run` prints.
//
// Order of checks for a private message:
//   1. /start w_<id> (read a whisper)   — no forced join, no ban check: reading is always allowed
//   2. /cancel, then a pending state     — owner: add_channel / ban / unban / bc_wait;
//                                          user: block_add, anon_send / anon_reply (anonymous chat)
//   3. banned users stop here            — the owner can't be banned
//   4. /start a_<code> (anonymous link)  — remembers the target first, so it survives the join screen
//   5. /admin                            — owner only (numeric id), private chat only
//   6. forced join                       — everyone but the owner
//   7. /start, /help, /history, /settings, /blocks, /link
//
// callback_data (all ASCII, ≤ 64 bytes):
//   s:<id>            show a whisper (inline message)       j        re-check forced join
//   m / hp            main menu / help                      h:s:<p>  sent history page, h:r:<p> received
//   d:<id>            whisper details                       n:<id>   snoopers (sender only)
//   st, st:r, st:e:<s> settings, receipts, default expiry  bl, bl:add, bk:<uid>, ub:<uid>  block list
//   an, an:t, an:new  my anonymous link, on/off, new link   as:<code> write again through a link
//   ar:<ref>, ab:<ref> reply to / (un)block an anonymous chat message   uba:<ref> unblock from the list
//   a…                owner panel: a, a:x, a:ch, a:add, a:rm:<id>, a:rmy:<id>, a:j, a:ban, a:unban,
//                     a:st, a:bc, a:bcy:<id>, a:bcn:<id>, a:bcc:<id>, a:bcs:<id>, a:bcp:<id>
import { OWNER_ID } from './config.js';
import * as admin from './admin.js';
import * as anon from './anon.js';
import { afterUpdate } from './maint.js';
import * as pm from './pm.js';
import {
  clearState, getState, getUser, loadKv, touchUser,
} from './store.js';
import {
  answer, call, createCtx, describeError, send,
} from './tg.js';
import {
  handleChosen, handleDeepRead, handleInline, handleShowButton,
} from './whisper.js';

const OWNER_STATES = new Set(['add_channel', 'ban', 'unban', 'bc_wait']);

function result(ctx) {
  const out = { trace: ctx.trace };
  if (ctx.error) out.error = ctx.error;
  if (ctx.gc) out.gc = ctx.gc;
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
    await routeMessage(ctx, message, user, kv);
  } catch (err) {
    console.error('message handler failed:', err);
    ctx.error = describeError(err);
    await send(ctx, 'error', '⚠️ خطایی پیش آمد؛ لطفاً دوباره امتحان کن.');
  } finally {
    await afterUpdate(ctx, kv);
  }
  return result(ctx);
}

async function routeMessage(ctx, message, user, kv) {
  const c = parseCommand(message.text);
  const isOwner = user.id === OWNER_ID;

  if (c && c.cmd === 'start' && /^w_[0-9A-Za-z]{8,9}$/.test(c.arg)) return handleDeepRead(ctx, message, c.arg.slice(2));

  if (c && c.cmd === 'cancel') {
    await clearState(user.id);
    return send(ctx, 'cancelled', '❌ لغو شد.', isOwner ? [[{ text: '👑 پنل مالک', callback_data: 'a' }]] : pm.mainMenu());
  }

  const st = await getState(user.id);
  if (st) {
    if (c) {
      await clearState(user.id); // a command replaces whatever the bot was waiting for
    } else if (isOwner && OWNER_STATES.has(st.state)) {
      if (st.state === 'bc_wait') return admin.onBroadcastMessage(ctx, user, message);
      if (st.state === 'add_channel') return admin.onChannelInput(ctx, user, kv, message.text);
      return admin.onBanInput(ctx, user, message.text, st.state === 'ban');
    } else if (st.state === 'block_add') {
      if (user.banned) return send(ctx, 'banned', '⛔ شما مسدود شده‌اید.');
      if (!(await pm.requireJoin(ctx, user, kv))) return null;
      return pm.onBlockInput(ctx, user, message.text);
    } else if (st.state === 'anon_send' || st.state === 'anon_reply') {
      if (user.banned && !isOwner) return send(ctx, 'banned', '⛔ شما مسدود شده‌اید.');
      if (!isOwner && !(await pm.requireJoin(ctx, user, kv))) return null;
      return anon.onAnonMessage(ctx, user, message, st);
    } else {
      await clearState(user.id);
    }
  }

  if (user.banned && !isOwner) {
    return send(ctx, 'banned', '⛔ شما از استفاده از ربات مسدود شده‌اید. (نجواهایی که برایتان فرستاده‌اند را هنوز می‌توانید بخوانید.)');
  }

  if (c && c.cmd === 'start' && /^a_/.test(c.arg)) {
    const target = await anon.openLink(ctx, user, c.arg.slice(2));
    if (!target) return null;
    if (!isOwner && !(await pm.requireJoin(ctx, user, kv))) return null; // the target waits in user_state
    return anon.promptSend(ctx, target);
  }

  if (c && c.cmd === 'admin') {
    if (!isOwner) return send(ctx, 'admin_refused', '⛔ این دستور فقط برای مالک ربات است.');
    return admin.showPanel(ctx, kv);
  }

  if (!isOwner && !(await pm.requireJoin(ctx, user, kv, { fresh: !!(c && c.cmd === 'start' && c.arg === 'join') }))) return null;

  switch (c && c.cmd) {
    case 'start':
      return pm.showWelcome(ctx, user, kv, c.arg === 'join');
    case 'help':
      return pm.showHelp(ctx, kv);
    case 'history':
      return pm.showHistory(ctx, user, 's', 0);
    case 'settings':
      return pm.showSettings(ctx, user);
    case 'blocks':
      return pm.showBlocks(ctx, user);
    case 'link':
      return anon.showAnonLink(ctx, user, kv);
    default:
      return pm.showHint(ctx);
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
    if (data.startsWith('s:')) {
      // Opening a whisper: no forced join and no ban check, the recipient must always be able to read.
      await handleShowButton(ctx, cq, data.slice(2));
      await touchUser(cq.from);
    } else {
      kv = await loadKv();
      const isPrivate = !!(msg && msg.chat && msg.chat.type === 'private');
      const user = await touchUser(cq.from, { started: isPrivate });
      await routeCallback(ctx, data, user, kv, isPrivate);
    }
  } catch (err) {
    console.error('callback handler failed:', err);
    ctx.error = describeError(err);
    await answer(ctx, '⚠️ خطایی پیش آمد؛ لطفاً دوباره امتحان کن.', { alert: true });
  } finally {
    if (!ctx.answered) await answer(ctx); // Telegram keeps the button spinning until it is answered
    await afterUpdate(ctx, kv);
  }
  return result(ctx);
}

async function routeCallback(ctx, data, user, kv, isPrivate) {
  const [head, a1, a2] = data.split(':');

  if (head === 'a') {
    if (user.id !== OWNER_ID || !isPrivate) return answer(ctx, '⛔ این بخش فقط برای مالک ربات است.', { alert: true });
    return routeAdmin(ctx, user, kv, a1 || '', a2);
  }
  if (!isPrivate) return answer(ctx, '⚠️ این دکمه فقط در پی‌وی ربات کار می‌کند.');
  if (user.banned && user.id !== OWNER_ID) return answer(ctx, '⛔ شما از استفاده از ربات مسدود شده‌اید.', { alert: true });
  if (head === 'j') return pm.recheckJoin(ctx, user, kv, afterJoin);
  // Blocking a sender is protection, so it works even before joining the channels.
  if (head === 'bk') return pm.blockUser(ctx, user, a1);
  if (head === 'ab') return anon.toggleBlock(ctx, user, a1);

  if (user.id !== OWNER_ID && !(await pm.requireJoin(ctx, user, kv))) return answer(ctx, '🔒 اول عضو کانال‌ها شو.');

  switch (head) {
    case 'm':
      await clearState(user.id);
      return pm.showWelcome(ctx, user, kv);
    case 'hp':
      return pm.showHelp(ctx, kv);
    case 'h':
      return pm.showHistory(ctx, user, a1 === 'r' ? 'r' : 's', a2);
    case 'd':
      return pm.showDetails(ctx, user, a1);
    case 'n':
      return pm.showSnoopers(ctx, user, a1);
    case 'st':
      if (a1 === 'r') return pm.toggleReceipts(ctx, user);
      if (a1 === 'e') return pm.setExpiry(ctx, user, a2);
      return pm.showSettings(ctx, user);
    case 'bl':
      if (a1 === 'add') return pm.askBlock(ctx, user);
      await clearState(user.id);
      return pm.showBlocks(ctx, user);
    case 'ub':
      return pm.unblockUser(ctx, user, a1);
    case 'uba':
      await anon.unblockRef(ctx, user, a1);
      return pm.showBlocks(ctx, user);
    case 'an':
      if (a1 === 't') return anon.toggleAnon(ctx, user, kv);
      if (a1 === 'new') return anon.newAnonLink(ctx, user, kv);
      await clearState(user.id);
      return anon.showAnonLink(ctx, user, kv);
    case 'as':
      return anon.sendAnother(ctx, user, a1);
    case 'ar':
      return anon.startReply(ctx, user, a1);
    default:
      return answer(ctx, '⚠️ این دکمه قدیمی است؛ /start را بزن.');
  }
}

/** After "✅ عضو شدم": continue an anonymous message started from a link, else the welcome. */
async function afterJoin(ctx, user, kv) {
  const st = await getState(user.id);
  if (st && st.state === 'anon_send') {
    const owner = await getUser(Number(st.data.to));
    if (owner && owner.anonOn) return anon.promptSend(ctx, owner);
  }
  return pm.showWelcome(ctx, user, kv, true);
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
      return answer(ctx, '⚠️ این دکمه قدیمی است.');
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
    await handleInline(ctx, q, user, kv);
  } catch (err) {
    console.error('inline handler failed:', err);
    ctx.error = describeError(err);
    if (!ctx.trace.some((t) => t.m === 'answerInlineQuery')) {
      try {
        await call(ctx, 'answerInlineQuery', {
          inline_query_id: q.id,
          results: [],
          cache_time: 0,
          is_personal: true,
          button: { text: '⚠️ خطایی پیش آمد؛ دوباره امتحان کن', start_parameter: 'help' },
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
