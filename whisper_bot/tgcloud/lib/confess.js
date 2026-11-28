// The confession channel. A user writes a confession in the bot and chooses, before review, whether
// people may comment on it and whether they may message the author anonymously. The owner, or an admin
// with the cf permission (lib/staff.js), reviews it — seeing the text, those choices and what the
// filters noticed, never who wrote it — and an approved confession is posted to the channel the owner
// set (/admin → 📝). The post's buttons lead back to the bot: comments are written and read here
// (cm_<id>), and an anonymous message to the author goes to their inbox through the usual pipeline
// (lib/anon.js) without showing their profile (cx_<id>). Storage: lib/cstore.js.
import {
  CF_COMMENT_GAP_SEC, CF_COMMENT_MAX, CF_COMMENTS_PAGE, CF_PER_DAY, CONFESSION_MAX, OWNER_ID,
} from './config.js';
import { refuses } from './anon.js';
import { botInfo, startLink } from './bot.js';
import {
  addComment, countByAuthorSince, countPendingConfessions, countPublished, createConfession, decide, firstReport,
  getComment, getConfession, hideComment as hideCommentRow, lastCommentAt, listComments, listPending, setPosted, undecide,
} from './cstore.js';
import {
  hasLink, hasPhone, isOffensive, normalize,
} from './filter.js';
import {
  ago, langOf, num, t,
} from './i18n.js';
import { can, getStaff, staffWith } from './staff.js';
import {
  clearState, getState, getUser, setBanned, setKv, setState,
} from './store.js';
import {
  answer, btn, call, describeError, editMarkup, send, show, urlBtn,
} from './tg.js';
import {
  esc, nowSec, toAsciiDigits, truncate,
} from './util.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);
const N = (ctx, n) => num(ctx.lang, n);
const toPanel = (ctx) => [btn(T(ctx, 'adm.btn_panel'), 'a')];
const home = (ctx) => [btn(T(ctx, 'btn.home'), 'm')];

export const isOpen = (kv) => kv.cf_on === '1' && !!kv.cf_chat;

/** What the filters noticed in a text: shown to the reviewer (a comment with any of these is refused). */
function flagsOf(text) {
  const flags = [];
  if (isOffensive(normalize(text))) flags.push('offensive');
  if (hasLink(text)) flags.push('link');
  if (hasPhone(text)) flags.push('phone');
  return flags;
}

// ---------- writing a confession ----------

export async function showHome(ctx, user, kv) {
  const open = isOpen(kv);
  const kb = open ? [[btn(T(ctx, 'cf.btn_write'), 'cw')], home(ctx)] : [home(ctx)];
  return show(ctx, 'cf_home', `${T(ctx, 'cf.home')}${open ? '' : `\n\n${T(ctx, 'cf.closed')}`}`, kb);
}

async function refusal(ctx, user, kv) {
  if (!isOpen(kv)) return 'cf.closed';
  if (user.restrictedUntil > nowSec()) return 'cf.restricted';
  if ((await countByAuthorSince(user.id, nowSec() - 86400, CF_PER_DAY)) >= CF_PER_DAY) return 'cf.limit';
  return null;
}

export async function startWrite(ctx, user, kv) {
  const no = await refusal(ctx, user, kv);
  if (no) return answer(ctx, T(ctx, no, { n: N(ctx, CF_PER_DAY) }), { alert: true });
  await setState(user.id, 'cf_write');
  await answer(ctx);
  return show(ctx, 'cf_write', T(ctx, 'cf.write', { max: N(ctx, CONFESSION_MAX) }), [[btn(T(ctx, 'btn.cancel'), 'cf')]]);
}

/** The confession's text arrived (state cf_write): on to the author's choices. */
export async function onText(ctx, user, message) {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text) return send(ctx, 'cf_text_only', T(ctx, 'cf.text_only'));
  if (text.length > CONFESSION_MAX) return send(ctx, 'cf_too_long', T(ctx, 'cf.too_long', { max: N(ctx, CONFESSION_MAX) }));
  const data = { b: text, c: 1, d: 0, f: flagsOf(text) };
  await setState(user.id, 'cf_options', data);
  return showOptions(ctx, user, data);
}

