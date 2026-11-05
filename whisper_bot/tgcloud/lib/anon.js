// Anonymous messages ("💬 پیام ناشناس"). Every user has a personal link t.me/<bot>?start=a_<code>.
// Whoever opens it sees the owner's limited profile — the link photo with "you're sending a message to
// <name>", the average star rating, the bio and the link's question — picks a category if they want,
// and writes (text or any media). The recipient gets it without the sender's name, username or id —
// not in the text, not in callback_data (buttons carry an opaque message id) — and can reply (the
// chat goes on both ways, the visitor staying anonymous), block, or report it to the bot's owner.
//
// Protection (what users of other anonymous bots complain about): no fake or bot-written messages,
// no paid "hints" or reveal — nobody, the owner included, is ever shown who sent a message; filters
// (offensive words in fa/en/ru, links, the user's own words) hide messages into a "filtered" folder
// instead of delivering them; per-sender rate limits and duplicate detection; senders blocked or
// reported by several people are restricted automatically; a link can be paused or replaced at once.
import {
  ANON_CODE_LEN, ANON_MAX_LEN, CATEGORIES, OWNER_ID, PICKABLE_CATEGORIES,
} from './config.js';
import {
  addAnonBlock, addStrike, createAnonMsg, createReport, deleteMsg, getAnonMsg, getRating, getUserByAnonCode,
  isAnonBlocked, listWords, removeAnonBlock, removeAnonBlockByRef, setAnonCode, setDelivered, setRating, touchSent,
} from './astore.js';
import { botInfo, startLink } from './bot.js';
import { filterReason, normalize } from './filter.js';
import {
  avg, dur, langOf, num, t,
} from './i18n.js';
import { questionOf } from './qotd.js';
import { spamCheck } from './spam.js';
import {
  clearState, getState, getUser, isBlocked, markInactive, setState, setUserField,
} from './store.js';
import {
  answer, btn, call, describeError, editMarkup, isApiError, send, sendMedia, show, urlBtn,
} from './tg.js';
import {
  esc, hash32, nowSec, randomId,
} from './util.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);
const N = (ctx, n) => num(ctx.lang, n);

export const isAnonCode = (s) => typeof s === 'string' && new RegExp(`^[0-9A-Za-z]{${ANON_CODE_LEN}}$`).test(s);
const isRef = (s) => /^[0-9A-Za-z]{10}$/.test(String(s));
export const linkOf = (botUsername, code) => startLink(botUsername, `a_${code}`);
export const catLabel = (lang, cat) => `${CATEGORIES[cat] || CATEGORIES.g} ${t(lang, `cat.${CATEGORIES[cat] ? cat : 'g'}`)}`;
export const displayNameOf = (u, lang) => u.pName || u.firstName || t(lang, 'a.someone');

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
export async function refuses(ownerId, senderId) {
  return (await isBlocked(ownerId, senderId)) || (await isAnonBlocked(ownerId, senderId));
}

/** "⭐️ 4.6 / 5 (23 ratings)" in `lang`, or the "no ratings yet" line. */
export function ratingLine(lang, u) {
  if (!u.ratingCount) return t(lang, 'a.rating_none');
  return t(lang, 'a.rating', { avg: avg(lang, u.ratingSum, u.ratingCount), n: num(lang, u.ratingCount) });
}

// ---------- the section and the link ----------

export async function showSection(ctx, user, kv) {
  const bot = await botInfo(ctx, kv);
  const code = await ensureAnonCode(user);
  const q = questionOf(user);
  const lines = [
    T(ctx, 'a.section_title'),
    '',
    T(ctx, 'a.your_link', { link: linkOf(bot.username, code) }),
    T(ctx, 'a.inbox_line', { unread: N(ctx, user.anonUnread), total: N(ctx, user.inboxSize) }),
    ratingLine(ctx.lang, user),
  ];
  if (q) lines.push(T(ctx, 'a.question_line', { q: esc(q) }));
  if (!user.anonOn) lines.push(T(ctx, 'a.paused_line'));
  const unread = user.anonUnread ? ` (${N(ctx, user.anonUnread)})` : '';
  const kb = [
    [btn(T(ctx, 'a.btn_link'), 'al'), btn(`${T(ctx, 'a.btn_inbox')}${unread}`, 'ib:0:-:0')],
    [btn(T(ctx, 'a.btn_qotd'), 'qd'), btn(T(ctx, 'a.btn_card'), 'cd')],
    [btn(T(ctx, 'a.btn_profile'), 'pf'), btn(T(ctx, 'a.btn_filters'), 'fs')],
    [btn(T(ctx, 'a.btn_settings'), 'as'), btn(T(ctx, 'btn.home'), 'm')],
  ];
  return show(ctx, 'anon_section', lines.join('\n'), kb);
}

