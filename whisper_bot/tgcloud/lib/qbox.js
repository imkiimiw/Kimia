// Anonymous question boxes for channels ("📢 صندوق سؤال کانال", in the anonymous section). A user
// connects a channel they administer — the bot must be able to post there — and gets a link,
// start=q_<code>. Anyone with the link asks a question anonymously; the box's owner sees the
// questions — never who asked — and answers: the question and the answer are posted to the channel
// with a button for asking another, or as an image card made in the Mini App (lib/card.js, kind qb).
// Offensive words, links and phone numbers are filtered silently, like anonymous messages (the asker
// sees the usual confirmation; the question never reaches the owner). Blocking an asker uses the
// anonymous blocks, so they can't reach this person through their personal link either.
// Storage: lib/qstore.js.
import {
  MAX_QBOXES, QB_ANSWER_MAX, QB_GAP_SEC, QB_NOTIFY_EVERY_SEC, QB_PER_BOX_HOUR, QB_PER_DAY, QB_QUESTION_MAX,
} from './config.js';
import { aiCheck, aiFlagged } from './ai.js';
import { refuses } from './anon.js';
import { addAnonBlock, addStrike } from './astore.js';
import { botInfo, startLink } from './bot.js';
import { cardUrl } from './card.js';
import {
  hasLink, hasPhone, isOffensive, normalize,
} from './filter.js';
import {
  ago, langOf, num, t,
} from './i18n.js';
import {
  addQuestion, claimAnswer, countNew, createBox, deleteBox, dropQuestion, getBox, getBoxByChat, getBoxByCode, getQuestion,
  listBoxes, newQuestionAt, recentQuestionsBy, renewBoxCode, setBoxOpen, setPostedAnswer, unclaimAnswer,
} from './qstore.js';
import {
  claimTurn, clearState, getUser, setState,
} from './store.js';
import {
  answer, btn, call, describeError, send, show, urlBtn, webAppBtn,
} from './tg.js';
import {
  esc, nowSec, toAsciiDigits, truncate,
} from './util.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);
const N = (ctx, n) => num(ctx.lang, n);
const home = (ctx) => [btn(T(ctx, 'btn.home'), 'm')];
const nameOf = (box) => esc(box.title || String(box.chatId));
export const boxLink = (botUsername, box) => startLink(botUsername, `q_${box.code}`);
const isAdmin = (m) => !!m && (m.status === 'creator' || m.status === 'administrator');

// ---------- the owner: boxes ----------

export async function showBoxes(ctx, user, note = '') {
  const boxes = await listBoxes(user.id);
  const kb = boxes.map((b) => [btn(`📢 ${truncate(b.title || String(b.chatId), 40)}`, `qb:v:${b.id}`)]);
  if (boxes.length < MAX_QBOXES) kb.push([btn(T(ctx, 'qb.btn_connect'), 'qb:n')]);
  kb.push([btn(T(ctx, 'btn.back'), 'an')]);
  return show(ctx, 'qbox_list', `${note ? `${note}\n\n` : ''}${T(ctx, 'qb.title')}\n\n${T(ctx, 'qb.intro')}`, kb);
}

export async function askChannel(ctx, user) {
  await setState(user.id, 'qb_chat');
  await answer(ctx);
  return show(ctx, 'qbox_channel_ask', T(ctx, 'qb.channel_ask'), [[btn(T(ctx, 'btn.cancel'), 'qb')]]);
}

