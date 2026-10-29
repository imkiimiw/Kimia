// Entry points for the two handlers: decide who may do what, then dispatch.
//
// Order for every update: private chat only -> load the user -> (owner panel actions: owner only)
// -> mandatory join (everyone but the owner) -> the feature.
//
// callback_data codes (all ASCII, far below 64 bytes; <b> = back context, see todo.parseBack):
//   m menu · h help · add · x cancel · n no-op · j re-check join
//   l:<page>:<cat> list · so:<page>:<cat> cycle sort · v:<id>:<b> task card
//   tl / tv:<id>:<b> toggle done (from list / card) · e:<id>:<b> edit text
//   ps:<id>:<1-3>:<b> priority · u:<id>:<b> due prompt · ud:<id>:<t|m|w|x>:<b> quick due
//   c:<id>:<b> pick category · cs:<id>:<cat>:<b> set category · cn[:<id>:<b>] new category
//   cats categories · cd / cdy:<cat> delete category (ask / yes)
//   d / dy:<id>:<b> delete task (ask / yes) · s search · sr:<page> results
//   st stats · cc / ccy clear completed (ask / yes)
//   owner: a panel · al channels · aa add · ar / ary:<id> remove (ask / yes) · at join on/off
//          ab broadcast · bs:<id> start · bn:<id> next batch · bx:<id> stop / cancel
import { STATE_TTL_SEC } from './config.js';
import { checkJoin } from './join.js';
import { answer, createCtx, describeError, send, show } from './tg.js';
import { esc, short } from './text.js';
import { ERROR_TEXT, joinScreen, menuBtn } from './ui.js';
import * as admin from './admin.js';
import * as store from './store.js';
import * as todo from './todo.js';

// Users only ever see the friendly text. The owner also sees the technical reason, so a problem on
// the platform (e.g. tables not created yet) can be diagnosed from Telegram itself.
function errorText(ctx, err) {
  if (!admin.isOwner(ctx.userId)) return ERROR_TEXT;
  return `${ERROR_TEXT}\n\n🛠 <b>جزئیات فنی (فقط برای مدیر):</b>\n<code>${esc(short(describeError(err), 300))}</code>`;
}

const int = (s) => (/^\d{1,15}$/.test(s || '') ? Number(s) : -1);

/** "/cmd@bot rest" -> { name, arg }, or null if the text isn't a command. */
export function parseCommand(text) {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1].toLowerCase(), arg: (m[2] || '').trim() } : null;
}

async function getUser(from) {
  const user = (await store.loadUser(from.id)) || (await store.createUser(from.id, from.first_name));
  if (user.state && store.nowSec() - user.stateAt > STATE_TTL_SEC) {
    await store.clearState(user.id);
    user.state = null;
  }
  return user;
}

function unknownCommand(ctx) {
  return send(ctx, 'unknown_command', '🤔 این دستور را نمی‌شناسم. برای دیدن راهنما /help را بزنید.', [[menuBtn()]]);
}

async function runCommand(ctx, user, cmd) {
  switch (cmd.name) {
    case 'start':
    case 'menu':
      return todo.showMenu(ctx, user);
    case 'help':
      return todo.showHelp(ctx);
    case 'add':
      return cmd.arg ? todo.addTaskFlow(ctx, user, cmd.arg) : todo.promptAdd(ctx, user);
    case 'list':
      return todo.showList(ctx, user, 0, 0);
    case 'search':
      return cmd.arg ? todo.searchInput(ctx, user, cmd.arg) : todo.promptSearch(ctx, user);
    case 'stats':
      return todo.showStats(ctx, user);
    case 'cats':
      return todo.showCategories(ctx, user);
    case 'cancel':
      return todo.showMenu(ctx, user, '❌ لغو شد.');
    case 'admin':
      // Owner only, by numeric id. For anyone else /admin is just an unknown command.
      return admin.isOwner(user.id) ? admin.showPanel(ctx) : unknownCommand(ctx);
    default:
      return unknownCommand(ctx);
  }
}

const hasId = (data) => Number.isInteger(data.id) && data.id > 0;