function optionsKeyboard(ctx, user, data) {
  const kb = [[btn(T(ctx, data.c ? 'cf.opt_comments_on' : 'cf.opt_comments_off'), 'co:c')]];
  kb.push([btn(T(ctx, user.anonOn ? (data.d ? 'cf.opt_dm_on' : 'cf.opt_dm_off') : 'cf.opt_dm_locked'), 'co:d')]);
  kb.push([btn(T(ctx, 'cf.btn_submit'), 'cs')]);
  kb.push([btn(T(ctx, 'cf.btn_rewrite'), 'cw'), btn(T(ctx, 'btn.cancel'), 'cf')]);
  return kb;
}

async function showOptions(ctx, user, data, note = '') {
  const lines = [T(ctx, 'cf.options', { preview: esc(truncate(data.b, 300)) })];
  if (data.f && data.f.length) lines.push('', T(ctx, 'cf.options_flags', { flags: flagNames(ctx, data.f) }));
  return show(ctx, 'cf_options', `${note ? `${note}\n\n` : ''}${lines.join('\n')}`, optionsKeyboard(ctx, user, data), { secret: true });
}

/** "co:c" comments / "co:d" anonymous messages to the author: the author's choice, before review. */
export async function toggleOption(ctx, user, which) {
  const st = await getState(user.id);
  if (!st || st.state !== 'cf_options') return answer(ctx, T(ctx, 'cf.draft_gone'), { alert: true });
  const data = st.data;
  if (which === 'd' && !user.anonOn) return answer(ctx, T(ctx, 'cf.dm_needs_link'), { alert: true });
  if (which === 'c') data.c = data.c ? 0 : 1;
  else if (which === 'd') data.d = data.d ? 0 : 1;
  else return answer(ctx);
  await setState(user.id, 'cf_options', data);
  await answer(ctx);
  return showOptions(ctx, user, data);
}

export async function submit(ctx, user, kv) {
  const st = await getState(user.id);
  if (!st || st.state !== 'cf_options') return answer(ctx, T(ctx, 'cf.draft_gone'), { alert: true });
  const no = await refusal(ctx, user, kv);
  if (no) return answer(ctx, T(ctx, no, { n: N(ctx, CF_PER_DAY) }), { alert: true });
  const d = st.data;
  const id = await createConfession({
    authorId: user.id, body: String(d.b), allowComments: !!d.c, allowDm: !!d.d && user.anonOn, flags: d.f || [], lang: ctx.lang,
  });
  await clearState(user.id);
  await answer(ctx, T(ctx, 'cf.sent_short'));
  await notifyReviewers(ctx, await getConfession(id));
  return show(ctx, 'cf_sent', T(ctx, 'cf.sent', { id: N(ctx, id) }), [home(ctx)]);
}

// ---------- review (owner / admins with cf) ----------

const yes = (lang, on) => t(lang, on ? 'cf.allowed' : 'cf.not_allowed');

function flagNames(ctx, flags) {
  return flags.map((f) => T(ctx, `cf.flag_${f}`)).join(ctx.lang === 'fa' ? '، ' : ', ');
}

/** The review card: the text, the author's choices, what the filters noticed — never who wrote it. */
function reviewText(ctx, c) {
  const lines = [T(ctx, 'cf.review_head', { id: N(ctx, c.id), ago: ago(ctx.lang, c.createdAt, nowSec()) }), '', esc(c.body), ''];
  lines.push(T(ctx, 'cf.review_choices'));
  lines.push(T(ctx, 'cf.review_comments', { v: yes(ctx.lang, c.allowComments) }));
  lines.push(T(ctx, 'cf.review_dm', { v: yes(ctx.lang, c.allowDm) }));
  if (c.flags.length) lines.push(T(ctx, 'cf.review_flags', { flags: flagNames(ctx, c.flags) }));
  if (c.status !== 'pending') lines.push('', T(ctx, `cf.status_${c.status}`));
  lines.push('', T(ctx, 'cf.review_privacy'));
  return lines.join('\n');
}