/** A post forwarded from the channel, or its @name / numeric id. The user must administer it; the bot must post there. */
export async function onChannelInput(ctx, user, kv, message) {
  const origin = message.forward_origin || {};
  const fromForward = (origin.type === 'channel' && origin.chat) || message.forward_from_chat || null;
  const text = toAsciiDigits(String(message.text || '').trim());
  const m = /^(?:https?:\/\/)?(?:t\.me\/|telegram\.me\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(text);
  const ref = fromForward ? fromForward.id : /^-100\d{5,}$/.test(text) ? Number(text) : m ? `@${m[1]}` : null;
  if (!ref) return send(ctx, 'qbox_channel_invalid', T(ctx, 'qb.channel_invalid'));
  let chat;
  try {
    chat = await call(ctx, 'getChat', { chat_id: ref }, 'qbox_get_chat');
  } catch (err) {
    return send(ctx, 'qbox_channel_invalid', T(ctx, 'qb.channel_invalid'));
  }
  if (chat.type !== 'channel') return send(ctx, 'qbox_channel_invalid', T(ctx, 'qb.channel_invalid'));
  const name = esc(chat.title || String(chat.id));
  const bot = await botInfo(ctx, kv);
  let botOk = false;
  try {
    const bm = await call(ctx, 'getChatMember', { chat_id: chat.id, user_id: bot.id }, 'qbox_check');
    botOk = bm.status === 'creator' || (bm.status === 'administrator' && bm.can_post_messages !== false);
  } catch (err) {
    botOk = false;
  }
  if (!botOk) return send(ctx, 'qbox_bot_not_admin', T(ctx, 'qb.bot_not_admin', { name }));
  let userOk = false;
  try {
    userOk = isAdmin(await call(ctx, 'getChatMember', { chat_id: chat.id, user_id: user.id }, 'qbox_check'));
  } catch (err) {
    userOk = false;
  }
  if (!userOk) return send(ctx, 'qbox_not_admin', T(ctx, 'qb.you_not_admin', { name }));
  const r = await createBox({
    ownerId: user.id, chatId: chat.id, title: String(chat.title || '').slice(0, 64), username: chat.username || '', lang: ctx.lang,
  });
  await clearState(user.id);
  ctx.messageId = null;
  if (r === 'full') return send(ctx, 'qbox_full', T(ctx, 'qb.full', { max: N(ctx, MAX_QBOXES) }), [[btn(T(ctx, 'btn.back'), 'qb')]]);
  if (r === 'dup') {
    const existing = await getBoxByChat(chat.id);
    if (existing && existing.ownerId === user.id) return showBox(ctx, kv, existing, T(ctx, 'qb.already_yours'));
    return send(ctx, 'qbox_taken', T(ctx, 'qb.taken', { name }), [[btn(T(ctx, 'btn.back'), 'qb')]]); // never says who
  }
  return showBox(ctx, kv, r.box, T(ctx, 'qb.connected', { name }));
}

export async function showBox(ctx, kv, box, note = '') {
  const bot = await botInfo(ctx, kv);
  const fresh = await countNew(box.id);
  const text = T(ctx, 'qb.box', {
    name: nameOf(box),
    link: boxLink(bot.username, box),
    n: N(ctx, fresh),
    asked: N(ctx, box.asked),
    answered: N(ctx, box.answered),
    state: T(ctx, box.open ? 'qb.state_open' : 'qb.state_closed'),
  });
  const kb = [
    [btn(T(ctx, 'qb.btn_questions', { n: N(ctx, fresh) }), `qb:l:${box.id}:0`)],
    [btn(T(ctx, 'qb.btn_invite'), `qb:p:${box.id}`)],
    [btn(T(ctx, box.open ? 'qb.btn_close' : 'qb.btn_open'), `qb:t:${box.id}`), btn(T(ctx, 'qb.btn_new_link'), `qb:r:${box.id}`)],
    [btn(T(ctx, 'qb.btn_delete'), `qb:x:${box.id}`), btn(T(ctx, 'btn.back'), 'qb')],
  ];
  return show(ctx, 'qbox', `${note ? `${note}\n\n` : ''}${text}`, kb);
}

/** One new question at a time, oldest first: answer, delete or block (the asker is never shown). */
export async function showQuestion(ctx, kv, box, offset = 0) {
  const { q, total } = await newQuestionAt(box.id, offset);
  if (!q) {
    if (offset > 0 && total) return showQuestion(ctx, kv, box, 0);
    return show(ctx, 'qbox_question', T(ctx, 'qb.none', { name: nameOf(box) }), [[btn(T(ctx, 'btn.back'), `qb:v:${box.id}`)]]);
  }
  const text = T(ctx, 'qb.question', {
    i: N(ctx, offset + 1), n: N(ctx, total), name: nameOf(box), ago: ago(ctx.lang, q.createdAt, nowSec()), body: esc(q.body),
  });
  const kb = [
    [btn(T(ctx, 'qb.btn_answer'), `qb:a:${q.id}`)],
    [btn(T(ctx, 'qb.btn_drop'), `qb:d:${q.id}`), btn(T(ctx, 'qb.btn_block'), `qb:b:${q.id}`)],
  ];
  const nav = [];
  if (total > 1) nav.push(btn(T(ctx, 'btn.next'), `qb:l:${box.id}:${(offset + 1) % total}`));
  nav.push(btn(T(ctx, 'btn.back'), `qb:v:${box.id}`));
  kb.push(nav);
  return show(ctx, 'qbox_question', text, kb, { secret: true, meta: { id: q.id, i: offset, total } });
}

/** A question of one of this user's boxes, with its box; null (after saying why) otherwise. */
async function ownQuestion(ctx, user, qid) {
  const q = await getQuestion(qid);
  const box = q ? await getBox(q.boxId) : null;
  if (!q || !box || box.ownerId !== user.id) {
    await answer(ctx, T(ctx, 'qb.not_yours'), { alert: true });
    return null;
  }
  return { q, box };
}

/** Is the user still an admin of the channel? (A failing check is left to the post itself.) */
async function stillAdmin(ctx, box, user) {
  try {
    return isAdmin(await call(ctx, 'getChatMember', { chat_id: box.chatId, user_id: user.id }, 'qbox_check'));
  } catch (err) {
    return true;
  }
}

export async function startAnswer(ctx, user, qid) {
  const own = await ownQuestion(ctx, user, qid);
  if (!own) return null;
  if (own.q.status !== 'new') return answer(ctx, T(ctx, 'qb.gone'), { alert: true });
  await setState(user.id, 'qb_answer', { q: own.q.id });
  await answer(ctx);
  ctx.messageId = null;
  return send(ctx, 'qbox_answer_ask', T(ctx, 'qb.answer_ask', { name: nameOf(own.box), max: N(ctx, QB_ANSWER_MAX) }),
    [[btn(T(ctx, 'btn.cancel'), `qb:l:${own.box.id}:0`)]]);
}

/** The answer arrived (state qb_answer): the question and the answer are posted to the channel. */
export async function onAnswer(ctx, user, kv, message, st) {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text) return send(ctx, 'qbox_text_only', T(ctx, 'qb.text_only'));
  if (text.length > QB_ANSWER_MAX) return send(ctx, 'qbox_too_long', T(ctx, 'qb.too_long', { max: N(ctx, QB_ANSWER_MAX) }));
  const q = await getQuestion(st.data.q);
  const box = q ? await getBox(q.boxId) : null;
  if (!q || !box || box.ownerId !== user.id || q.status !== 'new') {
    await clearState(user.id);
    return send(ctx, 'qbox_gone', T(ctx, 'qb.gone'), [[btn(T(ctx, 'btn.back'), 'qb')]]);
  }
  if (!(await stillAdmin(ctx, box, user))) return send(ctx, 'qbox_not_admin', T(ctx, 'qb.you_not_admin', { name: nameOf(box) }));
  if (!(await claimAnswer(q.id, text))) {
    await clearState(user.id);
    return send(ctx, 'qbox_gone', T(ctx, 'qb.gone'), [[btn(T(ctx, 'btn.back'), `qb:v:${box.id}`)]]);
  }
  const bot = await botInfo(ctx, kv);
  let posted;
  try {
    posted = await send(ctx, 'qbox_post', t(box.lang, 'qb.post', { q: esc(q.body), a: esc(text) }),
      [[urlBtn(t(box.lang, 'qb.btn_ask'), boxLink(bot.username, box))]], box.chatId, { rethrow: true, secret: true });
  } catch (err) {
    await unclaimAnswer(q.id); // stays in the list: the channel refused the post
    return send(ctx, 'qbox_post_failed', T(ctx, 'qb.post_failed', { err: esc(truncate(describeError(err), 120)) }),
      [[btn(T(ctx, 'btn.back'), `qb:v:${box.id}`)]]);
  }
  await setPostedAnswer(q.id, box.id, posted.message_id);
  await clearState(user.id);
  await tellAsker(ctx, box, q, posted.message_id);
  ctx.messageId = null;
  const kb = [];
  if (bot.id) kb.push([webAppBtn(T(ctx, 'qb.btn_card'), cardUrl(bot.id, { k: 'qb', id: q.id, l: ctx.lang }))]);
  kb.push([btn(T(ctx, 'qb.btn_next'), `qb:l:${box.id}:0`), btn(T(ctx, 'btn.back'), `qb:v:${box.id}`)]);
  return send(ctx, 'qbox_answered', T(ctx, 'qb.answered', { name: nameOf(box) }), kb);
}

