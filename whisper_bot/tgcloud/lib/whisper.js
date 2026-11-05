// Whispers: inline results, the draft each sender is typing, finalizing on chosen_inline_result,
// and opening one (button press in the chat, or the deep link for long ones). The content lives only
// in the database: never in callback_data, never in the posted message, never in the trace.
//
// Languages: the posted message is in the sender's language (whispers.lang), a popup in the language
// of whoever pressed the button, a notification in its recipient's language.
//
// Ids: a draft has an 8-character id. The main inline result is that whisper; quick results (recent
// recipients) are the same id plus a digit 1-3. callback_data is "s:<id>", the deep link "w_<id>".
import { ALERT_MAX, MAX_RECIPIENTS } from './config.js';
import { anonArticle } from './anon.js';
import { botInfo, startLink } from './bot.js';
import {
  dur, langOf, num, t,
} from './i18n.js';
import { checkJoin } from './join.js';
import { parseQuery } from './parse.js';
import {
  addOpen, addSnoop, blockersOf, burnWhisper, createWhisper, deleteDraft, expireWhisper, getDraft, getDraftById,
  getKv, getRcpts, getUser, getUserByUsername, getWhisper, isBlocked, markInactive, markSeen, pinRecipient,
  saveDraft, setInlineId, setRecent,
} from './store.js';
import {
  answer, btn, call, describeError, editInline, isApiError, send, urlBtn,
} from './tg.js';
import {
  esc, isId, nowSec, randomId, truncate,
} from './util.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);

// ---------- the posted message ----------

/** A recipient for HTML: @username as is, otherwise a mention link by id. */
export function rcptHtml(r) {
  if (r.label.startsWith('@')) return esc(r.label);
  if (r.rid) return `<a href="tg://user?id=${r.rid}">${esc(r.label)}</a>`;
  return esc(r.label);
}

/** A person (users row or Telegram user) for HTML: @username, else a mention link. */
export function personHtml(p) {
  if (p.username) return `@${esc(p.username)}`;
  const id = p.id || p.user_id;
  const name = esc(p.firstName || p.first_name || id);
  return id ? `<a href="tg://user?id=${id}">${name}</a>` : name;
}

export const joinNames = (lang, parts) => parts.join(t(lang, 'w.sep'));

const isLong = (body) => typeof body === 'string' && body.length > ALERT_MAX;

/**
 * Text and keyboard of the message in the chat — status only, never the content.
 * `w` is a whisper, or a draft-shaped { id, once, expirySec, body, state: 0, snoops: 0, lang }.
 */
export function renderPosted(w, rcpts, botUsername) {
  const l = w.lang || 'fa';
  const who = joinNames(l, rcpts.map(rcptHtml));
  const curious = w.snoops ? `\n${t(l, 'w.curious_line', { n: num(l, w.snoops) })}` : '';
  if (w.state === 1) return { text: `${t(l, 'w.burned_title')}\n${t(l, 'w.for', { who })}${curious}`, kb: null };
  if (w.state === 2) return { text: `${t(l, 'w.expired_title')}\n${t(l, 'w.for', { who })}${curious}`, kb: null };
  const lines = [t(l, 'w.posted', { who })];
  if (w.once) lines.push(t(l, 'w.once_line'));
  const expirySec = w.expirySec || (w.expiresAt ? w.expiresAt - w.createdAt : 0);
  if (expirySec) lines.push(t(l, 'w.expiry_line', { d: dur(l, expirySec) }));
  const seen = rcpts.filter((r) => r.seenAt);
  if (seen.length) lines.push(rcpts.length === 1 ? t(l, 'w.seen') : t(l, 'w.seen_by', { who: joinNames(l, seen.map(rcptHtml)) }));
  const kb = [[btn(t(l, 'w.btn_show'), `s:${w.id}`)]];
  if (isLong(w.body) && botUsername) kb.push([urlBtn(t(l, 'w.btn_read_bot'), startLink(botUsername, `w_${w.id}`))]);
  return { text: lines.join('\n') + curious, kb };
}

async function editPosted(ctx, w, rcpts, bot) {
  const { text, kb } = renderPosted(w, rcpts, bot.username);
  await editInline(ctx, 'whisper_status', w.inlineId, text, kb);
}

// ---------- composing: inline query text → draft data ----------

/**
 * Resolves parsed recipients. A numeric id is the recipient itself; a @username is matched at
 * click time, and the bot's users table is used only to check blocks and duplicates.
 * Returns { rcpts: [{ rid, runame, label, hint }] } or { error, who }.
 */