function reviewKeyboard(ctx, staff, c) {
  if (c.status !== 'pending') return [[btn(T(ctx, 'cf.btn_queue'), 'a:cf')]];
  const kb = [[btn(T(ctx, 'cf.btn_approve'), `a:cfa:${c.id}`), btn(T(ctx, 'cf.btn_reject'), `a:cfr:${c.id}`)]];
  if (can(staff, 'ban')) kb.push([btn(T(ctx, 'cf.btn_ban'), `a:cfb:${c.id}`)]);
  kb.push([btn(T(ctx, 'cf.btn_queue'), 'a:cf')]);
  return kb;
}

/** Every reviewer gets the card in their own language, with the buttons their permissions allow. */
async function notifyReviewers(ctx, c) {
  for (const id of await staffWith('cf')) {
    const reviewer = await getUser(id);
    if (!reviewer || !reviewer.started || !reviewer.active) continue;
    const rctx = { ...ctx, lang: langOf(reviewer) };
    await send(ctx, 'cf_review', reviewText(rctx, c), reviewKeyboard(rctx, await getStaff(id), c), id, { secret: true });
  }
}

export async function showQueue(ctx, staff) {
  const list = await listPending(10);
  await answer(ctx);
  const kb = list.map((c) => [btn(`#${c.id} · ${truncate(c.body.replace(/\s+/g, ' '), 40)}`, `a:cfv:${c.id}`)]);
  kb.push(toPanel(ctx));
  const n = await countPendingConfessions();
  return show(ctx, 'cf_queue', list.length ? T(ctx, 'cf.queue', { n: N(ctx, n) }) : T(ctx, 'cf.queue_empty'), kb, { secret: true });
}

export async function showForReview(ctx, staff, id) {
  const c = await getConfession(id);
  if (!c) return answer(ctx, T(ctx, 'cf.not_found'), { alert: true });
  await answer(ctx);
  return show(ctx, 'cf_review', reviewText(ctx, c), reviewKeyboard(ctx, staff, c), { secret: true });
}

function postKeyboard(lang, c, botUsername) {
  const kb = [];
  if (c.allowComments) kb.push([urlBtn(t(lang, 'cf.btn_comments', { n: num(lang, c.comments) }), startLink(botUsername, `cm_${c.id}`))]);
  if (c.allowDm) kb.push([urlBtn(t(lang, 'cf.btn_dm'), startLink(botUsername, `cx_${c.id}`))]);
  kb.push([urlBtn(t(lang, 'cf.btn_yours'), startLink(botUsername, 'cf'))]);
  return kb;
}

const postLang = (kv) => kv.cf_lang || 'fa';

export async function approve(ctx, staff, id, kv) {
  const c = await getConfession(id);
  if (!c) return answer(ctx, T(ctx, 'cf.not_found'), { alert: true });
  if (c.status !== 'pending') return showDecided(ctx, staff, c);
  if (!kv.cf_chat) return answer(ctx, T(ctx, 'cf.no_channel'), { alert: true });
  if (!(await decide(c.id, 'approved'))) return showDecided(ctx, staff, await getConfession(c.id));
  const bot = await botInfo(ctx, kv);
  const lang = postLang(kv);
  let posted;
  try {
    posted = await send(ctx, 'cf_post', t(lang, 'cf.post', { id: num(lang, c.id), body: esc(c.body) }),
      postKeyboard(lang, c, bot.username), Number(kv.cf_chat), { rethrow: true, secret: true });
  } catch (err) {
    await undecide(c.id); // stays in the queue: the channel refused the post
    return answer(ctx, T(ctx, 'cf.post_failed', { err: truncate(describeError(err), 120) }), { alert: true });
  }
  await setPosted(c.id, Number(kv.cf_chat), posted.message_id);
  await answer(ctx, T(ctx, 'cf.approved_short'));
  const author = await getUser(c.authorId);
  if (author && author.started && author.active) {
    const alang = langOf(author);
    const kb = [];
    if (kv.cf_username) kb.push([urlBtn(t(alang, 'cf.btn_see_post'), `https://t.me/${kv.cf_username}/${posted.message_id}`)]);
    if (c.allowComments) kb.push([btn(t(alang, 'cf.btn_see_comments'), `cm:${c.id}:0`)]);
    await send(ctx, 'cf_author', t(alang, 'cf.published', { id: num(alang, c.id) }), kb, author.id);
  }
  return show(ctx, 'cf_review', reviewText(ctx, await getConfession(c.id)), reviewKeyboard(ctx, staff, { status: 'approved' }), { secret: true });
}

