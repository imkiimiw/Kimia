/*
 * The bot's chat side. Each entry point catches everything and returns { trace } (every Bot API
 * call with its view name) for `npx tgcloud run`.
 *
 * Private messages: /start (welcome with the Play button, or the forced-join screen), /language,
 * /help, /admin (owner only — anyone else gets no response). The owner's next message may be an
 * input the panel asked for (a channel, a broadcast). Groups and channels are ignored.
 * /start <payload> is where an invitation link lands when the bot has no Main Mini App
 * (links.js): the answer is a button that opens that game — after the forced-join screen if needed.
 * Buttons: lg:<lang> (language), jc / jc:<payload> (re-check forced join), ad… / bc… (owner panel).
 * my_chat_member: a user blocking / unblocking the bot in private.
 * The bot sets its own menu button and command list (ensureSetup), so BotFather isn't needed for them.
 */
import { APP_URL, OWNER_ID } from './config.js';
import { isAdminData, ownerCallback, ownerMessage, panel } from './admin.js';
import { LANGS, t } from './i18n/index.js';
import { joinKeyboard, joinStatus } from './join.js';
import { botInfo, openButton, parsePayload } from './links.js';
import { loadRoom } from './rooms.js';
import * as store from './store.js';
import { answer, btn, createCtx, edit, esc, send, short, tryCall } from './tg.js';

function result(ctx) {
  const out = { trace: ctx.trace };
  if (ctx.error) out.error = ctx.error;
  return out;
}

function failure(ctx, err) {
  ctx.error = String((err && err.stack) || err);
  console.error(err);
}

function parseCommand(text) {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  return m ? { cmd: m[1].toLowerCase(), args: (m[2] || '').trim() } : null;
}

/* The welcome message's keyboard: Play (the Mini App), play with friends (inline mode), language. */
async function mainKeyboard(ctx, lang) {
  const play = openButton(await botInfo(ctx), t(lang, 'btn_play'));
  return [[play], [{ text: t(lang, 'btn_friends'), switch_inline_query: '' }], [btn(t(lang, 'btn_language'), 'lg')]];
}

/*
 * Once per SETUP version: the default menu button (opens the Mini App) and the command list in
 * every language — set through the Bot API, so nothing has to be done in BotFather for them.
 */
const SETUP = '1';
let setupDone = false;
export async function ensureSetup(ctx) {
  if (setupDone || !APP_URL) return;
  const s = await store.getSettings();
  if (s.setup === SETUP) {
    setupDone = true;
    return;
  }
  const commands = (lang) => ['start', 'language', 'help'].map((c) => ({ command: c, description: t(lang, `cmd_${c}`) }));
  const menu = await tryCall(ctx, 'setChatMenuButton', { menu_button: { type: 'web_app', text: t('en', 'menu_play'), web_app: { url: APP_URL } } }, 'setup-menu');
  let ok = !!menu;
  if (!(await tryCall(ctx, 'setMyCommands', { commands: commands('en') }, 'setup-commands'))) ok = false;
  for (const lang of LANGS.filter((l) => l !== 'en')) {
    if (!(await tryCall(ctx, 'setMyCommands', { commands: commands(lang), language_code: lang }, 'setup-commands'))) ok = false;
  }
  if (ok) await store.setSetting('setup', SETUP);
  setupDone = ok;
}

/* The menu button of one user's chat, in their language. */
async function localMenu(ctx, userId, lang) {
  if (!APP_URL || lang === 'en') return;
  await tryCall(ctx, 'setChatMenuButton', { chat_id: userId, menu_button: { type: 'web_app', text: t(lang, 'menu_play'), web_app: { url: APP_URL } } }, 'menu');
}

/*
 * The answer to /start <payload>: who invited the user to what, with a button that opens that game.
 */
async function openGame(ctx, user, payload, place = null) {
  const lang = user.lang;
  const p = parsePayload(payload);
  const game = t(lang, `game_${p.game}`);
  let text = t(lang, 'open_game', { game });
  if (p.room) {
    const room = await loadRoom(p.room);
    const host = room && room.game === p.game ? room.seats.find((s) => s && !s.bot && s.id !== user.user_id) : null;
    if (host) text = t(lang, 'open_invited', { name: esc(short(host.name)), game });
  }
  const rows = [[openButton(await botInfo(ctx), t(lang, 'inline_play'), payload)]];
  if (place) await edit(ctx, place, text, rows, 'open-game');
  else await send(ctx, user.user_id, text, rows, 'open-game');
}

function languageKeyboard() {
  const flags = { en: '🇬🇧', fr: '🇫🇷', ru: '🇷🇺', fa: '🇮🇷' };
  const b = (l) => btn(`${flags[l]} ${t(l, 'lang_name')}`, `lg:${l}`);
  return [[b('en'), b('fr')], [b('ru'), b('fa')]];
}