async function resolveRecipients(sender, parsed, botUsername, lang) {
  const rcpts = [];
  for (const r of parsed) {
    if (r.id) {
      if (r.id === sender.id) return { error: 'self' };
      const u = await getUser(r.id);
      const label = u && u.username ? `@${u.username}` : truncate((u && u.firstName) || String(r.id), 32);
      rcpts.push({ rid: r.id, runame: null, label, hint: r.id });
    } else {
      const lc = r.username.toLowerCase();
      if (lc === sender.usernameLc) return { error: 'self' };
      if (botUsername && lc === botUsername.toLowerCase()) return { error: 'bot' };
      const u = await getUserByUsername(lc);
      if (u && u.id === sender.id) return { error: 'self' };
      rcpts.push({ rid: null, runame: lc, label: `@${r.username}`, hint: u ? u.id : null });
    }
  }
  // "@ali 123" where 123 is @ali: one recipient.
  const unique = rcpts.filter((r, i) => !(r.runame && r.hint && rcpts.some((o, j) => j !== i && o.rid === r.hint)));
  const blockers = await blockersOf(sender.id, unique.map((r) => r.hint).filter(Boolean));
  if (blockers.length) {
    const who = joinNames(lang, unique.filter((r) => blockers.includes(r.hint)).map((r) => r.label));
    return { error: 'blocked', who };
  }
  return { rcpts: unique.slice(0, MAX_RECIPIENTS) };
}

const stored = (r) => ({ rid: r.rid, runame: r.runame, label: r.label, hint: r.hint || r.rid || null });

/**
 * What an inline query would send: { data } (a draft) or { error, who }.
 * data = { t: text, o: once, e: expiry seconds, r: recipients | null, k: quick recipients, l: lang }.
 */
export async function compose(user, query, botUsername, lang) {
  const p = parseQuery(query);
  if (p.empty) return { error: 'empty' };
  if (p.error) return { error: p.error };
  const expiry = p.expiry != null ? p.expiry : user.defExpiry;
  if (p.recipients.length) {
    const res = await resolveRecipients(user, p.recipients, botUsername, lang);
    if (res.error) return res;
    return { data: { t: p.text, o: p.once, e: expiry, r: res.rcpts.map(stored), k: [], l: lang } };
  }
  // Text only: offer the recent recipients who still accept whispers from this user.
  const recent = (Array.isArray(user.recent) ? user.recent : []).slice(0, 3);
  const blockers = await blockersOf(user.id, recent.map((r) => r.hint).filter(Boolean));
  const quick = recent.filter((r) => !(r.hint && blockers.includes(r.hint)));
  if (!quick.length) return { error: 'no_recipient' };
  return { data: { t: p.text, o: p.once, e: expiry, r: null, k: quick.map(stored), l: lang } };
}

// ---------- inline query ----------

