/*
 * The whole bot. Anyone can write to it; there are no per-user links. For every message a user
 * sends, the owner gets three messages: a "📩 new message" card (who sent it, with the buttons
 * seen / write to them / block), the message forwarded, and the message copied. Both handlers call
 * in here; each entry point catches everything and returns { trace } (every Bot API call, with its
 * view name), which `npx tgcloud run` prints.
 *
 * A private message from a user:
 *   /start, /help           → welcome; nothing goes to the owner
 *   blocked by the owner    → "you can't send messages" (once per album); nothing goes to the owner
 *   anything else           → card (once per album) + forwardMessage + copyMessage to the owner. If
 *                             the copy fails, a text notice replaces it. Every message put in the
 *                             owner's chat is saved in `links`. The user gets "✅ sent" (once per
 *                             album), or "❌ not sent" if neither the forward nor the copy arrived.
 * A private message from the owner:
 *   /start, /help                    → help, with the database status
 *   reply to any of those messages   → copied to that user, as a reply to their message;
 *                                      /block or /unblock as that reply blocks or unblocks them
 *   anything else                    → a hint: answer by replying, or with the card's buttons
 * Groups and channels are ignored.
 *
 * callback_data on the card (ASCII, ≤ 64 bytes; <mid> = the user's message id):
 *   s:<uid>:<mid>   seen: tell the user "👁 your message was seen"; the button becomes sd:
 *   sd:<uid>:<mid>  already seen (just answers)
 *   r:<uid>:<mid>   write to them: a force-reply prompt, linked to the user, whatever the owner
 *                   sends as its reply goes to them
 *   b:<uid>:<mid>   block          ub:<uid>:<mid>  unblock
 * A reply finds its user through `links`. If the row is missing (e.g. the database migration had not
 * been run yet), the card's keyboard or the forward's origin is used instead.
 *
 * Only block comments here: a paste that loses the line breaks still works.
 */
import { api, db, BotApiError } from 'sdk';
import { sql } from 'sdk/db';
import { OWNER_ID } from './config.js';

const nowSec = () => Math.floor(Date.now() / 1000);

/* Service messages in the bot's chat (a pin, a timer change, …): nothing to relay. */
const SERVICE_FIELDS = ['pinned_message', 'message_auto_delete_timer_changed', 'write_access_allowed', 'chat_background_set'];

const DB_HINT = 'دیتابیس ساخته نشده است: npx tgcloud migrate --safe (یا در BotFather بخش Database را Save و «Start Migration» کن).';

/* ---------- small helpers ---------- */

export function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  let cut = max - 1;
  const code = str.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; /* don't split a surrogate pair */
  return `${str.slice(0, cut)}…`;
}

function fullName(u) {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return name || 'بدون نام';
}

function parseCommand(text) {
  const m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+[\s\S]*)?$/.exec(String(text || '').trim());
  return m ? m[1].toLowerCase() : null;
}

function isApiError(err) {
  return err instanceof BotApiError || (!!err && typeof err.code === 'number' && typeof err.description === 'string');
}

function describeError(err) {
  if (isApiError(err)) return `${err.code} ${err.description}`;
  return String((err && err.message) || err);
}

const replyTo = (messageId) => ({ reply_parameters: { message_id: messageId, allow_sending_without_reply: true } });

/* ---------- Bot API, recorded in the trace ---------- */

function createCtx(callbackId = null) {
  return { callbackId, answered: false, trace: [] };
}

function result(ctx) {
  const out = { trace: ctx.trace };
  if (ctx.dbError) out.dbError = ctx.dbError;
  if (ctx.error) out.error = ctx.error;
  return out;
}

function keyboardSummary(markup) {
  if (!markup) return undefined;
  if (markup.force_reply) return 'force_reply';
  return markup.inline_keyboard.map((row) => row.map((b) => `${b.text} [${b.callback_data}]`));
}

/** Calls a Bot API method, records it in ctx.trace, rethrows failures. */
async function call(ctx, method, params, view) {
  const entry = { m: method };
  if (view) entry.view = view;
  if (params.chat_id !== undefined) entry.chat = params.chat_id;
  if (params.from_chat_id !== undefined) entry.from = params.from_chat_id;
  if (params.message_id !== undefined) entry.msg = params.message_id;
  if (params.text !== undefined) entry.text = params.text;
  if (params.reply_markup) entry.kb = keyboardSummary(params.reply_markup);
  ctx.trace.push(entry);
  try {
    const r = await api[method](params);
    entry.ok = true;
    if (r && r.message_id) entry.mid = r.message_id;
    return r;
  } catch (err) {
    entry.ok = false;
    entry.err = describeError(err);
    throw err;
  }
}

