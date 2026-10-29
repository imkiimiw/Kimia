// The whole bot. A user's message is sent to the owner twice — once forwarded, once copied — and
// the owner answers by replying to either one. Both handlers call in here; each entry point
// catches everything and returns { trace } (every Bot API call, with its view name), which
// `npx tgcloud run` prints.
//
// A private message from a user:
//   /start, /help           → welcome; nothing goes to the owner
//   blocked by the owner    → "you can't send messages" (once per album); nothing goes to the owner
//   anything else           → forwardMessage + copyMessage to the owner; the copy carries the user
//                             keyboard. If the copy fails, a text notice with that keyboard replaces it.
//                             Every message put in the owner's chat is saved in `links`. The user
//                             gets "✅ sent" (once per album), or "❌ not sent" if nothing arrived.
// A private message from the owner:
//   /start, /help                    → help, with the database status
//   reply to a relayed message       → copied to that user, as a reply to their message;
//                                      /block or /unblock as that reply blocks or unblocks them
//   anything else                    → a hint: answer by replying
// Groups and channels are ignored.
//
// callback_data on the user keyboard (ASCII, ≤ 64 bytes; <mid> = the user's message id):
//   u:<uid>:<mid>  user info (alert)      b:<uid>:<mid>  block      ub:<uid>:<mid>  unblock
// A reply finds its user through `links`. If the row is missing (e.g. the database migration had not
// been run yet), the replied-to message's own keyboard, or its forward origin, is used instead.
import { api, db, BotApiError } from 'sdk';
import { sql } from 'sdk/db';
import { OWNER_ID } from './config.js';

const nowSec = () => Math.floor(Date.now() / 1000);

// Service messages in the bot's chat (a pin, a timer change, …): nothing to relay.
const SERVICE_FIELDS = ['pinned_message', 'message_auto_delete_timer_changed', 'write_access_allowed', 'chat_background_set'];

const DB_HINT = 'در BotFather ← Serverless ← Database فایل schema.js را Save و «Start Migration» کن.';

// ---------- small helpers ----------

export function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  let cut = max - 1;
  const code = str.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // don't split a surrogate pair
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

// ---------- Bot API, recorded in the trace ----------

function createCtx(callbackId = null) {
  return { callbackId, answered: false, trace: [] };
}

function result(ctx) {
  const out = { trace: ctx.trace };
  if (ctx.dbError) out.dbError = ctx.dbError;
  if (ctx.error) out.error = ctx.error;
  return out;
}

/** Calls a Bot API method, records it in ctx.trace, rethrows failures. */
async function call(ctx, method, params, view) {
  const entry = { m: method };
  if (view) entry.view = view;
  if (params.chat_id !== undefined) entry.chat = params.chat_id;
  if (params.from_chat_id !== undefined) entry.from = params.from_chat_id;
  if (params.message_id !== undefined) entry.msg = params.message_id;
  if (params.text !== undefined) entry.text = params.text;
  if (params.reply_markup) entry.kb = params.reply_markup.inline_keyboard.map((row) => row.map((b) => `${b.text} [${b.callback_data}]`));
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

/** Sends an HTML text message. Never throws: returns the sent message, or null. */
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

// ---------- database ----------

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
    firstSeen: Number(r.first_seen || 0),
    messages: Number(r.messages || 0),
    blocked: Number(r.blocked || 0) === 1,
  };
}