async function showDecided(ctx, staff, c) {
  await answer(ctx, T(ctx, 'cf.decided_already'), { alert: true });
  return show(ctx, 'cf_review', reviewText(ctx, c), reviewKeyboard(ctx, staff, c), { secret: true });
}

async function tellRejected(ctx, c) {
  const author = await getUser(c.authorId);
  if (!author || !author.started || !author.active || author.banned) return;
  const alang = langOf(author);
  await send(ctx, 'cf_author', t(alang, 'cf.rejected', { id: num(alang, c.id) }), null, author.id);
}

export async function reject(ctx, staff, id) {
  const c = await getConfession(id);
  if (!c) return answer(ctx, T(ctx, 'cf.not_found'), { alert: true });
  if (!(await decide(c.id, 'rejected'))) return showDecided(ctx, staff, c);
  await answer(ctx, T(ctx, 'cf.rejected_short'));
  await tellRejected(ctx, c);
  return show(ctx, 'cf_review', reviewText(ctx, await getConfession(c.id)), reviewKeyboard(ctx, staff, { status: 'rejected' }), { secret: true });
}

/** Rejects it and bans the author — without ever showing who that is. */
export async function rejectAndBan(ctx, staff, id) {
  if (!can(staff, 'ban')) return answer(ctx, T(ctx, 'e.no_permission'), { alert: true });
  const c = await getConfession(id);
  if (!c) return answer(ctx, T(ctx, 'cf.not_found'), { alert: true });
  if (c.authorId === OWNER_ID || (!staff.owner && (await getStaff(c.authorId)))) return answer(ctx, T(ctx, 'adm.ban_staff'), { alert: true });
  await decide(c.id, 'rejected');
  if (c.authorId) await setBanned(c.authorId, true); // 0: the author deleted their data
  await answer(ctx, T(ctx, 'cf.banned_author'), { alert: true });
  return show(ctx, 'cf_review', reviewText(ctx, await getConfession(c.id)), reviewKeyboard(ctx, staff, { status: 'rejected' }), { secret: true });
}

// ---------- comments (in the bot) ----------

async function refreshPost(ctx, kv, c) {
  if (!c.channelId || !c.channelMsg) return;
  const bot = await botInfo(ctx, kv);
  await editMarkup(ctx, 'cf_post_kb', c.channelId, c.channelMsg, postKeyboard(postLang(kv), c, bot.username));
}