export async function showAnonLink(ctx, user, kv, note = '') {
  const bot = await botInfo(ctx, kv);
  const code = await ensureAnonCode(user);
  const link = linkOf(bot.username, code);
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(T(ctx, 'a.share_text'))}`;
  const kb = [
    [urlBtn(T(ctx, 'a.btn_share'), share), btn(T(ctx, 'a.btn_card'), 'cd')],
    [btn(T(ctx, user.anonOn ? 'a.btn_pause' : 'a.btn_resume'), 'al:t'), btn(T(ctx, 'a.btn_new_link'), 'al:new')],
    [btn(T(ctx, 'btn.back'), 'an')],
  ];
  return show(ctx, 'anon_link', `${note ? `${note}\n\n` : ''}${T(ctx, 'a.link_text', {
    link,
    count: N(ctx, user.anonCount),
    state: T(ctx, user.anonOn ? 'a.state_on' : 'a.state_off'),
  })}`, kb);
}

/** A new code: the old link stops working at once. */
export async function renewLink(ctx, user) {
  user.anonCode = null;
  await ensureAnonCode(user);
  await answer(ctx, T(ctx, 'a.new_link_done'), { alert: true });
}

/** Pause (true) or resume (false) receiving new messages through the link. */
export async function setPaused(ctx, user, pause) {
  user.anonOn = !pause;
  await setUserField(user.id, 'anon_on', user.anonOn ? 1 : 0);
  await answer(ctx, T(ctx, user.anonOn ? 'a.resumed' : 'a.paused'));
}

export async function newAnonLink(ctx, user, kv) {
  await renewLink(ctx, user);
  return showAnonLink(ctx, user, kv, T(ctx, 'a.new_link_note'));
}

export async function toggleAnon(ctx, user, kv) {
  await setPaused(ctx, user, user.anonOn);
  return showAnonLink(ctx, user, kv);
}

/** "🔓" next to an anonymous sender in the block list (by ref: the list never shows who). */
export async function unblockByRef(ctx, user, ref) {
  const ok = isRef(ref) ? await removeAnonBlockByRef(user.id, ref) : false;
  await answer(ctx, T(ctx, ok ? 'a.unblocked' : 'a.gone'));
}

/** Inline mode: an article that posts "write to me anonymously" with the link as a button. */
export async function anonArticle(user, botUsername, lang) {
  if (!botUsername || !user.anonOn) return null;
  const link = linkOf(botUsername, await ensureAnonCode(user));
  return {
    type: 'article',
    id: 'h.anon',
    title: t(lang, 'a.inline_title'),
    description: t(lang, 'a.inline_desc'),
    input_message_content: { message_text: t(lang, 'a.inline_message'), parse_mode: 'HTML' },
    reply_markup: { inline_keyboard: [[urlBtn(t(lang, 'a.inline_btn'), link)]] },
  };
}

// ---------- a visitor opens a link ----------

/** The category keyboard under the profile card; `selected` is marked. */
function cardKeyboard(ctx, code, selected, hasQuestion) {
  const cats = hasQuestion ? ['d', ...PICKABLE_CATEGORIES.filter((c) => c !== 'g')] : PICKABLE_CATEGORIES;
  const b = (c) => btn(`${c === selected ? '✅ ' : ''}${catLabel(ctx.lang, c)}`, `ac:${c}`);
  const rows = [];
  for (let i = 0; i < cats.length; i += 3) rows.push(cats.slice(i, i + 3).map(b));
  rows.push([btn(T(ctx, 'a.btn_rate'), `rt:${code}`), btn(T(ctx, 'btn.cancel'), 'm')]);
  return rows;
}

/**
 * /start a_<code>: checks the link, remembers who the visitor is writing to (user_state, so it
 * survives the forced-join screen). Returns the link's owner, or null after showing why not.
 */
export async function openLink(ctx, user, code) {
  const owner = isAnonCode(code) ? await getUserByAnonCode(code) : null;
  if (!owner || !owner.anonOn || owner.banned) {
    await send(ctx, 'anon_link_invalid', T(ctx, 'a.link_invalid'), [[btn(T(ctx, 'btn.home'), 'm')]]);
    return null;
  }
  if (owner.id === user.id) {
    await send(ctx, 'anon_own_link', T(ctx, 'a.own_link'), [[btn(T(ctx, 'a.btn_link'), 'al')], [btn(T(ctx, 'btn.home'), 'm')]]);
    return null;
  }
  if (await refuses(owner.id, user.id)) {
    await send(ctx, 'anon_refused', T(ctx, 'a.refused'), [[btn(T(ctx, 'btn.home'), 'm')]]);
    return null;
  }
  const q = questionOf(owner);
  await setState(user.id, 'anon_send', { to: owner.id, code, cat: q ? 'd' : 'g', q: q || null });
  return owner;
}

/** What a visitor of `owner`'s link reads (in the visitor's `lang`): the limited public profile. */
export function profileCaption(lang, owner, q) {
  const lines = [t(lang, 'a.writing_to', { name: esc(displayNameOf(owner, lang)) })];
  if (owner.showRating) lines.push(ratingLine(lang, owner));
  if (owner.pBio) lines.push(`📝 ${esc(owner.pBio)}`);
  if (q) lines.push(t(lang, 'a.question_line', { q: esc(q) }));
  lines.push('', t(lang, 'a.write_now'));
  if (owner.aText) lines.push(t(lang, 'a.text_only_note'));
  return lines.join('\n');
}

/** The profile card a visitor sees: photo + "you're writing to <name>", rating, bio, question. */
export async function showProfileCard(ctx, owner, st) {
  ctx.messageId = null;
  const caption = profileCaption(ctx.lang, owner, st.q);
  const kb = cardKeyboard(ctx, st.code, st.cat, !!st.q);
  if (owner.pPhoto) {
    const r = await sendMedia(ctx, 'anon_profile', 'photo', owner.pPhoto, caption, kb);
    if (r) return r;
  }
  return send(ctx, 'anon_profile', caption, kb);
}

/** "ac:<cat>": the visitor picks a category for the message they're about to write. */
export async function pickCategory(ctx, user, cat) {
  const st = await getState(user.id);
  if (!st || st.state !== 'anon_send') return answer(ctx, T(ctx, 'a.open_again'), { alert: true });
  if (cat !== '-' && (CATEGORIES[cat] && (PICKABLE_CATEGORIES.includes(cat) || (cat === 'd' && st.data.q)))) st.data.cat = cat;
  await setState(user.id, 'anon_send', st.data);
  await answer(ctx, cat === '-' ? '' : T(ctx, 'a.cat_set', { cat: catLabel(ctx.lang, st.data.cat) }));
  return editMarkup(ctx, 'anon_profile_kb', ctx.chatId, ctx.messageId, cardKeyboard(ctx, st.data.code, st.data.cat, !!st.data.q));
}

/** "rt:<code>" shows the stars; "rt:<code>:<n>" rates the link's owner (one rating per person, changeable). */
export async function rate(ctx, user, code, stars) {
  const owner = isAnonCode(code) ? await getUserByAnonCode(code) : null;
  if (!owner) return answer(ctx, T(ctx, 'a.link_invalid'), { alert: true });
  if (owner.id === user.id) return answer(ctx, T(ctx, 'a.rate_self'), { alert: true });
  if (!stars) {
    const mine = await getRating(owner.id, user.id);
    await answer(ctx, mine ? T(ctx, 'a.rate_current', { n: N(ctx, mine) }) : T(ctx, 'a.rate_pick'));
    const row = [1, 2, 3, 4, 5].map((n) => btn(`${n === mine ? '✅' : ''}${N(ctx, n)}⭐️`, `rt:${code}:${n}`));
    return editMarkup(ctx, 'anon_rate_kb', ctx.chatId, ctx.messageId, [row, [btn(T(ctx, 'btn.back'), 'ac:-')]]);
  }
  const n = Number(stars);
  if (!(n >= 1 && n <= 5)) return answer(ctx, T(ctx, 'common.invalid'));
  const totals = await setRating(owner.id, user.id, n);
  await answer(ctx, T(ctx, 'a.rated', { n: N(ctx, n), avg: avg(ctx.lang, totals.sum, totals.count), count: N(ctx, totals.count) }), { alert: true });
  const st = await getState(user.id);
  if (st && st.state === 'anon_send' && st.data.to === owner.id) {
    return editMarkup(ctx, 'anon_profile_kb', ctx.chatId, ctx.messageId, cardKeyboard(ctx, st.data.code, st.data.cat, !!st.data.q));
  }
  return editMarkup(ctx, 'anon_profile_kb', ctx.chatId, ctx.messageId, [[btn(T(ctx, 'a.btn_write'), `aw:${code}`)]]);
}

/** "✍️ پیام دیگر" / "✍️ بنویس": the same link again. */
export async function writeAgain(ctx, user, code) {
  const owner = await openLink(ctx, user, code);
  await answer(ctx);
  if (!owner) return null;
  return showProfileCard(ctx, owner, (await getState(user.id)).data);
}

// ---------- replying, blocking and reporting (buttons under a delivered message) ----------

/** "↩️ پاسخ": only the person the message was delivered to may reply to it. */
export async function startReply(ctx, user, id) {
  const row = isRef(id) ? await getAnonMsg(id) : null;
  if (!row || row.toId !== user.id) return answer(ctx, T(ctx, 'a.cant_reply'), { alert: true });
  if (await refuses(row.fromId, user.id)) return answer(ctx, T(ctx, 'a.refused'), { alert: true });
  await setState(user.id, 'anon_reply', { ref: row.id });
  await answer(ctx);
  ctx.messageId = null; // never replace the message being answered: send a new prompt
  return send(ctx, 'anon_reply_prompt', T(ctx, row.anon ? 'a.reply_prompt_owner' : 'a.reply_prompt_visitor'), [[btn(T(ctx, 'btn.cancel'), 'm')]]);
}

/** The buttons under a delivered message, in the recipient's language. */
export function deliveredButtons(lang, id, blocked = false) {
  return [
    [btn(t(lang, 'a.btn_reply'), `ar:${id}`), btn(t(lang, blocked ? 'a.btn_unblock' : 'a.btn_block'), `ab:${id}`)],
    [btn(t(lang, 'a.btn_report'), `ap:${id}`), btn(t(lang, 'a.btn_more'), `iv:${id}`)],
  ];
}

/** "🚫 بلاک" / "🔓 آنبلاک" under a message: toggles, without revealing who it was. */
export async function toggleBlock(ctx, user, id, { fromInbox = false } = {}) {
  const row = isRef(id) ? await getAnonMsg(id) : null;
  if (!row || row.toId !== user.id) return answer(ctx, T(ctx, 'a.gone'), { alert: true });
  if (await isAnonBlocked(user.id, row.fromId)) {
    await removeAnonBlock(user.id, row.fromId);
    await answer(ctx, T(ctx, 'a.unblocked'), { alert: true });
    return fromInbox ? null : editMarkup(ctx, 'anon_buttons', ctx.chatId, ctx.messageId, deliveredButtons(ctx.lang, row.id, false));
  }
  const r = await addAnonBlock(user.id, row.fromId);
  if (r === 'full') return answer(ctx, T(ctx, 'a.block_full'), { alert: true });
  if (r === 'ok' && row.anon) await addStrike(row.fromId, user.id);
  await answer(ctx, T(ctx, 'a.blocked'), { alert: true });
  return fromInbox ? null : editMarkup(ctx, 'anon_buttons', ctx.chatId, ctx.messageId, deliveredButtons(ctx.lang, row.id, true));
}

/** "🚩 گزارش": asks first — the report shares this message's content with the bot's owner. */
export async function askReport(ctx, user, id) {
  const row = isRef(id) ? await getAnonMsg(id) : null;
  if (!row || row.toId !== user.id) return answer(ctx, T(ctx, 'a.gone'), { alert: true });
  await answer(ctx);
  ctx.messageId = null;
  return send(ctx, 'anon_report_ask', T(ctx, 'a.report_ask'), [[btn(T(ctx, 'a.btn_report_yes'), `apy:${row.id}`), btn(T(ctx, 'btn.cancel'), 'm')]]);
}

export async function confirmReport(ctx, user, id) {
  const row = isRef(id) ? await getAnonMsg(id) : null;
  if (!row || row.toId !== user.id) return answer(ctx, T(ctx, 'a.gone'), { alert: true });
  const r = await createReport(row, user.id);
  if (r === 'ok') {
    await addAnonBlock(user.id, row.fromId);
    if (row.anon) await addStrike(row.fromId, user.id);
    const owner = await getUser(OWNER_ID);
    const lang = langOf(owner);
    await send(ctx, 'owner_report', t(lang, 'adm.report_new'), [[btn(t(lang, 'adm.btn_review'), 'a:rp')]], OWNER_ID);
  }
  await answer(ctx, T(ctx, r === 'ok' ? 'a.reported' : 'a.report_dup'), { alert: true });
  return show(ctx, 'anon_reported', T(ctx, r === 'ok' ? 'a.reported_text' : 'a.report_dup'), [[btn(T(ctx, 'btn.back'), 'an')]]);
}

// ---------- relaying ----------

/** What the message is: { kind, body, fileId, entities } for the types the bot accepts. */
export function contentOf(m) {
  if (typeof m.text === 'string') return { kind: 'text', body: m.text, fileId: null, entities: m.entities };
  const pick = (kind, f) => ({ kind, body: m.caption || '', fileId: f.file_id, entities: m.caption_entities });
  if (Array.isArray(m.photo) && m.photo.length) return pick('photo', m.photo[m.photo.length - 1]);
  for (const kind of ['video', 'animation', 'voice', 'audio', 'document', 'sticker', 'video_note']) {
    if (m[kind] && m[kind].file_id) return pick(kind, m[kind]);
  }
  return null;
}

/** Delivers to `to`: a text message with a header, or a header and an exact copy of the media. */
async function deliver(ctx, message, c, target, id, header, replyTo) {
  const lang = langOf(target);
  const kb = { inline_keyboard: deliveredButtons(lang, id) };
  const opts = { silent: target.aSilent, replyTo };
  if (c.kind === 'text' && c.body.length <= 3800) {
    const r = await send(ctx, 'anon_deliver', `${header}\n\n${esc(c.body)}`, kb.inline_keyboard, target.id, { ...opts, secret: true, rethrow: true });
    return r.message_id;
  }
  const h = await send(ctx, 'anon_header', `${header} 👇`, null, target.id, { ...opts, rethrow: true });
  try {
    const r = await call(ctx, 'copyMessage', {
      chat_id: target.id,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
      reply_markup: kb,
      ...(target.aSilent ? { disable_notification: true } : {}),
    }, 'anon_deliver');
    return r.message_id;
  } catch (err) {
    try {
      await call(ctx, 'deleteMessage', { chat_id: target.id, message_id: h.message_id }, 'anon_header_undo');
    } catch {
      // best effort: a header without content is only cosmetic
    }
    throw err;
  }
}

function deliveryHeader(lang, anon, cat, q, sender) {
  if (!anon) return t(lang, 'a.reply_header', { name: esc(displayNameOf(sender, lang)) });
  const head = t(lang, 'a.new_header', { cat: catLabel(lang, cat) });
  return q ? `${head}\n${t(lang, 'a.answering', { q: esc(q) })}` : head;
}

/** The visitor's (or a replier's) message, while user_state is anon_send / anon_reply. */
export async function onAnonMessage(ctx, user, message, st) {
  const c = contentOf(message);
  if (!c) return send(ctx, 'anon_unsupported', T(ctx, 'a.unsupported'));
  if (c.body.length > ANON_MAX_LEN) return send(ctx, 'anon_too_long', T(ctx, 'a.too_long', { max: N(ctx, ANON_MAX_LEN) }));

  let target;
  let anon;
  let replyTo = null;
  let cat = 'g';
  let q = null;
  if (st.state === 'anon_send') {
    target = await getUser(Number(st.data.to));
    if (!target || !target.anonOn || target.banned) {
      await clearState(user.id);
      return send(ctx, 'anon_link_invalid', T(ctx, 'a.link_invalid'), [[btn(T(ctx, 'btn.home'), 'm')]]);
    }
    anon = true;
    cat = st.data.cat || 'g';
    q = st.data.q || null;
  } else {
    const prev = await getAnonMsg(String(st.data.ref || ''));
    if (!prev || prev.toId !== user.id) {
      await clearState(user.id);
      return send(ctx, 'anon_gone', T(ctx, 'a.gone'), [[btn(T(ctx, 'btn.home'), 'm')]]);
    }
    target = await getUser(prev.fromId);
    anon = !prev.anon; // the anonymous side stays anonymous in both directions
    replyTo = prev.fromMsg;
    cat = prev.cat;
  }
  if (!target) return send(ctx, 'anon_gone', T(ctx, 'a.gone'));
  if (await refuses(target.id, user.id)) {
    await clearState(user.id);
    return send(ctx, 'anon_refused', T(ctx, 'a.refused'), [[btn(T(ctx, 'btn.home'), 'm')]]);
  }
  if (anon && target.aText && c.kind !== 'text') return send(ctx, 'anon_text_only', T(ctx, 'a.text_only'));

  const norm = normalize(c.body);
  const hash = norm ? hash32(norm) : 0;
  const spam = await spamCheck(user, target.id, hash);
  if (spam) {
    const left = spam.until ? dur(ctx.lang, spam.until - nowSec()) : '';
    return send(ctx, `anon_spam_${spam.code}`, T(ctx, `a.spam.${spam.code}`, { t: left }));
  }

  // The recipient's filters: a filtered message is kept (folder 2) but not delivered.
  const words = await listWords(target.id);
  const reason = filterReason(target, words, c.body, c.entities);
  const id = randomId(10);
  await createAnonMsg({
    id, fromId: user.id, toId: target.id, anon, fromMsg: Number(message.message_id) || null, kind: c.kind, body: c.body, norm, fileId: c.fileId, cat, q, hash, folder: reason ? 2 : 0,
  });
  await touchSent(user.id);
  ctx.filtered = reason || undefined;
  if (!reason) {
    const lang = langOf(target);
    try {
      const delivered = await deliver(ctx, message, c, target, id, deliveryHeader(lang, anon, cat, q, user), replyTo);
      if (delivered) await setDelivered(id, delivered);
    } catch (err) {
      if (isApiError(err) && err.code === 403) {
        await markInactive(target.id);
      } else if (isApiError(err) && err.code === 400 && /can't be copied|message to copy not found|MESSAGE_ID_INVALID/i.test(err.description)) {
        await deleteMsg(id, target.id);
        return send(ctx, 'anon_unsupported', T(ctx, 'a.unsupported'));
      } else {
        console.warn(`anonymous delivery failed: ${describeError(err)}`);
      }
      // Kept in their inbox either way: they see it when they come back.
    }
  }
  await clearState(user.id);
  const code = st.state === 'anon_send' ? st.data.code : null;
  const kb = code
    ? [[btn(T(ctx, 'a.btn_again'), `aw:${code}`), btn(T(ctx, 'a.btn_rate'), `rt:${code}`)], [btn(T(ctx, 'a.btn_own_link'), 'al')]]
    : [[btn(T(ctx, 'btn.home'), 'm')]];
  return send(ctx, 'anon_sent', T(ctx, st.state === 'anon_send' ? 'a.sent' : (anon ? 'a.reply_sent_anon' : 'a.reply_sent')), kb);
}