async function welcome(ctx, user, place = null) {
  const lang = user.lang;
  const text = t(lang, 'start_welcome', { name: esc(short(user.first_name || 'friend')) });
  const rows = await mainKeyboard(ctx, lang);
  if (place) await edit(ctx, place, text, rows, 'welcome');
  else await send(ctx, user.user_id, text, rows, 'welcome');
}

async function joinScreen(ctx, lang, chatId, missing, place = null, payload = '') {
  const text = t(lang, 'join_required');
  const rows = joinKeyboard(lang, missing, payload);
  if (place) await edit(ctx, place, text, rows, 'join');
  else await send(ctx, chatId, text, rows, 'join');
}

/* ---------- messages ---------- */

export async function onMessage(message) {
  const ctx = createCtx();
  try {
    await handleMessage(ctx, message);
  } catch (err) {
    failure(ctx, err);
  }
  return result(ctx);
}

async function handleMessage(ctx, message) {
  const from = message.from;
  if (!from || from.is_bot || !message.chat || message.chat.type !== 'private') return;
  const user = await store.touchUser(from, { started: true });
  const lang = user.lang;
  const command = parseCommand(message.text);
  const isOwner = from.id === OWNER_ID;
  await ensureSetup(ctx);
  if (isOwner && (await ownerMessage(ctx, lang, message, command && command.cmd))) return;
  if (command && command.cmd === 'admin') {
    if (isOwner) await panel(ctx, lang);
    return;
  }
  if (command && command.cmd === 'language') {
    await send(ctx, from.id, t(lang, 'choose_language'), languageKeyboard(), 'language');
    return;
  }
  /* /start <payload>: an invitation link (or a solo game's link) brought the user here */
  const payload = command && command.cmd === 'start' && parsePayload(command.args) ? command.args : '';
  const join = await joinStatus(ctx, from.id);
  if (!join.ok) {
    await joinScreen(ctx, lang, from.id, join.missing, null, payload);
    return;
  }
  if (payload) {
    await openGame(ctx, user, payload);
    return;
  }
  if (command && command.cmd === 'help') {
    await send(ctx, from.id, t(lang, 'help'), await mainKeyboard(ctx, lang), 'help');
    return;
  }
  if (command && command.cmd === 'start') await localMenu(ctx, from.id, lang);
  await welcome(ctx, user);
}

/* ---------- buttons ---------- */

export async function onCallback(cq) {
  const ctx = createCtx({ callbackId: cq.id });
  try {
    await handleCallback(ctx, cq);
  } catch (err) {
    failure(ctx, err);
  }
  await answer(ctx);
  return result(ctx);
}

async function handleCallback(ctx, cq) {
  const data = String(cq.data || '');
  const place = cq.message ? { chat_id: cq.message.chat.id, message_id: cq.message.message_id } : null;
  if (!place || cq.message.chat.type !== 'private') return;
  const user = await store.touchUser(cq.from);
  if (isAdminData(data)) {
    if (cq.from.id === OWNER_ID) await ownerCallback(ctx, user.lang, data, place);
    return;
  }
  if (data === 'lg') {
    await answer(ctx);
    await edit(ctx, place, t(user.lang, 'choose_language'), languageKeyboard(), 'language');
    return;
  }
  if (data.startsWith('lg:')) {
    const lang = data.slice(3);
    if (!LANGS.includes(lang)) return;
    await store.setLang(cq.from.id, lang);
    await answer(ctx, t(lang, 'language_set'));
    await tryCall(ctx, 'setChatMenuButton', { chat_id: cq.from.id, menu_button: { type: 'web_app', text: t(lang, 'menu_play'), web_app: { url: APP_URL } } }, 'menu');
    await welcome(ctx, { ...user, lang }, place);
    return;
  }
  if (data === 'jc' || data.startsWith('jc:')) {
    const payload = parsePayload(data.slice(3)) ? data.slice(3) : '';
    const join = await joinStatus(ctx, cq.from.id, { force: true });
    if (!join.ok) {
      await answer(ctx, t(user.lang, 'join_missing'), true);
      await joinScreen(ctx, user.lang, cq.from.id, join.missing, place, payload);
      return;
    }
    await answer(ctx, t(user.lang, 'join_done'));
    if (payload) await openGame(ctx, user, payload, place);
    else await welcome(ctx, user, place);
  }
}

/* ---------- blocked / unblocked ---------- */

export async function onMyChatMember(update) {
  const ctx = createCtx();
  try {
    if (update.chat && update.chat.type === 'private' && update.from) {
      const status = update.new_chat_member && update.new_chat_member.status;
      if (status === 'kicked') await store.setBlocked(update.from.id, true);
      else if (status === 'member') await store.touchUser(update.from, { started: true });
    }
  } catch (err) {
    failure(ctx, err);
  }
  return result(ctx);
}