/** The asker learns their question was answered — nothing more, and nobody learns who they are. */
async function tellAsker(ctx, box, q, msgId) {
  if (!q.fromId) return;
  const asker = await getUser(q.fromId);
  if (!asker || !asker.started || !asker.active || asker.banned) return;
  const alang = langOf(asker);
  const kb = box.username ? [[urlBtn(t(alang, 'qb.btn_see_answer'), `https://t.me/${box.username}/${msgId}`)]] : null;
  await send(ctx, 'qbox_asker', t(alang, 'qb.asker_answered', { name: nameOf(box) }), kb, asker.id, { silent: true });
}

/** 🗑 or 🚫: the question goes; 🚫 also blocks the asker from this person (and counts as a strike). */
export async function drop(ctx, user, kv, qid, { block = false } = {}) {
  const own = await ownQuestion(ctx, user, qid);
  if (!own) return null;
  if (!(await dropQuestion(own.q.id))) return answer(ctx, T(ctx, 'qb.gone'), { alert: true });
  if (block && own.q.fromId) {
    if ((await addAnonBlock(user.id, own.q.fromId)) === 'ok') await addStrike(own.q.fromId, user.id);
  }
  await answer(ctx, T(ctx, block ? 'qb.blocked' : 'qb.dropped'), block ? { alert: true } : {});
  return showQuestion(ctx, kv, own.box, 0);
}