/** Text sent while the bot waits for something (user_state). */
async function stateInput(ctx, user, text) {
  switch (user.state) {
    case 'edit':
      if (hasId(user.stateData)) return todo.editInput(ctx, user, text);
      break;
    case 'due':
      if (hasId(user.stateData)) return todo.dueInput(ctx, user, text);
      break;
    case 'cat':
      return todo.categoryInput(ctx, user, text);
    case 'search':
      return todo.searchInput(ctx, user, text);
    case 'admin_add':
      if (admin.isOwner(user.id)) return admin.addChannelInput(ctx, text);
      break;
    default: // 'add', or anything unknown: the text is a new task
      break;
  }
  await store.clearState(user.id);
  return todo.addTaskFlow(ctx, user, text);
}

export async function handleMessage(message) {
  const from = message && message.from;
  if (!from || from.is_bot || !message.chat || message.chat.type !== 'private') return { ignored: true };
  const ctx = createCtx({ userId: from.id, chatId: message.chat.id, firstName: from.first_name || '' });
  try {
    const user = await getUser(from);
    const text = typeof message.text === 'string' ? message.text : null;
    const cmd = text !== null ? parseCommand(text) : null;

    if (!admin.isOwner(from.id)) {
      const join = await checkJoin(ctx, from.id);
      if (!join.ok) {
        const screen = joinScreen(join.missing, !!cmd && cmd.name === 'start');
        await send(ctx, 'join', screen.text, screen.kb);
        return { trace: ctx.trace };
      }
    }

    if (cmd) {
      if (user.state) {
        await store.clearState(user.id);
        user.state = null;
      }
      await runCommand(ctx, user, cmd);
    } else if (user.state === 'admin_bc' && admin.isOwner(user.id)) {
      await admin.broadcastInput(ctx, message); // any kind of message: text, photo, video, file, ...
    } else if (text === null) {
      await send(ctx, 'text_only', '✍️ لطفاً فقط پیام متنی بفرستید.', [[menuBtn()]]);
    } else if (user.state) {
      await stateInput(ctx, user, text);
    } else {
      await todo.addTaskFlow(ctx, user, text);
    }
  } catch (err) {
    console.error('message handler failed:', err);
    await send(ctx, 'error', errorText(ctx, err));
  }
  return { trace: ctx.trace };
}

const ROUTES = {
  m: (ctx, user) => todo.showMenu(ctx, user),
  h: (ctx) => todo.showHelp(ctx),
  add: (ctx, user) => todo.promptAdd(ctx, user),
  x: (ctx, user) => todo.showMenu(ctx, user, '❌ لغو شد.'),
  n: () => null,
  l: (ctx, user, [page, cat]) => todo.showList(ctx, user, int(page), int(cat)),
  so: (ctx, user, [page, cat]) => todo.cycleSort(ctx, user, int(page), int(cat)),
  v: (ctx, user, [id, b]) => todo.showTask(ctx, user, int(id), todo.parseBack(b)),
  tl: (ctx, user, [id, b]) => todo.toggleFromList(ctx, user, int(id), todo.parseBack(b)),
  tv: (ctx, user, [id, b]) => todo.toggleFromTask(ctx, user, int(id), todo.parseBack(b)),
  e: (ctx, user, [id, b]) => todo.promptEdit(ctx, user, int(id), todo.parseBack(b)),
  ps: (ctx, user, [id, v, b]) => todo.setPriority(ctx, user, int(id), int(v), todo.parseBack(b)),
  u: (ctx, user, [id, b]) => todo.promptDue(ctx, user, int(id), todo.parseBack(b)),
  ud: (ctx, user, [id, code, b]) => todo.quickDue(ctx, user, int(id), code, todo.parseBack(b)),
  c: (ctx, user, [id, b]) => todo.chooseCategory(ctx, user, int(id), todo.parseBack(b)),
  cs: (ctx, user, [id, cat, b]) => todo.setCategory(ctx, user, int(id), int(cat), todo.parseBack(b)),
  cn: (ctx, user, [id, b]) => todo.promptCategory(ctx, user, id === undefined ? 0 : int(id), todo.parseBack(b)),
  cats: (ctx, user) => todo.showCategories(ctx, user),
  cd: (ctx, user, [cat]) => todo.confirmDeleteCategory(ctx, user, int(cat)),
  cdy: (ctx, user, [cat]) => todo.deleteCategory(ctx, user, int(cat)),
  d: (ctx, user, [id, b]) => todo.confirmDelete(ctx, user, int(id), todo.parseBack(b)),
  dy: (ctx, user, [id, b]) => todo.deleteTask(ctx, user, int(id), todo.parseBack(b)),
  s: (ctx, user) => todo.promptSearch(ctx, user),
  sr: (ctx, user, [page]) => todo.showSearch(ctx, user, int(page)),
  st: (ctx, user) => todo.showStats(ctx, user),
  cc: (ctx, user) => todo.confirmClearDone(ctx, user),
  ccy: (ctx, user) => todo.clearDone(ctx, user),
  // owner panel (the router has already checked from.id; each function checks again)
  a: (ctx) => admin.showPanel(ctx),
  al: (ctx) => admin.showChannels(ctx),
  aa: (ctx) => admin.promptAddChannel(ctx),
  ar: (ctx, user, [id]) => admin.confirmRemoveChannel(ctx, int(id)),
  ary: (ctx, user, [id]) => admin.removeChannel(ctx, int(id)),
  at: (ctx) => admin.toggleJoin(ctx),
  ab: (ctx) => admin.promptBroadcast(ctx),
  bs: (ctx, user, [id]) => admin.beginBroadcast(ctx, int(id)),
  bn: (ctx, user, [id]) => admin.sendBatch(ctx, int(id)),
  bx: (ctx, user, [id]) => admin.stopBroadcast(ctx, int(id)),
};