function article(id, title, description, messageText, kb) {
  const r = {
    type: 'article',
    id,
    title,
    input_message_content: { message_text: messageText, parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
  };
  if (description) r.description = description;
  if (kb) r.reply_markup = { inline_keyboard: kb };
  return r;
}

function whisperArticle(ctx, resultId, wid, data, rcpts, botUsername, title) {
  const draftView = { id: wid, once: data.o, expirySec: data.e, body: data.t, state: 0, snoops: 0, lang: data.l };
  const { text, kb } = renderPosted(draftView, rcpts.map((r) => ({ ...r, seenAt: 0 })), botUsername);
  const flags = [];
  if (data.o) flags.push(T(ctx, 'w.flag_once'));
  if (data.e) flags.push(`⏳ ${dur(ctx.lang, data.e)}`);
  if (isLong(data.t)) flags.push(T(ctx, 'w.flag_long'));
  flags.push(T(ctx, 'w.flag_chars', { n: num(ctx.lang, data.t.length) }));
  return article(resultId, title, T(ctx, 'w.tap_to_send', { flags: flags.join(' • ') }), text, kb);
}

const labels = (lang, rcpts) => joinNames(lang, rcpts.map((r) => r.label));

async function answerInline(ctx, q, results, button) {
  const params = { inline_query_id: q.id, results, cache_time: 0, is_personal: true };
  if (button) params.button = button;
  try {
    await call(ctx, 'answerInlineQuery', params, 'inline_results');
  } catch (err) {
    console.warn(`answerInlineQuery failed: ${describeError(err)}`);
  }
}

const INLINE_ERRORS = ['no_recipient', 'no_text', 'too_many', 'bad_expiry', 'self', 'bot', 'blocked'];

/** Handles an inline query: the whisper being typed, or why it can't be sent yet. */
export async function handleInline(ctx, q, user, kv) {
  if (user.banned) return answerInline(ctx, q, [], { text: T(ctx, 'w.inline_banned'), start_parameter: 'banned' });
  const join = await checkJoin(ctx, user, kv, { inline: true });
  if (!join.ok) return answerInline(ctx, q, [], { text: T(ctx, 'w.inline_join'), start_parameter: 'join' });
  const bot = await botInfo(ctx, kv);
  const b = bot.username ? `@${esc(bot.username)}` : '@bot';
  const query = String(q.query || '');
  const help = article('h.format', T(ctx, 'w.help_title'), T(ctx, 'w.help_desc'), T(ctx, 'w.format', { b }));
  const c = await compose(user, query, bot.username, ctx.lang);
  if (c.error) {
    if (c.error === 'empty') {
      // Nothing typed yet: the format, and the user's anonymous-chat link to share in this chat.
      const share = await anonArticle(user, bot.username, ctx.lang);
      return answerInline(ctx, q, share ? [help, share] : [help]);
    }
    const code = INLINE_ERRORS.includes(c.error) ? c.error : 'no_recipient';
    const desc = code === 'blocked' ? T(ctx, 'w.err.blocked.desc', { who: c.who }) : T(ctx, `w.err.${code}.desc`);
    return answerInline(ctx, q, [article(`h.${code}`, T(ctx, `w.err.${code}.title`), desc, T(ctx, 'w.format', { b })), help]);
  }

  // One draft row per sender, overwritten in place; a new id whenever the content changes.
  const draft = await getDraft(user.id);
  const same = draft && draft.q === query && JSON.stringify(draft.data) === JSON.stringify(c.data);
  const id = same ? draft.id : randomId(8);
  if (!same) await saveDraft(user.id, id, query, c.data);

  const results = [];
  if (c.data.r) {
    results.push(whisperArticle(ctx, `w.${id}`, id, c.data, c.data.r, bot.username, T(ctx, 'w.title_for', { who: labels(ctx.lang, c.data.r) })));
  } else {
    c.data.k.forEach((r, i) => {
      results.push(whisperArticle(ctx, `q.${id}.${i + 1}`, `${id}${i + 1}`, c.data, [r], bot.username, T(ctx, 'w.title_quick', { who: r.label })));
    });
    results.push(help);
  }
  return answerInline(ctx, q, results);
}

// ---------- finalizing ----------

/** "w.<id>" → { wid, base, k: 0 }; "q.<id>.<k>" → { wid: id+k, base, k }; else null. */
export function parseResultId(resultId) {
  const m = /^(w)\.([0-9A-Za-z]{8})$|^(q)\.([0-9A-Za-z]{8})\.([1-3])$/.exec(String(resultId || ''));
  if (!m) return null;
  if (m[1]) return { wid: m[2], base: m[2], k: 0 };
  return { wid: `${m[4]}${m[5]}`, base: m[4], k: Number(m[5]) };
}

const recipientsOf = (data, k) => (k ? (data.k && data.k[k - 1] ? [data.k[k - 1]] : null) : data.r);

async function updateRecent(user, rcpts) {
  const key = (r) => (r.rid ? `#${r.rid}` : `@${r.runame}`);
  const next = [];
  for (const r of [...rcpts, ...(Array.isArray(user.recent) ? user.recent : [])]) {
    if (!next.some((o) => key(o) === key(r))) next.push(stored(r));
  }
  user.recent = next.slice(0, 3);
  await setRecent(user.id, user.recent);
}

async function finalize(user, wid, data, k, inlineId) {
  const rcpts = recipientsOf(data, k);
  if (!rcpts || !rcpts.length || !data.t) return false;
  const created = await createWhisper({
    id: wid,
    senderId: user.id,
    body: data.t,
    once: !!data.o,
    expiresAt: data.e ? nowSec() + data.e : 0,
    recipients: rcpts.map((r) => ({ rid: r.rid, runame: r.runame, label: r.label })),
    inlineId: inlineId || null,
    lang: data.l || langOf(user),
  });
  if (created) await updateRecent(user, rcpts);
  return created;
}

/** chosen_inline_result: the sender posted a result — turn the draft into a whisper. */
export async function handleChosen(ctx, c, user, kv) {
  const rid = parseResultId(c.result_id);
  if (!rid || user.banned) return { created: false };
  const draft = await getDraft(user.id);
  let data = draft && draft.id === rid.base ? draft.data : null;
  if (!data) {
    // The client posted a result from an older keystroke: rebuild it from the query it came with.
    const bot = await botInfo(ctx, kv);
    data = (await compose(user, String(c.query || ''), bot.username, ctx.lang)).data || null;
  }
  if (!data) return { created: false };
  const created = await finalize(user, rid.wid, data, rid.k, c.inline_message_id);
  if (draft && draft.id === rid.base) await deleteDraft(user.id, rid.base);
  return { created, id: rid.wid };
}

/** No chosen_inline_result arrived (inline feedback off or lost): finalize from the draft on first use. */
async function finalizeFromDraft(wid, inlineId) {
  if (!isId(wid, 8, 9)) return null;
  const base = wid.slice(0, 8);
  const k = wid.length === 9 ? Number(wid[8]) : 0;
  const draft = await getDraftById(base);
  if (!draft) return null;
  const sender = await getUser(draft.senderId);
  if (!sender || sender.banned) return null;
  await finalize(sender, wid, draft.data, k, inlineId);
  await deleteDraft(draft.senderId, base);
  return getWhisper(wid);
}

async function loadWhisper(wid, inlineId) {
  if (!isId(wid, 8, 9)) return null;
  const w = (await getWhisper(wid)) || (await finalizeFromDraft(wid, inlineId));
  if (w && !w.inlineId && inlineId) {
    await setInlineId(w.id, inlineId);
    w.inlineId = inlineId;
  }
  return w;
}

// ---------- opening ----------

/** sender | recipient (with its row) | curious. A @username recipient is matched until claimed. */
export function roleOf(w, rcpts, from) {
  if (Number(from.id) === w.senderId) return { kind: 'sender' };
  const lc = from.username ? String(from.username).toLowerCase() : null;
  for (const r of rcpts) {
    const match = r.rid != null ? r.rid === Number(from.id) : !!lc && r.runame === lc;
    if (match) return { kind: 'recipient', rcpt: r };
  }
  return { kind: 'curious' };
}

/** Lazy expiry: checked whenever someone tries to open it. */
async function applyExpiry(ctx, w, rcpts, bot) {
  if (w.state !== 0 || !w.expiresAt || nowSec() < w.expiresAt) return;
  if (await expireWhisper(w.id)) await editPosted(ctx, { ...w, state: 2 }, rcpts, bot);
  w.state = 2;
  w.body = null;
}

/** Sends `text` to the whisper's sender if they want notifications; marks them inactive on 403. */
async function notifySender(ctx, w, view, build) {
  const sender = await getUser(w.senderId);
  if (!sender || !sender.started || !sender.active || !sender.receipts) return;
  const lang = langOf(sender);
  try {
    await call(ctx, 'sendMessage', {
      chat_id: sender.id,
      text: build(lang),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[btn(t(lang, 'w.btn_details'), `d:${w.id}`)]] },
    }, view);
  } catch (err) {
    if (isApiError(err) && err.code === 403) await markInactive(sender.id);
    else console.warn(`${view} failed: ${describeError(err)}`);
  }
}