function fromTelegram(from) {
  return {
    id: Number(from.id),
    firstName: String(from.first_name || '').slice(0, 64),
    lastName: String(from.last_name || '').slice(0, 64),
    username: from.username ? String(from.username) : null,
    firstSeen: 0,
    messages: 0,
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

/** Links every message the bot put in the owner's chat to the user's message, and counts it. */
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
  await db.run(sql`UPDATE users SET messages = messages + 1 WHERE user_id = ${userId}`);
}

async function findLink(ownerMsgId) {
  const row = await db.get(sql`SELECT user_id, user_msg_id FROM links WHERE owner_msg_id = ${ownerMsgId} LIMIT 1`);
  return row ? { userId: Number(row.user_id), userMsgId: Number(row.user_msg_id) } : null;
}

/**
 * True for a message outside an album, and for the first message of an album to get here: an
 * album arrives as one update per photo, and only one of them should send a notice.
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

// ---------- texts and keyboards ----------

const USER_WELCOME = 'سلام 👋\n'
  + 'هر پیامی اینجا بفرستی (متن، عکس، ویس، فایل، استیکر…) به دست مدیر ربات می‌رسه و جوابش هم همین‌جا برات میاد.';
const USER_SENT = '✅ پیامت ارسال شد.';
const USER_FAILED = '❌ پیامت ارسال نشد؛ لطفاً کمی بعد دوباره امتحان کن.';
const USER_BLOCKED = '⛔️ امکان ارسال پیام برای شما وجود ندارد.';

function ownerHelp(dbOk) {
  return [
    '👋 <b>سلام مدیر!</b>',
    '',
    '• هر پیامی که کاربران به ربات بدهند، یک بار <b>فوروارد</b> و یک بار <b>کپی</b> برایت می‌آید.',
    '• برای جواب دادن، روی هر کدام از آن دو پیام <b>Reply</b> بزن و جوابت را بفرست. هر نوع پیامی (متن، عکس، ویس، فایل، استیکر…) همان‌طور برای کاربر می‌رود.',
    '• زیر پیام کپی‌شده: «👤 نام» اطلاعات کاربر را نشان می‌دهد و «⛔️ مسدود کردن» او را بلاک می‌کند.',
    '• یا روی پیام کاربر Reply بزن و بنویس /block یا /unblock.',
    '',
    dbOk
      ? 'دیتابیس: ✅ آماده'
      : `دیتابیس: ❌ آماده نیست. ${DB_HINT} تا آن موقع جواب دادن فقط با Reply روی پیام کپی‌شده کار می‌کند و مسدود کردن کار نمی‌کند.`,
  ].join('\n');
}

const OWNER_HINT = 'ℹ️ برای جواب دادن به یک کاربر، روی پیام فورواردشده یا کپی‌شده‌ی او <b>Reply</b> بزن. راهنما: /help';
const OWNER_NO_TARGET = '⚠️ این پیام به هیچ کاربری وصل نیست. روی پیام فورواردشده یا کپی‌شده‌ی کاربر Reply بزن.';

/** The keyboard under the copy: who sent it, and block / unblock. */
function userKeyboard(u, userMsgId) {
  const label = `👤 ${truncate(fullName(u), 32)} · ${u.username ? `@${u.username}` : u.id}`;
  return {
    inline_keyboard: [
      [{ text: label, callback_data: `u:${u.id}:${userMsgId}` }],
      [blockButton(u.id, userMsgId, u.blocked)],
    ],
  };
}

function blockButton(userId, userMsgId, blocked) {
  return blocked
    ? { text: '✅ رفع مسدودی', callback_data: `ub:${userId}:${userMsgId}` }
    : { text: '⛔️ مسدود کردن', callback_data: `b:${userId}:${userMsgId}` };
}

const KB_DATA = /^(u|b|ub):(\d{1,16}):(\d{1,12})$/;

/** The user a message with our keyboard belongs to, read from its buttons. */
function keyboardTarget(markup) {
  const rows = (markup && markup.inline_keyboard) || [];
  for (const row of rows) {
    for (const b of row) {
      const m = KB_DATA.exec((b && b.callback_data) || '');
      if (m) return { userId: Number(m[2]), userMsgId: Number(m[3]) };
    }
  }
  return null;
}

// ---------- messages ----------

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
  const cmd = parseCommand(message.text);
  const user = await safe(ctx, 'user', () => touchUser(from), fromTelegram(from));
  if (cmd === 'start' || cmd === 'help') {
    await send(ctx, 'welcome', from.id, USER_WELCOME);
    return;
  }
  if (user.blocked) {
    if (await firstOfAlbum(ctx, from.id, message)) await send(ctx, 'blocked', from.id, USER_BLOCKED);
    return;
  }

  const kb = userKeyboard(user, message.message_id);
  const source = { from_chat_id: from.id, message_id: message.message_id };
  let forwarded = null;
  let copied = null;
  let copyError = null;
  try {
    forwarded = await call(ctx, 'forwardMessage', { chat_id: OWNER_ID, ...source }, 'forward');
  } catch (err) {
    console.warn(`forwardMessage failed: ${describeError(err)}`);
  }
  try {
    copied = await call(ctx, 'copyMessage', { chat_id: OWNER_ID, ...source, reply_markup: kb }, 'copy');
  } catch (err) {
    copyError = err;
    console.warn(`copyMessage failed: ${describeError(err)}`);
  }

  const ownerMsgIds = [];
  if (forwarded) ownerMsgIds.push(forwarded.message_id);
  if (copied) ownerMsgIds.push(copied.message_id);
  // Some messages can't be copied (a quiz, …); the owner still gets the user keyboard and a message
  // to reply to. No notice when the owner's chat is closed (403: they haven't started the bot) or
  // Telegram is rate-limiting it (429): that notice would fail the same way.
  if (!copied && !(isApiError(copyError) && (copyError.code === 403 || copyError.code === 429))) {
    const what = forwarded ? 'کپی این پیام ممکن نشد' : 'پیامی از این کاربر رسید ولی نه فوروارد شد نه کپی';
    const notice = await send(ctx, 'copy_failed', OWNER_ID,
      `⚠️ ${what} (<code>${esc(describeError(copyError))}</code>). برای جواب دادن روی همین پیام Reply بزن.`,
      {
        reply_markup: kb,
        ...(forwarded ? { reply_parameters: { message_id: forwarded.message_id, allow_sending_without_reply: true } } : {}),
      });
    if (notice) ownerMsgIds.push(notice.message_id);
  }
  if (ownerMsgIds.length) await safe(ctx, 'links', () => saveLinks(ownerMsgIds, from.id, message.message_id));

  if (forwarded || copied) {
    if (await firstOfAlbum(ctx, from.id, message)) await send(ctx, 'sent', from.id, USER_SENT);
  } else {
    await send(ctx, 'failed', from.id, USER_FAILED);
  }
}