/** Sends an HTML text message. Never throws: returns the sent message, or null (error in ctx.lastError). */
async function send(ctx, view, chatId, text, extra = {}) {
  try {
    return await call(ctx, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    }, view);
  } catch (err) {
    ctx.lastError = err;
    console.warn(`sendMessage(${view}) failed: ${describeError(err)}`);
    return null;
  }
}

/** Answers the pressed button, once per update. Never throws. */
async function answer(ctx, text, alert = false) {
  if (!ctx.callbackId || ctx.answered) return;
  ctx.answered = true;
  const params = { callback_query_id: ctx.callbackId, text: truncate(text, 200) };
  if (alert) params.show_alert = true;
  try {
    await call(ctx, 'answerCallbackQuery', params, null);
  } catch (err) {
    console.warn(`answerCallbackQuery failed: ${describeError(err)}`);
  }
}

/* ---------- database ---------- */

/**
 * Runs a database step; a failure (most often: the migration hasn't been run, "no such table") is
 * logged and noted in the trace, and `fallback` is returned, so relaying keeps working without it.
 */
async function safe(ctx, what, fn, fallback = null) {
  try {
    return await fn();
  } catch (err) {
    console.error(`database step "${what}" failed:`, err);
    if (!ctx.dbError) ctx.dbError = `${what}: ${describeError(err)}`;
    return fallback;
  }
}

function toUser(r) {
  return {
    id: Number(r.user_id),
    firstName: r.first_name || '',
    lastName: r.last_name || '',
    username: r.username || null,
    blocked: Number(r.blocked || 0) === 1,
  };
}

function fromTelegram(from) {
  return {
    id: Number(from.id),
    firstName: String(from.first_name || '').slice(0, 64),
    lastName: String(from.last_name || '').slice(0, 64),
    username: from.username ? String(from.username) : null,
    blocked: false,
  };
}

/** Saves the user's current name and returns their row. */
async function touchUser(from) {
  const u = fromTelegram(from);
  const now = nowSec();
  const r = await db.run(sql`
    INSERT INTO users (user_id, first_name, last_name, username, first_seen, last_seen)
    VALUES (${u.id}, ${u.firstName}, ${u.lastName}, ${u.username}, ${now}, ${now})
    ON CONFLICT(user_id) DO UPDATE SET
      first_name = excluded.first_name, last_name = excluded.last_name,
      username = excluded.username, last_seen = excluded.last_seen,
      first_seen = CASE WHEN users.first_seen = 0 THEN excluded.first_seen ELSE users.first_seen END
    RETURNING *`);
  const row = (r && r.rows && r.rows[0]) || await db.get(sql`SELECT * FROM users WHERE user_id = ${u.id} LIMIT 1`);
  return row ? toUser(row) : u;
}

async function getUser(id) {
  const row = await db.get(sql`SELECT * FROM users WHERE user_id = ${id} LIMIT 1`);
  return row ? toUser(row) : null;
}

async function setBlocked(id, blocked) {
  await db.run(sql`
    INSERT INTO users (user_id, blocked) VALUES (${id}, ${blocked ? 1 : 0})
    ON CONFLICT(user_id) DO UPDATE SET blocked = excluded.blocked`);
}

/** Links messages in the owner's chat to the user's message, so replies to them reach the user. */
async function saveLinks(ownerMsgIds, userId, userMsgId) {
  const now = nowSec();
  let values = null;
  for (const id of ownerMsgIds) {
    const row = sql`(${id}, ${userId}, ${userMsgId}, ${now})`;
    values = values ? sql`${values}, ${row}` : row;
  }
  await db.run(sql`
    INSERT INTO links (owner_msg_id, user_id, user_msg_id, created_at) VALUES ${values}
    ON CONFLICT(owner_msg_id) DO UPDATE SET user_id = excluded.user_id, user_msg_id = excluded.user_msg_id`);
}

async function findLink(ownerMsgId) {
  const row = await db.get(sql`SELECT user_id, user_msg_id FROM links WHERE owner_msg_id = ${ownerMsgId} LIMIT 1`);
  return row ? { userId: Number(row.user_id), userMsgId: Number(row.user_msg_id) } : null;
}