/**
 * Every time a recipient opens it: the sender is told at once, with the count. The first time also
 * marks "👁 دیده شد" on the message and burns a one-time whisper once every recipient has seen it.
 */
async function afterView(ctx, w, rcpt, first, bot) {
  const opens = await addOpen(w.id, rcpt.slot);
  let burnedNow = false;
  if (first) {
    const rcpts = await getRcpts(w.id);
    if (w.once && rcpts.every((r) => r.seenAt)) {
      if (await burnWhisper(w.id)) {
        w.state = 1;
        w.body = null;
        burnedNow = true;
      }
    }
    await editPosted(ctx, w, rcpts, bot);
  }
  await notifySender(ctx, w, 'read_receipt', (lang) => {
    const line = opens <= 1 ? t(lang, 'w.n_open_first', { who: rcptHtml(rcpt) }) : t(lang, 'w.n_open_again', { who: rcptHtml(rcpt), n: num(lang, opens) });
    return burnedNow ? `${line}\n${t(lang, 'w.n_burned')}` : line;
  });
}

/** Someone who isn't a recipient pressed the button: counted once, shown, and the sender told. */
async function recordCurious(ctx, w, rcpts, from, bot) {
  const n = await addSnoop(w.id, from);
  if (n === null) return; // already counted
  await editPosted(ctx, { ...w, snoops: n }, rcpts, bot);
  await notifySender(ctx, w, 'curious_notice', (lang) => t(lang, 'w.n_curious', { who: personHtml(from) }));
}