export async function postInvite(ctx, user, kv, box) {
  if (!(await stillAdmin(ctx, box, user))) return answer(ctx, T(ctx, 'qb.you_not_admin', { name: nameOf(box) }), { alert: true });
  const bot = await botInfo(ctx, kv);
  try {
    await send(ctx, 'qbox_invite', t(box.lang, 'qb.invite_post', { name: nameOf(box) }),
      [[urlBtn(t(box.lang, 'qb.btn_ask'), boxLink(bot.username, box))]], box.chatId, { rethrow: true });
  } catch (err) {
    return answer(ctx, T(ctx, 'qb.post_failed', { err: truncate(describeError(err), 120) }), { alert: true });
  }
  return answer(ctx, T(ctx, 'qb.invite_done'), { alert: true });
}

/** Every qb:* button: the box (or question) must be the user's own. */
export async function route(ctx, user, kv, action, arg, arg2) {
  if (!action) {
    await clearState(user.id);
    return showBoxes(ctx, user);
  }
  if (action === 'n') return askChannel(ctx, user);
  if (action === 'a') return startAnswer(ctx, user, arg);
  if (action === 'd') return drop(ctx, user, kv, arg);
  if (action === 'b') return drop(ctx, user, kv, arg, { block: true });
  const box = await getBox(arg);
  if (!box || box.ownerId !== user.id) return answer(ctx, T(ctx, 'qb.not_yours'), { alert: true });
  switch (action) {
    case 'v':
      await clearState(user.id);
      return showBox(ctx, kv, box);
    case 'l':
      await clearState(user.id);
      return showQuestion(ctx, kv, box, Number(arg2) || 0);
    case 'p':
      return postInvite(ctx, user, kv, box);
    case 't':
      await setBoxOpen(box.id, !box.open);
      await answer(ctx, T(ctx, box.open ? 'qb.closed_short' : 'qb.opened_short'));
      return showBox(ctx, kv, { ...box, open: !box.open });
    case 'r': {
      const code = await renewBoxCode(box.id);
      await answer(ctx, T(ctx, 'qb.renewed'), { alert: true });
      return showBox(ctx, kv, { ...box, code });
    }
    case 'x':
      return show(ctx, 'qbox_delete_ask', T(ctx, 'qb.delete_ask', { name: nameOf(box) }),
        [[btn(T(ctx, 'qb.btn_delete_yes'), `qb:xy:${box.id}`), btn(T(ctx, 'btn.no'), `qb:v:${box.id}`)]]);
    case 'xy':
      await deleteBox(box.id);
      await answer(ctx, T(ctx, 'qb.deleted', { name: box.title || '' }));
      return showBoxes(ctx, user, T(ctx, 'qb.deleted', { name: nameOf(box) }));
    default:
      return answer(ctx, T(ctx, 'e.old_button'));
  }
}

// ---------- the asker ----------

/**
 * /start q_<code>: the box is remembered first (state qb_ask), so it survives the language and join
 * screens. Returns the box, or null after saying why it can't be used.
 */
export async function openBox(ctx, user, code) {
  const box = /^[0-9A-Za-z]{10}$/.test(String(code)) ? await getBoxByCode(code) : null;
  if (!box) {
    await send(ctx, 'qbox_invalid', T(ctx, 'qb.link_invalid'), [home(ctx)]);
    return null;
  }
  if (box.ownerId === user.id) {
    await send(ctx, 'qbox_own', T(ctx, 'qb.own_box'), [[btn(T(ctx, 'qb.btn_manage'), `qb:v:${box.id}`)], home(ctx)]);
    return null;
  }
  if (!box.open) {
    await send(ctx, 'qbox_closed', T(ctx, 'qb.closed', { name: nameOf(box) }), [home(ctx)]);
    return null;
  }
  if (await refuses(box.ownerId, user.id)) {
    await send(ctx, 'anon_refused', T(ctx, 'a.refused'), [home(ctx)]);
    return null;
  }
  await setState(user.id, 'qb_ask', { box: box.id });
  return box;
}