/** The user a reply in the owner's chat is meant for, or null. */
async function replyTarget(ctx, reply) {
  // Only messages the bot itself put in the owner's chat lead anywhere. (A message the owner
  // forwarded in from elsewhere has the owner as `from`: replying to it must not message that person.)
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
  const user = await safe(ctx, 'user', () => getUser(target.userId));
  const name = user ? fullName(user) : `کاربر ${target.userId}`;

  if (cmd === 'block' || cmd === 'unblock') {
    const blocked = cmd === 'block';
    try {
      await setBlocked(target.userId, blocked);
    } catch (err) {
      console.error('setBlocked failed:', err);
      ctx.dbError = `block: ${describeError(err)}`;
      await send(ctx, 'db_not_ready', OWNER_ID, `⚠️ دیتابیس آماده نیست. ${DB_HINT}`);
      return;
    }
    await send(ctx, blocked ? 'blocked_ok' : 'unblocked_ok', OWNER_ID, blocked
      ? `⛔️ <b>${esc(name)}</b> مسدود شد؛ دیگر پیامش به تو نمی‌رسد.`
      : `✅ <b>${esc(name)}</b> از مسدودی درآمد.`);
    return;
  }

  try {
    await call(ctx, 'copyMessage', {
      chat_id: target.userId,
      from_chat_id: OWNER_ID,
      message_id: message.message_id,
      ...(target.userMsgId ? { reply_parameters: { message_id: target.userMsgId, allow_sending_without_reply: true } } : {}),
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

// ---------- buttons ----------

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
    if (action === 'u') await showInfo(ctx, userId);
    else await toggleBlock(ctx, cq, userId, userMsgId, action === 'b');
  } catch (err) {
    console.error('callback_query handler failed:', err);
    ctx.error = describeError(err);
    await answer(ctx, '⚠️ خطایی پیش آمد؛ دوباره امتحان کن.');
  }
  return result(ctx);
}

async function showInfo(ctx, userId) {
  const user = await safe(ctx, 'user', () => getUser(userId));
  if (!user) {
    const why = ctx.dbError ? '⚠️ دیتابیس آماده نیست (Start Migration).' : 'اطلاعات بیشتری ثبت نشده.';
    await answer(ctx, `🆔 ${userId}\n${why}`, true);
    return;
  }
  const lines = [
    `👤 ${truncate(fullName(user), 60)}`,
    `🆔 ${user.id}`,
    user.username ? `📛 @${user.username}` : '📛 بدون یوزرنیم',
    `✉️ پیام‌ها: ${user.messages}`,
  ];
  if (user.firstSeen) lines.push(`📅 اولین پیام: ${new Date(user.firstSeen * 1000).toISOString().slice(0, 10)}`);
  lines.push(user.blocked ? 'وضعیت: ⛔️ مسدود' : 'وضعیت: ✅ آزاد');
  await answer(ctx, lines.join('\n'), true);
}

async function toggleBlock(ctx, cq, userId, userMsgId, blocked) {
  try {
    await setBlocked(userId, blocked);
  } catch (err) {
    console.error('setBlocked failed:', err);
    ctx.dbError = `block: ${describeError(err)}`;
    await answer(ctx, `⚠️ دیتابیس آماده نیست. ${DB_HINT}`, true);
    return;
  }
  await answer(ctx, blocked ? '⛔️ مسدود شد؛ دیگر پیامش به تو نمی‌رسد.' : '✅ از مسدودی درآمد.');
  const msg = cq.message;
  if (!msg || !msg.chat) return;
  // Keep the pressed message's first row (the sender's name) and flip the block button.
  const rows = (msg.reply_markup && msg.reply_markup.inline_keyboard) || [];
  const first = rows[0] && rows[0][0] && KB_DATA.test(rows[0][0].callback_data || '')
    ? rows[0]
    : [{ text: `👤 ${userId}`, callback_data: `u:${userId}:${userMsgId}` }];
  try {
    await call(ctx, 'editMessageReplyMarkup', {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: { inline_keyboard: [first, [blockButton(userId, userMsgId, blocked)]] },
    }, blocked ? 'kb_blocked' : 'kb_unblocked');
  } catch (err) {
    if (!/message is not modified/i.test(isApiError(err) ? err.description : '')) {
      console.warn(`editMessageReplyMarkup failed: ${describeError(err)}`);
    }
  }
}