/** A posted confession with its comments, a page at a time (as many as fit in one message). */
export async function showComments(ctx, user, id, offset = 0, note = '') {
  const c = await getConfession(id);
  if (!c || c.status !== 'approved') return show(ctx, 'cf_comments', T(ctx, 'cf.not_found'), [home(ctx)]);
  const head = T(ctx, 'cf.comments_head', { id: N(ctx, c.id), body: esc(truncate(c.body, 1200)) });
  if (!c.allowComments) return show(ctx, 'cf_comments', `${head}\n\n${T(ctx, 'cf.comments_off')}`, [home(ctx)], { secret: true });
  const start = Math.max(0, Number(offset) || 0);
  const rows = await listComments(c.id, start, CF_COMMENTS_PAGE);
  const now = nowSec();
  let text = `${note ? `${note}\n\n` : ''}${head}\n\n${T(ctx, 'cf.comments_title', { n: N(ctx, c.comments) })}`;
  const shown = [];
  for (const r of rows) {
    const line = `\n\n${N(ctx, start + shown.length + 1)}. ${esc(truncate(r.body, 350))}\n<i>— ${ago(ctx.lang, r.createdAt, now)}</i>`;
    if (text.length + line.length > 3700) break;
    text += line;
    shown.push(r);
  }
  if (!shown.length) text += `\n\n${T(ctx, start ? 'cf.comments_end' : 'cf.comments_none')}`;
  const kb = [[btn(T(ctx, 'cf.btn_comment'), `cc:${c.id}`)]];
  const reports = shown.map((r, i) => btn(`🚩${N(ctx, start + i + 1)}`, `cr:${r.id}`));
  for (let i = 0; i < reports.length; i += 5) kb.push(reports.slice(i, i + 5));
  const pager = [];
  if (start > 0) pager.push(btn(T(ctx, 'btn.prev'), `cm:${c.id}:${Math.max(0, start - CF_COMMENTS_PAGE)}`));
  if (shown.length && start + shown.length < c.comments) pager.push(btn(T(ctx, 'btn.next'), `cm:${c.id}:${start + shown.length}`));
  if (pager.length) kb.push(pager);
  kb.push(home(ctx));
  return show(ctx, 'cf_comments', text, kb, { secret: true, meta: { id: c.id, shown: shown.map((r) => r.id) } });
}

export async function startComment(ctx, user, id) {
  const c = await getConfession(id);
  if (!c || c.status !== 'approved' || !c.allowComments) return answer(ctx, T(ctx, 'cf.comments_off_short'), { alert: true });
  if (user.restrictedUntil > nowSec()) return answer(ctx, T(ctx, 'cf.restricted'), { alert: true });
  const wait = (await lastCommentAt(user.id)) + CF_COMMENT_GAP_SEC - nowSec();
  if (wait > 0) return answer(ctx, T(ctx, 'cf.comment_wait', { n: N(ctx, wait) }), { alert: true });
  await setState(user.id, 'cf_comment', { id: c.id });
  await answer(ctx);
  ctx.messageId = null;
  return send(ctx, 'cf_comment_ask', T(ctx, 'cf.comment_ask', { id: N(ctx, c.id), max: N(ctx, CF_COMMENT_MAX) }), [[btn(T(ctx, 'btn.cancel'), `cm:${c.id}:0`)]]);
}

/** A comment arrived (state cf_comment). Comments are public, so the filters refuse instead of hiding. */
export async function onComment(ctx, user, kv, message, st) {
  const c = await getConfession(st.data.id);
  if (!c || c.status !== 'approved' || !c.allowComments) {
    await clearState(user.id);
    return send(ctx, 'cf_comment_closed', T(ctx, 'cf.comments_off_short'), [home(ctx)]);
  }
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text) return send(ctx, 'cf_text_only', T(ctx, 'cf.text_only'));
  if (text.length > CF_COMMENT_MAX) return send(ctx, 'cf_too_long', T(ctx, 'cf.too_long', { max: N(ctx, CF_COMMENT_MAX) }));
  const flags = flagsOf(text);
  if (flags.length) return send(ctx, 'cf_comment_refused', T(ctx, 'cf.comment_refused', { why: flagNames(ctx, flags) }));
  const count = await addComment(c.id, user.id, text);
  await clearState(user.id);
  await refreshPost(ctx, kv, { ...c, comments: count });
  if (c.authorId !== user.id) {
    const author = await getUser(c.authorId);
    if (author && author.started && author.active && !author.banned) {
      const alang = langOf(author);
      await send(ctx, 'cf_new_comment', t(alang, 'cf.new_comment', { id: num(alang, c.id) }),
        [[btn(t(alang, 'cf.btn_see_comments'), `cm:${c.id}:0`)]], author.id, { silent: true });
    }
  }
  return showComments(ctx, user, c.id, Math.max(0, count - CF_COMMENTS_PAGE), T(ctx, 'cf.comment_saved'));
}

