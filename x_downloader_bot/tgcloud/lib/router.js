// Entry points for the two handlers: decide who may do what, then dispatch.
//
// Order for every update: private chat only -> load/record the user -> banned? -> owner-only
// actions (by numeric id) -> mandatory join (everyone but the owner) -> the feature -> a small
// chunk of a running broadcast (there is no scheduler, so any update moves it along).
//
// callback_data codes (ASCII, far below 64 bytes; ids of posts are digit strings):
//   m menu · h help · n no-op · j re-check join
//   st settings · sq:<auto|best|low> quality · sc:<t|a|l> caption toggle · pf profile
//   hi history · r:<downloadId> resend from history
//   qp:<postId> quality picker · qv:<postId>:<item>:<key> send that quality · pd:<postId> photos as files
//   owner: a panel · al channels · aa add · ar / ary:<id> remove (ask / yes) · at join on/off
//          as stats · bb ban · bu unban · ab broadcast · bs:<id> start · bn:<id> continue · bx:<id> stop / cancel
import { STATE_TTL_SEC } from './config.js';
import { extractLinks } from './links.js';
import { checkJoin } from './join.js';
import { answer, createCtx, describeError, send, show } from './tg.js';
import { esc, nowSec, short } from './text.js';
import { ERROR_TEXT, joinScreen, menuBtn } from './ui.js';
import * as admin from './admin.js';
import * as broadcast from './broadcast.js';
import * as features from './features.js';
import * as store from './store.js';

// Users only ever see the friendly text. The owner also sees the technical reason, so a problem on
// the platform (e.g. tables not created yet) can be diagnosed from Telegram itself.
function errorText(ctx, err) {
  if (!admin.isOwner(ctx.userId)) return ERROR_TEXT;
  return `${ERROR_TEXT}\n\n🛠 <b>جزئیات فنی (فقط برای مدیر):</b>\n<code>${esc(short(describeError(err), 300))}</code>`;
}

const int = (s) => (/^\d{1,15}$/.test(s || '') ? Number(s) : -1);

/** "/cmd@bot rest" -> { name, arg }, or null if the text isn't a command. */
export function parseCommand(text) {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  return m ? { name: m[1].toLowerCase(), arg: (m[2] || '').trim() } : null;
}

async function getUser(from) {
  const user = (await store.loadUser(from.id)) || (await store.createUser(from));
  await store.touchUser(user, from);
  if (user.state && nowSec() - user.stateAt > STATE_TTL_SEC) {
    await store.clearState(user.id);
    user.state = null;
  }
  return user;
}

const BANNED_TEXT = '⛔️ دسترسی شما به این ربات مسدود شده است.';

async function runCommand(ctx, user, cmd) {
  switch (cmd.name) {
    case 'start':
    case 'menu':
      return features.showMenu(ctx, user);
    case 'help':
      return features.showHelp(ctx, user);
    case 'settings':
      return features.showSettings(ctx, user);
    case 'history':
      return features.showHistory(ctx, user);
    case 'profile':
      return features.showProfile(ctx, user);
    case 'cancel':
      return features.showMenu(ctx, user, '❌ لغو شد.');
    default:
      return send(ctx, 'unknown_command', '🤔 این دستور را نمی‌شناسم. لینک پست را بفرستید یا /help را بزنید.', [[menuBtn()]]);
  }
}

/** An owner prompt is waiting (user_state): the message is its answer. */
async function ownerStateInput(ctx, user, message, text) {
  switch (user.state) {
    case 'admin_bc':
      return admin.isOwner(user.id) ? broadcast.broadcastInput(ctx, message) : null;
    case 'admin_add':
      if (text !== null) return admin.addChannelInput(ctx, text);
      break;
    case 'admin_ban':
    case 'admin_unban':
      if (text !== null) return admin.banInput(ctx, text, user.state === 'admin_unban');
      break;
    default:
      break;
  }
  await store.clearState(user.id);
  return null;
}

