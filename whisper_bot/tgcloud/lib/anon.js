// Anonymous chat ("💬 پیام ناشناس"). Every user can make a personal link t.me/<bot>?start=a_<code>;
// whoever opens it can write to them (text, photo, video, voice, sticker, file…) without their name,
// username or id ever being shown. The recipient can reply — the chat goes on both ways through the
// "↩️ پاسخ" buttons, the link's visitor staying anonymous — or block the sender without learning who
// it is. Content is never stored: it is relayed straight to the other person. anon_msgs keeps only
// who-wrote-to-whom per relayed message, so buttons carry an opaque id, never a user id.
import { ANON_CODE_LEN, ANON_PER_HOUR } from './config.js';
import { botInfo, startLink } from './bot.js';
import {
  addAnonBlock, clearState, countAnonFrom, createAnonMsg, getAnonMsg, getUser, getUserByAnonCode, isAnonBlocked,
  isBlocked, markInactive, removeAnonBlock, removeAnonBlockByRef, setAnonCode, setAnonOn, setState,
} from './store.js';
import {
  answer, btn, call, describeError, editMarkup, isApiError, send, show, urlBtn,
} from './tg.js';
import { esc, fa, nowSec, randomId } from './util.js';

export const isAnonCode = (s) => typeof s === 'string' && new RegExp(`^[0-9A-Za-z]{${ANON_CODE_LEN}}$`).test(s);
const linkOf = (botUsername, code) => startLink(botUsername, `a_${code}`);
const toMenu = [btn('🔙 منو', 'm')];

/** The user's link code, made on first use. */
export async function ensureAnonCode(user) {
  if (user.anonCode) return user.anonCode;
  for (let i = 0; i < 3; i += 1) {
    const code = randomId(ANON_CODE_LEN);
    if (await setAnonCode(user.id, code)) {
      user.anonCode = code;
      return code;
    }
  }
  throw new Error('could not allocate an anonymous link code');
}

/** Has `ownerId` blocked `senderId` (whisper block list or anonymous block)? */
async function refuses(ownerId, senderId) {
  return (await isBlocked(ownerId, senderId)) || (await isAnonBlocked(ownerId, senderId));
}

// ---------- the link ----------