/** Marks a card as seen. False if it already was (a double tap), so the user is told only once. */
async function claimSeen(cardId, userId, userMsgId) {
  const r = await db.run(sql`
    INSERT INTO links (owner_msg_id, user_id, user_msg_id, created_at, seen)
    VALUES (${cardId}, ${userId}, ${userMsgId}, ${nowSec()}, 1)
    ON CONFLICT(owner_msg_id) DO UPDATE SET seen = 1 WHERE links.seen = 0`);
  return r.rowsAffected > 0;
}

async function unclaimSeen(cardId) {
  await db.run(sql`UPDATE links SET seen = 0 WHERE owner_msg_id = ${cardId}`);
}

/**
 * True for a message outside an album, and for the first message of an album to get here: an
 * album arrives as one update per photo, and only one of them should send the card and notices.
 */
async function firstOfAlbum(ctx, userId, message) {
  const group = message.media_group_id;
  if (!group) return true;
  const r = await safe(ctx, 'album', () => db.run(sql`
    INSERT INTO users (user_id, last_album) VALUES (${userId}, ${String(group)})
    ON CONFLICT(user_id) DO UPDATE SET last_album = excluded.last_album
    WHERE users.last_album IS NULL OR users.last_album <> excluded.last_album`));
  return r ? r.rowsAffected > 0 : true;
}

async function databaseReady() {
  try {
    await db.get(sql`SELECT 1 AS ok FROM users LIMIT 1`);
    await db.get(sql`SELECT 1 AS ok FROM links LIMIT 1`);
    return true;
  } catch (err) {
    return false;
  }
}

/* ---------- texts and keyboards ---------- */

const USER_WELCOME = 'سلام 👋\n'
  + 'پیامت رو همین‌جا بفرست (متن، عکس، ویس، فایل، استیکر…)؛ به دست مدیر ربات می‌رسه و جوابش هم همین‌جا برات میاد.';
const USER_SENT = '✅ پیامت ارسال شد.';
const USER_FAILED = '❌ پیامت ارسال نشد؛ لطفاً کمی بعد دوباره امتحان کن.';
const USER_BLOCKED = '⛔️ امکان ارسال پیام برای شما وجود ندارد.';
const USER_SEEN = '👁 پیامت دیده شد.';

function ownerHelp(dbOk) {
  return [
    '👋 <b>سلام مدیر!</b>',
    '',
    'هر پیامی که کسی به ربات بدهد این‌طور برایت می‌آید:',
    '1️⃣ «📩 پیام جدید» با نام و آیدی فرستنده و دکمه‌ها',
    '2️⃣ همان پیام، <b>فوروارد</b>‌شده',
    '3️⃣ همان پیام، <b>کپی</b>‌شده',
    '',
    'دکمه‌ها:',
    '👁 <b>سین بزن</b>: به فرستنده اعلام می‌شود که پیامش را دیدی.',
    '✉️ <b>پیام بده</b>: هر چه بعدش بفرستی (متن، عکس، ویس، فایل، …) برای او می‌رود.',
    '⛔️ <b>بلاک</b>: دیگر پیامش به تو نمی‌رسد («✅ آنبلاک» برش می‌گرداند).',
    '',
    'روی هر کدام از این پیام‌ها <b>Reply</b> هم بزنی، جوابت برای فرستنده می‌رود. با Reply و نوشتن /block یا /unblock هم می‌شود بلاک کرد.',
    '',
    dbOk ? 'دیتابیس: ✅ آماده' : `دیتابیس: ❌ آماده نیست. ${DB_HINT}`,
  ].join('\n');
}

const OWNER_HINT = 'ℹ️ برای جواب دادن به کسی، روی پیام او <b>Reply</b> بزن یا دکمه‌ی «✉️ پیام بده» زیر «📩 پیام جدید» را بزن. راهنما: /help';
const OWNER_NO_TARGET = '⚠️ این پیام به هیچ کاربری وصل نیست. روی «📩 پیام جدید» یا پیام فورواردشده/کپی‌شده‌ی کاربر Reply بزن.';