export async function reportComment(ctx, user, cid) {
  const cm = await getComment(cid);
  if (!cm || cm.hidden) return answer(ctx, T(ctx, 'cf.comment_gone'), { alert: true });
  if (await firstReport(cm.id)) {
    for (const id of await staffWith('cf')) {
      const reviewer = await getUser(id);
      if (!reviewer || !reviewer.started || !reviewer.active) continue;
      const rlang = langOf(reviewer);
      await send(ctx, 'cf_comment_report', t(rlang, 'cf.comment_report', { id: num(rlang, cm.confessionId), body: esc(cm.body) }),
        [[btn(t(rlang, 'cf.btn_hide_comment'), `a:cfh:${cm.id}`)]], id, { secret: true });
    }
  }
  return answer(ctx, T(ctx, 'cf.comment_reported'), { alert: true });
}

export async function hideComment(ctx, staff, cid, kv) {
  const r = await hideCommentRow(cid);
  if (!r) return answer(ctx, T(ctx, 'cf.comment_gone'), { alert: true });
  const c = await getConfession(r.confessionId);
  if (c && kv) await refreshPost(ctx, kv, { ...c, comments: r.count });
  return answer(ctx, T(ctx, 'cf.comment_hidden'), { alert: true });
}

// ---------- an anonymous message to the author ----------

/**
 * cx_<id>: write to the author anonymously — through their inbox, without seeing their profile. The
 * target is remembered first (state anon_send), so it survives the language and join screens; returns
 * false after telling the user why it can't be done.
 */
export async function prepareDm(ctx, user, id) {
  const c = await getConfession(id);
  const author = c && c.status === 'approved' && c.allowDm ? await getUser(c.authorId) : null;
  if (!author || !author.anonOn || author.banned) {
    await send(ctx, 'cf_dm_closed', T(ctx, 'cf.dm_closed'), [home(ctx)]);
    return false;
  }
  if (author.id === user.id) {
    await send(ctx, 'cf_dm_self', T(ctx, 'cf.dm_self'), [home(ctx)]);
    return false;
  }
  if (await refuses(author.id, user.id)) {
    await send(ctx, 'anon_refused', T(ctx, 'a.refused'), [home(ctx)]);
    return false;
  }
  const alang = langOf(author);
  await setState(user.id, 'anon_send', {
    to: author.id, code: null, cat: 'c', q: t(alang, 'cf.dm_q', { id: num(alang, c.id) }), via: 'cf', cf: c.id,
  });
  return true;
}

/** "✍️ another message" after one was sent to the author. */
export async function openDm(ctx, user, id) {
  await answer(ctx);
  if (await prepareDm(ctx, user, id)) return showDmCard(ctx, Number(id));
  return null;
}

export async function showDmCard(ctx, id) {
  ctx.messageId = null;
  return send(ctx, 'cf_dm_card', T(ctx, 'cf.dm_card', { id: N(ctx, id) }), [[btn(T(ctx, 'btn.cancel'), 'm')]]);
}

// ---------- settings (the owner) ----------

export async function showSettings(ctx, kv, note = '') {
  await answer(ctx);
  const name = kv.cf_chat ? esc(kv.cf_chat_title || kv.cf_chat) : T(ctx, 'cf.no_channel_set');
  const text = T(ctx, 'cf.settings', {
    channel: name,
    status: T(ctx, isOpen(kv) ? 'common.on' : 'common.off'),
    pending: N(ctx, await countPendingConfessions()),
    published: N(ctx, await countPublished()),
  });
  const kb = [[btn(T(ctx, 'cf.btn_set_channel'), 'a:cfsc')]];
  if (kv.cf_chat) {
    kb.push([btn(T(ctx, isOpen(kv) ? 'cf.btn_turn_off' : 'cf.btn_turn_on'), 'a:cfst')]);
    kb.push([btn(T(ctx, 'cf.btn_remove_channel'), 'a:cfsx')]);
  }
  kb.push(toPanel(ctx));
  return show(ctx, 'cf_settings', `${note ? `${note}\n\n` : ''}${text}`, kb);
}