export async function showAnonLink(ctx, user, kv, note = '') {
  const bot = await botInfo(ctx, kv);
  const code = await ensureAnonCode(user);
  const link = linkOf(bot.username, code);
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('💬 بهم پیام ناشناس بده؛ نمی‌فهمم کی هستی 🤫')}`;
  const kb = [
    [urlBtn('📤 اشتراک‌گذاری لینک', share)],
    [btn(user.anonOn ? '📴 خاموش کردن دریافت' : '📳 روشن کردن دریافت', 'an:t'), btn('🔄 لینک جدید', 'an:new')],
    toMenu,
  ];
  return show(ctx, 'anon_link',
    `${note ? `${note}\n\n` : ''}💬 <b>لینک پیام ناشناس تو</b>\n\n`
    + 'هر کس این لینک را باز کند می‌تواند بدون اینکه بفهمی کیست به تو پیام بدهد، و تو می‌توانی جوابش را بدهی:\n\n'
    + `${link}\n\n`
    + `📨 پیام‌های ناشناس دریافتی: ${fa(user.anonCount)}\n`
    + `${user.anonOn ? '📳 دریافت پیام: روشن' : '📴 دریافت پیام: خاموش (لینک فعلاً کار نمی‌کند)'}\n\n`
    + 'لینک را در بیو، کانال یا استوری بگذار. «🔄 لینک جدید» لینک قبلی را باطل می‌کند.', kb);
}

export async function newAnonLink(ctx, user, kv) {
  user.anonCode = null;
  await ensureAnonCode(user);
  await answer(ctx, '🔄 لینک جدید ساخته شد');
  return showAnonLink(ctx, user, kv, '🔄 لینک جدید ساخته شد؛ لینک قبلی دیگر کار نمی‌کند.');
}

export async function toggleAnon(ctx, user, kv) {
  user.anonOn = !user.anonOn;
  await setAnonOn(user.id, user.anonOn);
  await answer(ctx, user.anonOn ? '📳 دریافت پیام ناشناس روشن شد' : '📴 دریافت پیام ناشناس خاموش شد');
  return showAnonLink(ctx, user, kv);
}

/** Inline mode: an article that posts "write to me anonymously" with the link as a button. */
export async function anonArticle(user, botUsername) {
  if (!botUsername || !user.anonOn) return null;
  const link = linkOf(botUsername, await ensureAnonCode(user));
  return {
    type: 'article',
    id: 'h.anon',
    title: '💬 لینک پیام ناشناس من',
    description: 'بفرست تا بقیه بدون اسم بهت پیام بدن',
    input_message_content: {
      message_text: '💬 <b>به من پیام ناشناس بده!</b>\nروی دکمه بزن و هر چه می‌خواهی بنویس؛ نمی‌فهمم کی هستی 🤫',
      parse_mode: 'HTML',
    },
    reply_markup: { inline_keyboard: [[urlBtn('✉️ ارسال پیام ناشناس', link)]] },
  };
}

// ---------- writing through a link ----------

/**
 * /start a_<code>: checks the link and remembers who the visitor is writing to (user_state, so it
 * survives the forced-join screen). Returns the link's owner, or null after showing why not.
 */
export async function openLink(ctx, user, code) {
  const owner = isAnonCode(code) ? await getUserByAnonCode(code) : null;
  if (!owner || !owner.anonOn) {
    await send(ctx, 'anon_link_invalid', '❌ این لینک ناشناس معتبر نیست یا صاحبش دریافت پیام را خاموش کرده.', [toMenu]);
    return null;
  }
  if (owner.id === user.id) {
    await send(ctx, 'anon_own_link', '🙃 این لینک خودت است! برای دیگران بفرستش تا ناشناس بهت پیام بدهند.', [[btn('💬 لینک من', 'an')], toMenu]);
    return null;
  }
  if (await refuses(owner.id, user.id)) {
    await send(ctx, 'anon_refused', '❌ این کاربر پیام‌های تو را نمی‌پذیرد.', [toMenu]);
    return null;
  }
  await setState(user.id, 'anon_send', { to: owner.id, code });
  return owner;
}

export async function promptSend(ctx, owner) {
  ctx.messageId = null;
  return send(ctx, 'anon_prompt',
    `✍️ پیامت را برای <b>${esc(owner.firstName || 'این کاربر')}</b> بفرست؛ نمی‌فهمد تو کی هستی 🤫\n\n`
    + 'متن، عکس، ویدیو، ویس، استیکر یا فایل — هر چه بفرستی همان‌طور می‌رسد.', [[btn('❌ انصراف', 'm')]]);
}

/** "✍️ پیام دیگر" after sending: the same link again. */
export async function sendAnother(ctx, user, code) {
  const owner = await openLink(ctx, user, code);
  if (!owner) return answer(ctx);
  await answer(ctx);
  return promptSend(ctx, owner);
}

// ---------- replying and blocking (buttons under a relayed message) ----------

/** "↩️ پاسخ": only the person the message was delivered to may reply to it. */
export async function startReply(ctx, user, id) {
  const row = /^[0-9A-Za-z]{10}$/.test(String(id)) ? await getAnonMsg(id) : null;
  if (!row || row.toId !== user.id) return answer(ctx, '⚠️ این پیام دیگر قابل پاسخ نیست.', { alert: true });
  if (await refuses(row.fromId, user.id)) return answer(ctx, '❌ این کاربر پیام‌های تو را نمی‌پذیرد.', { alert: true });
  await setState(user.id, 'anon_reply', { ref: row.id });
  await answer(ctx);
  ctx.messageId = null; // never replace the message being answered: send a new prompt
  const who = row.anon
    ? 'پاسخت به فرستنده‌ی ناشناس می‌رسد (او می‌داند تو کی هستی؛ تو نمی‌دانی او کیست).'
    : 'پاسخت ناشناس می‌رسد؛ نمی‌فهمد تو کی هستی 🤫';
  return send(ctx, 'anon_reply_prompt', `↩️ پاسخت را بفرست.\n${who}`, [[btn('❌ انصراف', 'm')]]);
}

/** "🚫 بلاک" / "🔓 آنبلاک" under a relayed message: toggles, without revealing who it was. */
export async function toggleBlock(ctx, user, id) {
  const row = /^[0-9A-Za-z]{10}$/.test(String(id)) ? await getAnonMsg(id) : null;
  if (!row || row.toId !== user.id) return answer(ctx, '⚠️ این پیام دیگر در دسترس نیست.', { alert: true });
  if (await isAnonBlocked(user.id, row.fromId)) {
    await removeAnonBlock(user.id, row.fromId);
    await answer(ctx, '🔓 آنبلاک شد؛ دوباره می‌تواند به تو پیام بدهد.', { alert: true });
    return editMarkup(ctx, 'anon_buttons', ctx.chatId, ctx.messageId, buttonsFor(row.id, false));
  }
  const r = await addAnonBlock(user.id, row.fromId);
  if (r === 'full') return answer(ctx, '⚠️ لیست بلاک پر است؛ از /blocks چند نفر را آنبلاک کن.', { alert: true });
  await answer(ctx, '🚫 بلاک شد؛ دیگر از این فرستنده پیامی نمی‌گیری. (از /blocks می‌شود آنبلاک کرد)', { alert: true });
  return editMarkup(ctx, 'anon_buttons', ctx.chatId, ctx.messageId, buttonsFor(row.id, true));
}

/** From the block list. */
export async function unblockRef(ctx, user, ref) {
  const ok = /^[0-9A-Za-z]{10}$/.test(String(ref)) ? await removeAnonBlockByRef(user.id, ref) : false;
  await answer(ctx, ok ? '🔓 آنبلاک شد' : 'قبلاً آنبلاک شده بود');
}

const buttonsFor = (id, blocked) => [[btn('↩️ پاسخ', `ar:${id}`), btn(blocked ? '🔓 آنبلاک' : '🚫 بلاک', `ab:${id}`)]];

// ---------- relaying ----------

/** Copies `message` to `to`; returns the delivered message_id. Throws the Bot API error. */
async function deliver(ctx, message, to, row, header) {
  const reply = row.replyTo ? { reply_parameters: { message_id: row.replyTo, allow_sending_without_reply: true } } : {};
  const kb = { inline_keyboard: buttonsFor(row.id, false) };
  if (typeof message.text === 'string' && message.text.length <= 3900) {
    const r = await call(ctx, 'sendMessage', {
      chat_id: to,
      text: `${header}\n\n${esc(message.text)}`,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
      ...reply,
    }, 'anon_deliver', { secret: true });
    return r.message_id;
  }
  // Media (or a very long text): a header, then an exact copy with the buttons under it.
  const h = await call(ctx, 'sendMessage', { chat_id: to, text: `${header} 👇`, parse_mode: 'HTML', ...reply }, 'anon_header');
  try {
    const r = await call(ctx, 'copyMessage', { chat_id: to, from_chat_id: message.chat.id, message_id: message.message_id, reply_markup: kb }, 'anon_deliver');
    return r.message_id;
  } catch (err) {
    try {
      await call(ctx, 'deleteMessage', { chat_id: to, message_id: h.message_id }, 'anon_header_undo');
    } catch {
      // best effort: a header without content is only cosmetic
    }
    throw err;
  }
}

/** The visitor's (or a replier's) message, while user_state is anon_send / anon_reply. */
export async function onAnonMessage(ctx, user, message, st) {
  let to;
  let anon;
  let replyTo = null;
  let code = null;
  if (st.state === 'anon_send') {
    const owner = await getUser(Number(st.data.to));
    if (!owner || !owner.anonOn) {
      await clearState(user.id);
      return send(ctx, 'anon_link_invalid', '❌ این لینک ناشناس دیگر فعال نیست.', [toMenu]);
    }
    to = owner.id;
    anon = true;
    code = st.data.code;
  } else {
    const prev = await getAnonMsg(String(st.data.ref || ''));
    if (!prev || prev.toId !== user.id) {
      await clearState(user.id);
      return send(ctx, 'anon_gone', '⚠️ این گفتگو دیگر در دسترس نیست.', [toMenu]);
    }
    to = prev.fromId;
    anon = !prev.anon; // the anonymous side stays anonymous in both directions
    replyTo = prev.fromMsg;
  }
  if (await refuses(to, user.id)) {
    await clearState(user.id);
    return send(ctx, 'anon_refused', '❌ این کاربر پیام‌های تو را نمی‌پذیرد.', [toMenu]);
  }
  if ((await countAnonFrom(user.id, nowSec() - 3600, ANON_PER_HOUR)) >= ANON_PER_HOUR) {
    return send(ctx, 'anon_rate_limited', `⏳ در یک ساعت حداکثر ${fa(ANON_PER_HOUR)} پیام ناشناس می‌شود فرستاد؛ کمی بعد دوباره امتحان کن.`, [toMenu]);
  }

  const id = randomId(10);
  const header = anon ? '📨 <b>پیام ناشناس جدید</b>' : `↩️ <b>پاسخ ${esc(user.username ? `@${user.username}` : user.firstName || 'صاحب لینک')}</b>`;
  let delivered;
  try {
    delivered = await deliver(ctx, message, to, { id, replyTo }, header);
  } catch (err) {
    if (isApiError(err) && err.code === 403) {
      await markInactive(to);
      await clearState(user.id);
      return send(ctx, 'anon_undelivered', '❌ پیام نرسید؛ گیرنده ربات را بلاک کرده است.', [toMenu]);
    }
    if (isApiError(err) && err.code === 400 && /copied|can't be copied|message to copy not found|MESSAGE_ID_INVALID/i.test(err.description)) {
      return send(ctx, 'anon_unsupported', '❌ این نوع پیام را نمی‌شود فرستاد؛ پیام دیگری بفرست یا /cancel.');
    }
    console.warn(`anonymous delivery failed: ${describeError(err)}`);
    return send(ctx, 'anon_undelivered', '❌ پیام نرسید؛ کمی بعد دوباره امتحان کن (یا /cancel).');
  }
  await createAnonMsg({ id, fromId: user.id, toId: to, anon, fromMsg: Number(message.message_id) || null, toMsg: delivered || null });
  await clearState(user.id);
  if (st.state === 'anon_send') {
    return send(ctx, 'anon_sent', '✅ پیامت ناشناس فرستاده شد 🤫\nاگر جواب بدهد، همین‌جا به دستت می‌رسد.',
      [[btn('✍️ پیام دیگر', `as:${code}`)], toMenu]);
  }
  return send(ctx, 'anon_sent', anon ? '✅ پاسخت ناشناس فرستاده شد 🤫' : '✅ پاسخت فرستاده شد.', [toMenu]);
}