async function recheckJoin(ctx, user) {
  const join = await checkJoin(ctx, user.id);
  if (join.ok) {
    await answer(ctx, '✅ عضویت شما تأیید شد. خوش آمدید!');
    return todo.showMenu(ctx, user);
  }
  await answer(ctx, '❌ هنوز در همه‌ی کانال‌ها عضو نشده‌اید. لطفاً عضو شوید و دوباره بزنید.', true);
  const screen = joinScreen(join.missing, false);
  return show(ctx, 'join', screen.text, screen.kb);
}

async function dispatchCallback(ctx, cq) {
  const parts = String(cq.data || '').split(':');
  const action = parts[0];
  if (admin.ADMIN_ACTIONS.has(action) && !admin.isOwner(ctx.userId)) {
    await answer(ctx, '⛔️ دسترسی ندارید.', true);
    return;
  }
  if (cq.message && cq.message.chat && cq.message.chat.type !== 'private') return;
  const user = await getUser(cq.from);
  if (action === 'j') {
    await recheckJoin(ctx, user);
    return;
  }
  if (!admin.isOwner(user.id)) {
    const join = await checkJoin(ctx, user.id);
    if (!join.ok) {
      await answer(ctx, '🔒 برای استفاده از ربات، اول در کانال‌ها عضو شوید.', true);
      const screen = joinScreen(join.missing, false);
      await show(ctx, 'join', screen.text, screen.kb);
      return;
    }
  }
  // Any button press ends a pending "send me ..." prompt; actions that need one set it again.
  if (user.state && action !== 'n') {
    await store.clearState(user.id);
    user.state = null;
  }
  const route = Object.prototype.hasOwnProperty.call(ROUTES, action) ? ROUTES[action] : null;
  if (!route) {
    await answer(ctx, 'این دکمه دیگر معتبر نیست.');
    await todo.showMenu(ctx, user);
    return;
  }
  await route(ctx, user, parts.slice(1));
}

export async function handleCallback(cq) {
  const from = cq && cq.from;
  if (!from) return { ignored: true };
  const msg = cq.message;
  // An inaccessible (too old) message comes with date 0 and can't be edited: answer with a new one.
  const editable = !!msg && msg.date !== 0 && !!msg.message_id;
  const ctx = createCtx({
    userId: from.id,
    chatId: msg && msg.chat ? msg.chat.id : from.id,
    firstName: from.first_name || '',
    messageId: editable ? msg.message_id : null,
    callbackId: cq.id,
  });
  try {
    await dispatchCallback(ctx, cq);
  } catch (err) {
    console.error('callback_query handler failed:', err);
    await answer(ctx, admin.isOwner(ctx.userId) ? short(`⚠️ ${describeError(err)}`, 190) : ERROR_TEXT, true);
  } finally {
    await answer(ctx); // every callback is answered exactly once
  }
  return { trace: ctx.trace };
}