export async function askChannel(ctx, user) {
  await setState(user.id, 'cf_chat');
  await answer(ctx);
  return show(ctx, 'cf_channel_ask', T(ctx, 'cf.channel_ask'), [[btn(T(ctx, 'btn.cancel'), 'a:cfs')]]);
}

/** A post forwarded from the channel, @name or its numeric id; the bot must post and edit there. */
export async function onChannelInput(ctx, user, kv, message) {
  const origin = message.forward_origin || {};
  const fromForward = (origin.type === 'channel' && origin.chat) || message.forward_from_chat || null;
  const text = toAsciiDigits(String(message.text || '').trim());
  const m = /^(?:https?:\/\/)?(?:t\.me\/|telegram\.me\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(text);
  const ref = fromForward ? fromForward.id : /^-100\d{5,}$/.test(text) ? Number(text) : m ? `@${m[1]}` : null;
  if (!ref) return send(ctx, 'cf_channel_invalid', T(ctx, 'cf.channel_invalid'));
  let chat;
  try {
    chat = await call(ctx, 'getChat', { chat_id: ref }, 'admin_get_chat');
  } catch (err) {
    return send(ctx, 'cf_channel_invalid', T(ctx, 'cf.channel_invalid'));
  }
  if (chat.type !== 'channel') return send(ctx, 'cf_channel_invalid', T(ctx, 'cf.channel_invalid'));
  const bot = await botInfo(ctx, kv);
  let ok = false;
  try {
    const member = await call(ctx, 'getChatMember', { chat_id: chat.id, user_id: bot.id }, 'admin_check');
    ok = member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages !== false && member.can_edit_messages !== false);
  } catch (err) {
    console.warn(`confession channel check failed: ${describeError(err)}`);
  }
  const name = esc(chat.title || String(chat.id));
  if (!ok) return send(ctx, 'cf_channel_not_admin', T(ctx, 'cf.channel_not_admin', { name }));
  await setKv('cf_chat', String(chat.id));
  await setKv('cf_chat_title', String(chat.title || '').slice(0, 64));
  await setKv('cf_username', chat.username || '');
  await setKv('cf_lang', ctx.lang);
  await setKv('cf_on', '1');
  Object.assign(kv, {
    cf_chat: String(chat.id), cf_chat_title: chat.title || '', cf_username: chat.username || '', cf_lang: ctx.lang, cf_on: '1',
  });
  await clearState(user.id);
  ctx.messageId = null;
  return showSettings(ctx, kv, T(ctx, 'cf.channel_saved', { name }));
}

export async function toggleOn(ctx, kv) {
  if (!kv.cf_chat) return answer(ctx, T(ctx, 'cf.no_channel'), { alert: true });
  const on = !isOpen(kv);
  await setKv('cf_on', on ? '1' : '0');
  kv.cf_on = on ? '1' : '0';
  return showSettings(ctx, kv, T(ctx, on ? 'cf.turned_on' : 'cf.turned_off'));
}

export async function removeChannel(ctx, kv) {
  for (const k of ['cf_chat', 'cf_chat_title', 'cf_username']) {
    await setKv(k, null);
    kv[k] = null;
  }
  await setKv('cf_on', '0');
  kv.cf_on = '0';
  return showSettings(ctx, kv, T(ctx, 'cf.channel_removed'));
}

/** One line for the 🩺 page: is the bot able to post in the confession channel? */
export async function confessionChannelStatus(ctx, kv, bot) {
  if (!kv.cf_chat) return T(ctx, 'hl.cf_none');
  const name = esc(kv.cf_chat_title || kv.cf_chat);
  let ok = false;
  try {
    const m = await call(ctx, 'getChatMember', { chat_id: Number(kv.cf_chat), user_id: bot.id }, 'admin_check');
    ok = m.status === 'creator' || (m.status === 'administrator' && m.can_post_messages !== false);
  } catch (err) {
    ok = false;
  }
  return T(ctx, ok ? 'hl.cf_ok' : 'hl.cf_bad', { name }) + (isOpen(kv) ? '' : ` ${T(ctx, 'hl.cf_off')}`);
}