/** "📩 New message" — who sent it. The name is a mention: tapping it opens their profile. */
function cardText(u, isAlbum) {
  const name = `<a href="tg://user?id=${u.id}">${esc(truncate(fullName(u), 64))}</a>`;
  return [
    `📩 <b>پیام جدید</b>${isAlbum ? ' (آلبوم)' : ''}`,
    `👤 ${name}${u.username ? ` · @${esc(u.username)}` : ''}`,
    `🆔 <code>${u.id}</code>`,
  ].join('\n');
}

function cardKeyboard(userId, userMsgId, { seen = false, blocked = false } = {}) {
  const k = `${userId}:${userMsgId}`;
  return {
    inline_keyboard: [
      [
        seen ? { text: '✅ سین زده شد', callback_data: `sd:${k}` } : { text: '👁 سین بزن', callback_data: `s:${k}` },
        { text: '✉️ پیام بده', callback_data: `r:${k}` },
      ],
      [blocked ? { text: '✅ آنبلاک', callback_data: `ub:${k}` } : { text: '⛔️ بلاک', callback_data: `b:${k}` }],
    ],
  };
}

/** The card's state, read from its current buttons. */
function cardState(markup) {
  const data = ((markup && markup.inline_keyboard) || []).flat().map((b) => (b && b.callback_data) || '');
  return { seen: data.some((d) => d.startsWith('sd:')), blocked: data.some((d) => d.startsWith('ub:')) };
}

const KB_DATA = /^(s|sd|r|b|ub):(\d{1,16}):(\d{1,12})$/;

/** The user a card belongs to, read from its buttons. */
function keyboardTarget(markup) {
  for (const b of ((markup && markup.inline_keyboard) || []).flat()) {
    const m = KB_DATA.exec((b && b.callback_data) || '');
    if (m) return { userId: Number(m[2]), userMsgId: Number(m[3]) };
  }
  return null;
}

/* ---------- messages ---------- */

export async function onMessage(message) {
  const ctx = createCtx();
  try {
    if (!message || !message.from || !message.chat || message.from.is_bot) return result(ctx);
    if (message.chat.type !== 'private') return result(ctx);
    if (SERVICE_FIELDS.some((f) => message[f] !== undefined)) return result(ctx);
    if (Number(message.from.id) === OWNER_ID) await ownerMessage(ctx, message);
    else await userMessage(ctx, message);
  } catch (err) {
    console.error('message handler failed:', err);
    ctx.error = describeError(err);
  }
  return result(ctx);
}

async function userMessage(ctx, message) {
  const from = message.from;
  const chatId = message.chat.id;
  const cmd = parseCommand(message.text);
  const user = await safe(ctx, 'user', () => touchUser(from), fromTelegram(from));
  if (cmd === 'start' || cmd === 'help') {
    await send(ctx, 'welcome', chatId, USER_WELCOME);
    return;
  }
  const first = await firstOfAlbum(ctx, user.id, message);
  if (user.blocked) {
    if (first) await send(ctx, 'blocked', chatId, USER_BLOCKED);
    return;
  }

  const ownerMsgIds = [];
  if (first) {
    const card = await send(ctx, 'card', OWNER_ID, cardText(user, !!message.media_group_id), {
      reply_markup: cardKeyboard(user.id, message.message_id),
    });
    if (card) ownerMsgIds.push(card.message_id);
    else if (isApiError(ctx.lastError) && ctx.lastError.code === 403) {
      /* The owner hasn't started the bot (or blocked it): nothing can reach them. */
      await send(ctx, 'failed', chatId, USER_FAILED);
      return;
    }
  }

  const source = { from_chat_id: chatId, message_id: message.message_id };
  let forwarded = null;
  let copied = null;
  let copyError = null;
  try {
    forwarded = await call(ctx, 'forwardMessage', { chat_id: OWNER_ID, ...source }, 'forward');
    ownerMsgIds.push(forwarded.message_id);
  } catch (err) {
    console.warn(`forwardMessage failed: ${describeError(err)}`);
  }
  try {
    copied = await call(ctx, 'copyMessage', { chat_id: OWNER_ID, ...source }, 'copy');
    ownerMsgIds.push(copied.message_id);
  } catch (err) {
    copyError = err;
    console.warn(`copyMessage failed: ${describeError(err)}`);
  }
  /*
   * Some messages can't be copied (a quiz, …): say so in its place. No notice when the owner's chat
   * is closed (403) or Telegram is rate-limiting it (429): that notice would fail the same way.
   */
  if (!copied && !(isApiError(copyError) && (copyError.code === 403 || copyError.code === 429))) {
    const what = forwarded ? 'کپی این پیام ممکن نشد' : 'این پیام نه فوروارد شد نه کپی';
    const notice = await send(ctx, 'copy_failed', OWNER_ID,
      `⚠️ ${what} (<code>${esc(describeError(copyError))}</code>). برای جواب دادن روی همین پیام Reply بزن.`,
      forwarded ? replyTo(forwarded.message_id) : {});
    if (notice) ownerMsgIds.push(notice.message_id);
  }
  if (ownerMsgIds.length) await safe(ctx, 'links', () => saveLinks(ownerMsgIds, user.id, message.message_id));

  if (!forwarded && !copied) await send(ctx, 'failed', chatId, USER_FAILED);
  else if (first) await send(ctx, 'sent', chatId, USER_SENT);
}