export async function showAsk(ctx, box) {
  ctx.messageId = null;
  return send(ctx, 'qbox_ask', T(ctx, 'qb.ask', { name: nameOf(box), max: N(ctx, QB_QUESTION_MAX) }), [[btn(T(ctx, 'btn.cancel'), 'm')]]);
}

/** "✍️ another question" (qba:<code>): the code, so a renewed link also stops this button. */
export async function askAgain(ctx, user, code) {
  await answer(ctx);
  const box = await openBox(ctx, user, code);
  return box ? showAsk(ctx, box) : null;
}

/** null, or which limit this question would break: 'gap' | 'box' | 'day'. */
async function rateLimit(userId, boxId) {
  const now = nowSec();
  const recent = await recentQuestionsBy(userId, now - 86400, QB_PER_DAY);
  if (recent.length >= QB_PER_DAY) return 'day';
  // a stamp from a machine whose clock runs ahead (in the future) is not a flood
  if (recent.length && now >= recent[0].at && now - recent[0].at < QB_GAP_SEC) return 'gap';
  if (recent.filter((x) => x.boxId === boxId && x.at >= now - 3600).length >= QB_PER_BOX_HOUR) return 'box';
  return null;
}

/** What hides a question from the owner: offensive words, links, phone numbers (it may be posted), the smart filter. */
async function filterOf(ctx, text, entities) {
  if (isOffensive(normalize(text))) return 'offensive';
  if (hasLink(text, entities)) return 'link';
  if (hasPhone(text)) return 'phone';
  if (aiFlagged(await aiCheck(ctx, text))) return 'ai';
  return null;
}

/** A question arrived (state qb_ask). */
export async function onQuestion(ctx, user, kv, message, st) {
  const box = await getBox(st.data.box);
  if (!box || !box.open) {
    await clearState(user.id);
    return send(ctx, 'qbox_closed', T(ctx, 'qb.closed', { name: box ? nameOf(box) : '' }), [home(ctx)]);
  }
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text) return send(ctx, 'qbox_text_only', T(ctx, 'qb.text_only'));
  if (text.length > QB_QUESTION_MAX) return send(ctx, 'qbox_too_long', T(ctx, 'qb.too_long', { max: N(ctx, QB_QUESTION_MAX) }));
  if (user.restrictedUntil > nowSec()) return send(ctx, 'qbox_restricted', T(ctx, 'qb.restricted'));
  if (await refuses(box.ownerId, user.id)) {
    await clearState(user.id);
    return send(ctx, 'anon_refused', T(ctx, 'a.refused'), [home(ctx)]);
  }
  const limit = await rateLimit(user.id, box.id);
  if (limit) return send(ctx, `qbox_limit_${limit}`, T(ctx, `qb.limit_${limit}`, { n: N(ctx, limit === 'box' ? QB_PER_BOX_HOUR : QB_PER_DAY) }));
  const reason = await filterOf(ctx, text, message.entities);
  await addQuestion(box.id, user.id, text, reason ? 'filtered' : 'new');
  await clearState(user.id);
  ctx.filtered = reason || undefined;
  if (!reason) await notifyOwner(ctx, box);
  return send(ctx, 'qbox_sent', T(ctx, 'qb.sent', { name: nameOf(box) }), [[btn(T(ctx, 'qb.btn_again'), `qba:${box.code}`)], home(ctx)]);
}

/** "❓ new questions" to the box's owner, at most every QB_NOTIFY_EVERY_SEC per box. */
async function notifyOwner(ctx, box) {
  if (!(await claimTurn(`qbn:${box.id}`, QB_NOTIFY_EVERY_SEC))) return;
  const owner = await getUser(box.ownerId);
  if (!owner || !owner.started || !owner.active) return;
  const lang = langOf(owner);
  const n = num(lang, await countNew(box.id));
  await send(ctx, 'qbox_notice', t(lang, 'qb.notice', { name: nameOf(box), n }),
    [[btn(t(lang, 'qb.btn_questions', { n }), `qb:l:${box.id}:0`)]], owner.id);
}