/** Refusal key shared by the button and the deep link; null when the user may see the content. */
async function refusal(w, role, from) {
  if (role.kind === 'curious') return 'w.not_yours';
  if (w.state === 2) return 'w.expired';
  if (w.state === 1) return 'w.burned';
  if (role.kind === 'recipient') {
    if (await isBlocked(Number(from.id), w.senderId)) return 'w.you_blocked';
    if (w.once && role.rcpt.seenAt) return 'w.already_seen';
  }
  return null;
}

/**
 * Claims the view for a recipient. For a one-time whisper only the first call wins (atomic update),
 * so two quick presses can't both see it. Returns { ok, first }.
 */
async function claimView(w, role, from) {
  if (role.kind !== 'recipient') return { ok: true, first: false };
  if (role.rcpt.rid == null) {
    await pinRecipient(w.id, role.rcpt.slot, Number(from.id));
    role.rcpt.rid = Number(from.id);
  }
  const first = await markSeen(w.id, role.rcpt.slot);
  if (w.once && !first) return { ok: false, first: false };
  return { ok: true, first };
}

/** The "👁 نمایش نجوا" button in the chat. */
export async function handleShowButton(ctx, cq, wid) {
  const w = await loadWhisper(wid, cq.inline_message_id || null);
  if (!w) return answer(ctx, T(ctx, 'w.not_found'), { alert: true });
  const kv = await getKv(['bot_id', 'bot_username']);
  const bot = await botInfo(ctx, kv);
  const rcpts = await getRcpts(w.id);
  await applyExpiry(ctx, w, rcpts, bot);
  const role = roleOf(w, rcpts, cq.from);

  const no = await refusal(w, role, cq.from);
  if (no) {
    await answer(ctx, T(ctx, no), { alert: true });
    if (role.kind === 'curious' && w.state === 0) await recordCurious(ctx, w, rcpts, cq.from, bot);
    return null;
  }

  if (isLong(w.body)) {
    // Too long for the popup: open the bot with the deep link; the view is counted there.
    if (!bot.username) return answer(ctx, T(ctx, 'w.long_no_bot'), { alert: true });
    return answer(ctx, T(ctx, 'w.long_open'), { alert: true, url: startLink(bot.username, `w_${w.id}`) });
  }

  const view = await claimView(w, role, cq.from);
  if (!view.ok) return answer(ctx, T(ctx, 'w.already_seen'), { alert: true });
  await answer(ctx, w.body, { alert: true, secret: true, meta: { id: w.id, role: role.kind, length: w.body.length } });
  if (role.kind === 'recipient') await afterView(ctx, w, role.rcpt, view.first, bot);
  return null;
}

/** /start w_<id> in the bot's chat: the full text, for the sender and the recipients only. */
export async function handleDeepRead(ctx, message, wid) {
  const w = await loadWhisper(wid, null);
  if (!w) return send(ctx, 'whisper_missing', T(ctx, 'w.missing'));
  const kv = await getKv(['bot_id', 'bot_username']);
  const bot = await botInfo(ctx, kv);
  const rcpts = await getRcpts(w.id);
  await applyExpiry(ctx, w, rcpts, bot);
  const role = roleOf(w, rcpts, message.from);
  const no = await refusal(w, role, message.from);
  if (no) return send(ctx, role.kind === 'curious' ? 'whisper_stranger' : 'whisper_refused', `⛔ ${T(ctx, no)}`);

  const view = await claimView(w, role, message.from);
  if (!view.ok) return send(ctx, 'whisper_refused', `⛔ ${T(ctx, 'w.already_seen')}`);

  const body = w.body;
  const burnNote = w.once ? `\n\n${T(ctx, 'w.read_once_note')}` : '';
  let head;
  let kb;
  if (role.kind === 'sender') {
    head = T(ctx, 'w.read_own', { who: joinNames(ctx.lang, rcpts.map(rcptHtml)) });
    kb = [[btn(T(ctx, 'w.btn_details'), `d:${w.id}`)]];
  } else {
    const sender = await getUser(w.senderId);
    head = T(ctx, 'w.read_from', { who: sender ? personHtml(sender) : esc(w.senderId) });
    kb = [[btn(T(ctx, 'w.btn_block_sender'), `bk:${w.senderId}`), btn(T(ctx, 'w.btn_details'), `d:${w.id}`)]];
  }
  await send(ctx, 'whisper_read', `${head}\n\n${esc(body)}${burnNote}`, kb, ctx.chatId, { secret: true, meta: { id: w.id, role: role.kind, length: body.length } });
  if (role.kind === 'recipient') await afterView(ctx, w, role.rcpt, view.first, bot);
  return null;
}