/** The user a reply in the owner's chat is meant for, or null. */
async function replyTarget(ctx, reply) {
  /*
   * Only messages the bot itself put in the owner's chat lead anywhere. (A message the owner
   * forwarded in from elsewhere has the owner as `from`: replying to it must not message that person.)
   */
  if (!reply || !reply.from || !reply.from.is_bot) return null;
  const link = await safe(ctx, 'link', () => findLink(reply.message_id));
  if (link) return link;
  const fromKeyboard = keyboardTarget(reply.reply_markup);
  if (fromKeyboard) return fromKeyboard;
  const origin = reply.forward_origin;
  if (origin && origin.type === 'user' && origin.sender_user && !origin.sender_user.is_bot) {
    return { userId: Number(origin.sender_user.id), userMsgId: 0 };
  }
  return null;
}

async function nameOf(ctx, userId) {
  const user = await safe(ctx, 'user', () => getUser(userId));
  return user ? fullName(user) : `کاربر ${userId}`;
}

async function ownerMessage(ctx, message) {
  const cmd = parseCommand(message.text);
  if (cmd === 'start' || cmd === 'help') {
    await send(ctx, 'help', OWNER_ID, ownerHelp(await databaseReady()));
    return;
  }
  const reply = message.reply_to_message;
  if (!reply) {
    if (await firstOfAlbum(ctx, OWNER_ID, message)) await send(ctx, 'hint', OWNER_ID, OWNER_HINT);
    return;
  }
  const target = await replyTarget(ctx, reply);
  if (!target || target.userId === OWNER_ID) {
    await send(ctx, 'no_target', OWNER_ID, OWNER_NO_TARGET);
    return;
  }
  const name = await nameOf(ctx, target.userId);

  if (cmd === 'block' || cmd === 'unblock') {
    const blocked = cmd === 'block';
    try {
      await setBlocked(target.userId, blocked);
    } catch (err) {
      console.error('setBlocked failed:', err);
      ctx.dbError = `block: ${describeError(err)}`;
      await send(ctx, 'db_not_ready', OWNER_ID, `⚠️ ${DB_HINT}`);
      return;
    }
    await send(ctx, blocked ? 'blocked_ok' : 'unblocked_ok', OWNER_ID, blocked
      ? `⛔️ <b>${esc(name)}</b> بلاک شد؛ دیگر پیامش به تو نمی‌رسد.`
      : `✅ <b>${esc(name)}</b> آنبلاک شد.`);
    return;
  }

  try {
    await call(ctx, 'copyMessage', {
      chat_id: target.userId,
      from_chat_id: OWNER_ID,
      message_id: message.message_id,
      ...(target.userMsgId ? replyTo(target.userMsgId) : {}),
    }, 'answer');
  } catch (err) {
    console.warn(`copyMessage to user failed: ${describeError(err)}`);
    const why = isApiError(err) && err.code === 403
      ? `<b>${esc(name)}</b> ربات را بلاک کرده یا حسابش دیگر در دسترس نیست.`
      : `<code>${esc(describeError(err))}</code>`;
    await send(ctx, 'answer_failed', OWNER_ID, `❌ ارسال نشد: ${why}`);
    return;
  }
  if (await firstOfAlbum(ctx, OWNER_ID, message)) await send(ctx, 'answer_sent', OWNER_ID, `✅ برای <b>${esc(name)}</b> ارسال شد.`);
}

/* ---------- buttons ---------- */