export async function handleMessage(message, platformCtx = {}) {
  const from = message && message.from;
  if (!from || from.is_bot || !message.chat || message.chat.type !== 'private') return { ignored: true };
  const ctx = createCtx({ userId: from.id, chatId: message.chat.id, firstName: from.first_name || '', simulate: platformCtx.simulate || null });
  const out = {};
  try {
    const user = await getUser(from);
    const owner = admin.isOwner(from.id);
    if (user.banned && !owner) {
      await send(ctx, 'banned', BANNED_TEXT);
      return { trace: ctx.trace };
    }
    const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : null;
    const cmd = typeof message.text === 'string' ? parseCommand(message.text) : null;

    if (cmd && cmd.name === 'admin') {
      // Owner only, by numeric id (never by username), and only in a private chat (checked above).
      if (user.state) await store.clearState(user.id);
      if (owner) await admin.showPanel(ctx);
      else await send(ctx, 'admin_refused', '⛔️ این دستور فقط برای مدیر ربات است.', [[menuBtn()]]);
      return { trace: ctx.trace };
    }
    if (owner && user.state && !cmd) {
      await ownerStateInput(ctx, user, message, text);
      return { trace: ctx.trace };
    }

    if (!owner) {
      const join = await checkJoin(ctx, from.id);
      if (!join.ok) {
        const screen = joinScreen(join.missing, !!cmd && cmd.name === 'start');
        await send(ctx, 'join', screen.text, screen.kb);
        return { trace: ctx.trace };
      }
    }

    if (cmd) {
      if (user.state) await store.clearState(user.id);
      await runCommand(ctx, user, cmd);
    } else {
      const links = extractLinks(text, message.entities || message.caption_entities);
      if (links.length) {
        const r = await features.handleLinks(ctx, user, links);
        if (r && r.results) out.results = r.results.map((x) => ({ id: x.link.id, ok: x.ok, ...(x.reason ? { reason: x.reason } : {}) }));
      } else {
        await features.linkHint(ctx);
      }
    }
  } catch (err) {
    console.error('message handler failed:', err);
    await send(ctx, 'error', errorText(ctx, err));
  } finally {
    await broadcast.tick(ctx);
  }
  return { ...out, api: ctx.apiLog, trace: ctx.trace };
}

const ROUTES = {
  m: (ctx, user) => features.showMenu(ctx, user),
  h: (ctx, user) => features.showHelp(ctx, user),
  n: () => null,
  st: (ctx, user) => features.showSettings(ctx, user),
  sq: (ctx, user, [q]) => features.setQuality(ctx, user, q),
  sc: (ctx, user, [which]) => features.toggleCaption(ctx, user, which),
  pf: (ctx, user) => features.showProfile(ctx, user),
  hi: (ctx, user) => features.showHistory(ctx, user),
  r: (ctx, user, [id]) => features.resend(ctx, user, int(id)),
  qp: (ctx, user, [postId]) => features.showQualities(ctx, user, postId),
  qv: (ctx, user, [postId, item, key]) => features.sendQuality(ctx, user, postId, int(item), key),
  pd: (ctx, user, [postId]) => features.sendOriginals(ctx, user, postId),
  // owner panel (dispatchCallback has already checked from.id; each function checks again)
  a: (ctx) => admin.showPanel(ctx),
  al: (ctx) => admin.showChannels(ctx),
  aa: (ctx) => admin.promptAddChannel(ctx),
  ar: (ctx, user, [id]) => admin.confirmRemoveChannel(ctx, int(id)),
  ary: (ctx, user, [id]) => admin.removeChannel(ctx, int(id)),
  at: (ctx) => admin.toggleJoin(ctx),
  as: (ctx) => admin.showStats(ctx),
  bb: (ctx) => admin.promptBan(ctx, false),
  bu: (ctx) => admin.promptBan(ctx, true),
  ab: (ctx) => broadcast.promptBroadcast(ctx),
  bs: (ctx, user, [id]) => broadcast.beginBroadcast(ctx, int(id)),
  bn: (ctx, user, [id]) => broadcast.sendBatch(ctx, int(id)),
  bx: (ctx, user, [id]) => broadcast.stopBroadcast(ctx, int(id)),
};