export async function onCallback(cq) {
  const ctx = createCtx(cq && cq.id);
  try {
    if (!cq || !cq.from || Number(cq.from.id) !== OWNER_ID) {
      await answer(ctx, '⛔️ این دکمه فقط برای مدیر ربات است.');
      return result(ctx);
    }
    const m = KB_DATA.exec(cq.data || '');
    if (!m) {
      await answer(ctx, 'این دکمه قدیمی است.');
      return result(ctx);
    }
    const action = m[1];
    const userId = Number(m[2]);
    const userMsgId = Number(m[3]);
    if (action === 's') await markSeen(ctx, cq, userId, userMsgId);
    else if (action === 'sd') await answer(ctx, '✅ قبلاً به او اعلام شده که پیامش را دیدی.');
    else if (action === 'r') await promptAnswer(ctx, cq, userId, userMsgId);
    else await toggleBlock(ctx, cq, userId, userMsgId, action === 'b');
  } catch (err) {
    console.error('callback_query handler failed:', err);
    ctx.error = describeError(err);
    await answer(ctx, '⚠️ خطایی پیش آمد؛ دوباره امتحان کن.');
  }
  return result(ctx);
}

/** Redraws the pressed card's buttons. "message is not modified" is fine (a double tap). */
async function redrawCard(ctx, cq, userId, userMsgId, change, view) {
  const msg = cq.message;
  if (!msg || !msg.chat) return;
  const state = { ...cardState(msg.reply_markup), ...change };
  try {
    await call(ctx, 'editMessageReplyMarkup', {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: cardKeyboard(userId, userMsgId, state),
    }, view);
  } catch (err) {
    if (!/message is not modified/i.test(isApiError(err) ? err.description : '')) {
      console.warn(`editMessageReplyMarkup failed: ${describeError(err)}`);
    }
  }
}

async function markSeen(ctx, cq, userId, userMsgId) {
  const cardId = cq.message ? cq.message.message_id : 0;
  /* A double tap must not tell the user twice. Without a database, the card's buttons decide. */
  const fresh = cardId ? await safe(ctx, 'seen', () => claimSeen(cardId, userId, userMsgId), true) : true;
  if (!fresh) {
    await answer(ctx, '✅ قبلاً به او اعلام شده که پیامش را دیدی.');
    await redrawCard(ctx, cq, userId, userMsgId, { seen: true }, 'card_seen');
    return;
  }
  try {
    await call(ctx, 'sendMessage', { chat_id: userId, text: USER_SEEN, ...replyTo(userMsgId) }, 'seen');
  } catch (err) {
    if (cardId) await safe(ctx, 'unseen', () => unclaimSeen(cardId));
    await answer(ctx, isApiError(err) && err.code === 403
      ? '❌ اعلام نشد: این کاربر ربات را بلاک کرده یا حسابش دیگر در دسترس نیست.'
      : `❌ اعلام نشد (${describeError(err)}).`, true);
    return;
  }
  await answer(ctx, '👁 به او اعلام شد که پیامش را دیدی.');
  await redrawCard(ctx, cq, userId, userMsgId, { seen: true }, 'card_seen');
}

async function promptAnswer(ctx, cq, userId, userMsgId) {
  const name = await nameOf(ctx, userId);
  await answer(ctx, '✍️ پیامت را بفرست.');
  const prompt = await send(ctx, 'prompt', OWNER_ID,
    `✍️ پیامت برای <b>${esc(name)}</b> را بفرست (متن، عکس، ویس، فایل، …). اگر پشیمان شدی، کافی است چیزی نفرستی.`,
    {
      reply_markup: { force_reply: true, input_field_placeholder: truncate(`پیام به ${name}`, 64) },
      ...(cq.message ? replyTo(cq.message.message_id) : {}),
    });
  if (prompt) await safe(ctx, 'links', () => saveLinks([prompt.message_id], userId, userMsgId));
}

async function toggleBlock(ctx, cq, userId, userMsgId, blocked) {
  try {
    await setBlocked(userId, blocked);
  } catch (err) {
    console.error('setBlocked failed:', err);
    ctx.dbError = `block: ${describeError(err)}`;
    await answer(ctx, `⚠️ ${DB_HINT}`, true);
    return;
  }
  await answer(ctx, blocked ? '⛔️ بلاک شد؛ دیگر پیامش به تو نمی‌رسد.' : '✅ آنبلاک شد.');
  await redrawCard(ctx, cq, userId, userMsgId, { blocked }, blocked ? 'card_blocked' : 'card_unblocked');
}