async function recheckJoin(ctx, user) {
  const join = await checkJoin(ctx, user.id);
  if (join.ok) {
    await answer(ctx, '✅ عضویت شما تأیید شد. خوش آمدید!');
    return features.showMenu(ctx, user);
  }
  await answer(ctx, '❌ هنوز در همه‌ی کانال‌ها عضو نشده‌اید. لطفاً عضو شوید و دوباره بزنید.', true);
  const screen = joinScreen(join.missing, false);
  return show(ctx, 'join', screen.text, screen.kb);
}

async function dispatchCallback(ctx, cq, action, parts) {
  if (admin.ADMIN_ACTIONS.has(action) && !admin.isOwner(ctx.userId)) {
    await answer(ctx, '⛔️ دسترسی ندارید.', true);
    return;
  }
  if (cq.message && cq.message.chat && cq.message.chat.type !== 'private') {
    await answer(ctx);
    return;
  }
  const user = await getUser(cq.from);
  if (user.banned && !admin.isOwner(user.id)) {
    await answer(ctx, BANNED_TEXT, true);
    return;
  }
  if (action === 'j') {
    await recheckJoin(ctx, user);
    return;
  }
  if (!admin.isOwner(user.id)) {
    const join = await checkJoin(ctx, user.id);
    if (!join.ok) {
      await answer(ctx, '🔒 برای استفاده از ربات، اول در کانال‌ها عضو شوید.', true);
      const screen = joinScreen(join.missing, false);
      await send(ctx, 'join', screen.text, screen.kb);
      return;
    }
  }
  // Any button press ends a pending owner prompt; actions that need one set it again.
  if (user.state && action !== 'n') {
    await store.clearState(user.id);
    user.state = null;
  }
  const route = Object.prototype.hasOwnProperty.call(ROUTES, action) ? ROUTES[action] : null;
  if (!route) {
    await answer(ctx, 'این دکمه دیگر معتبر نیست.');
    await features.showMenu(ctx, user);
    return;
  }
  await route(ctx, user, parts);
}

export async function handleCallback(cq, platformCtx = {}) {
  const from = cq && cq.from;
  if (!from) return { ignored: true };
  const msg = cq.message;
  // An inaccessible (too old) message comes with date 0 and can't be edited: answer with a new one.
  const editable = !!msg && msg.date !== 0 && !!msg.message_id;
  const fromMedia = !!msg && !msg.text && !!(msg.video || msg.photo || msg.animation || msg.document || msg.caption);
  const ctx = createCtx({
    userId: from.id,
    chatId: msg && msg.chat ? msg.chat.id : from.id,
    firstName: from.first_name || '',
    messageId: editable ? msg.message_id : null,
    callbackId: cq.id,
    fromMedia,
    simulate: platformCtx.simulate || null,
  });
  const parts = String(cq.data || '').split(':');
  const action = parts.shift();
  try {
    await dispatchCallback(ctx, cq, action, parts);
  } catch (err) {
    console.error('callback_query handler failed:', err);
    // Already answered (e.g. "⏳ در حال ارسال…" before a download): say it in the chat instead.
    if (ctx.answered) await send(ctx, 'error', errorText(ctx, err));
    else await answer(ctx, admin.isOwner(ctx.userId) ? short(`⚠️ ${describeError(err)}`, 190) : ERROR_TEXT, true);
  } finally {
    await answer(ctx); // every callback is answered exactly once
    if (!['bs', 'bn', 'bx'].includes(action)) await broadcast.tick(ctx);
  }
  return { api: ctx.apiLog, trace: ctx.trace };
}
