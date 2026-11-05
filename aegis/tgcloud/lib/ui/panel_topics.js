/*
 * The panel's 🗂 Topics section, for forum supergroups. The Bot API can't list a forum's topics, so
 * Aegis shows the ones it has seen (created, renamed, closed, or written in since it joined) and the
 * ones made here. Create, rename, close / reopen, delete (asks first), read-only for members (Aegis
 * deletes their messages there), and the General topic: close / reopen, hide / show.
 * Viewing needs View; changes need Settings and Aegis's «Manage topics» right.
 *
 * callback_data (chat id c, topic id i):
 *   g:c:T                  topics                 g:c:T:n            new topic (input)
 *   g:c:T:t:i              one topic              g:c:T:t:i:<r|c|o|ro|d|dy>   rename (input), close, reopen,
 *                                                                    read-only, delete → confirm
 *   g:c:T:g:<c|o|h|u>      General: close, reopen, hide, show
 * Pending input: topic_input { chat, thread (0 = new) }.
 */
import { TOPIC_NAME_MAX } from '../config.js';
import * as state from '../core/state.js';
import { answer, btn, call, describeError, screen, send, tryCall } from '../core/tg.js';
import { iso, normalizeWord, parseJson, short, toInt } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as gd from '../engines/groupdata.js';
import { t } from '../i18n/index.js';
import { back, guard, needLevel, pairs, removeKeyboard } from './guard.js';

const { L } = admins;
export const INPUTS = new Set(['topic_input']);
export const KEYBOARD_INPUTS = new Set();
const title = (g) => iso(g.chat.title || '', 48);

async function isForum(ctx, g) {
  if (Number(g.chat.is_forum)) return true;
  const info = await tryCall(ctx, 'getChat', { chat_id: g.chat.chat_id }, 'forum-check');
  return !!(info && info.is_forum);
}

const canManage = (g) => parseJson(g.chat.bot_rights, {}).can_manage_topics === true;

async function list(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'topics.title', { title: title(g) }));
  if (!(await isForum(ctx, g))) {
    lines.push('', t(lang, 'topics.not_forum'));
    return screen(ctx, user.user_id, place, lines.join('\n'), [back(lang, `g:${c}`)], 'panel-topics-none');
  }
  lines.push(t(lang, 'topics.intro'), '');
  if (!canManage(g)) lines.push(t(lang, 'topics.bot_cant'), '');
  const rows = await gd.topicsOf(c);
  if (!rows.length) lines.push(t(lang, 'topics.none'));
  for (const r of rows) lines.push(t(lang, 'topics.line', { mark: Number(r.closed) ? '🔒' : (Number(r.readonly) ? '📖' : '💬'), name: iso(r.name, 40) }));
  const kb = pairs(rows.map((r) => btn(`${Number(r.closed) ? '🔒' : '💬'} ${short(r.name, 24)}`, `g:${c}:T:t:${r.thread_id}`)));
  kb.push([btn(t(lang, 'topics.btn_new'), `g:${c}:T:n`)]);
  kb.push([btn(t(lang, 'topics.btn_general_close'), `g:${c}:T:g:c`), btn(t(lang, 'topics.btn_general_open'), `g:${c}:T:g:o`)]);
  kb.push([btn(t(lang, 'topics.btn_general_hide'), `g:${c}:T:g:h`), btn(t(lang, 'topics.btn_general_show'), `g:${c}:T:g:u`)]);
  kb.push(back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-topics');
}

async function topicScreen(ctx, user, g, tp, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const p = `g:${c}:T:t:${tp.thread_id}`;
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'topics.topic_title', { name: iso(tp.name, 60) }), '');
  lines.push(t(lang, Number(tp.closed) ? 'topics.closed' : 'topics.open'));
  lines.push(t(lang, Number(tp.readonly) ? 'topics.readonly_on' : 'topics.readonly_off'));
  const kb = [[btn(t(lang, 'topics.btn_rename'), `${p}:r`), btn(t(lang, Number(tp.closed) ? 'topics.btn_reopen' : 'topics.btn_close'), `${p}:${Number(tp.closed) ? 'o' : 'c'}`)],
    [btn(t(lang, Number(tp.readonly) ? 'topics.btn_readonly_off' : 'topics.btn_readonly_on'), `${p}:ro`), btn(t(lang, 'topics.btn_delete'), `${p}:d`)],
    back(lang, `g:${c}:T`)];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-topic');
}

/* A topics API call; gives an error notice or ''. */
async function tg(ctx, lang, method, params) {
  try {
    await call(ctx, method, params, `topics-${method}`);
    return '';
  } catch (err) {
    return t(lang, 'chat.tg_error', { error: describeError(err) });
  }
}

export async function callback(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const sub = parts[3];
  if (!sub) return list(ctx, user, g, place);
  if (!(await isForum(ctx, g))) return list(ctx, user, g, place);
  if (sub === 't' && toInt(parts[4]) !== null) {
    const tp = await gd.topic(c, toInt(parts[4]));
    if (!tp) return list(ctx, user, g, place, t(lang, 'topics.gone'));
    const action = parts[5];
    if (!action) return topicScreen(ctx, user, g, tp, place);
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    const id = Number(tp.thread_id);
    if (action === 'ro') {
      await gd.setTopicReadonly(c, id, !Number(tp.readonly));
      return topicScreen(ctx, user, g, await gd.topic(c, id), place);
    }
    if (action === 'r') {
      await state.set(user.user_id, 'topic_input', { chat: c, thread: id });
      await answer(ctx);
      return send(ctx, user.user_id, t(lang, 'topics.name_prompt', { max: TOPIC_NAME_MAX }), null, 'ask-topic-name');
    }
    if (action === 'd') {
      const kb = [[btn(t(lang, 'topics.btn_delete_yes'), `g:${c}:T:t:${id}:dy`), btn(t(lang, 'common.back'), `g:${c}:T:t:${id}`)]];
      return screen(ctx, user.user_id, place, t(lang, 'topics.delete_q', { name: iso(tp.name, 60) }), kb, 'topic-delete?');
    }
    const method = { c: 'closeForumTopic', o: 'reopenForumTopic', dy: 'deleteForumTopic' }[action];
    if (!method) return topicScreen(ctx, user, g, tp, place);
    const err = await tg(ctx, lang, method, { chat_id: c, message_thread_id: id });
    if (err) return topicScreen(ctx, user, g, tp, place, err);
    if (action === 'dy') {
      await gd.forgetTopic(c, id);
      return list(ctx, user, g, place, t(lang, 'topics.deleted', { name: iso(tp.name, 60) }));
    }
    await gd.saveTopic(c, id, { closed: action === 'c' });
    return topicScreen(ctx, user, g, await gd.topic(c, id), place);
  }
  if (!(await needLevel(ctx, user, g, L.settings))) return null;
  if (sub === 'n') {
    await state.set(user.user_id, 'topic_input', { chat: c, thread: 0 });
    await answer(ctx);
    return send(ctx, user.user_id, t(lang, 'topics.name_prompt', { max: TOPIC_NAME_MAX }), null, 'ask-topic-name');
  }
  if (sub === 'g') {
    const method = { c: 'closeGeneralForumTopic', o: 'reopenGeneralForumTopic', h: 'hideGeneralForumTopic', u: 'unhideGeneralForumTopic' }[parts[4]];
    if (!method) return list(ctx, user, g, place);
    const err = await tg(ctx, lang, method, { chat_id: c });
    return list(ctx, user, g, place, err || t(lang, `topics.general_${parts[4]}`));
  }
  return list(ctx, user, g, place);
}

export async function input(ctx, user, message, pending) {
  const lang = user.lang;
  const text = String(message.text || '').trim();
  if (text && normalizeWord(text) === normalizeWord(t(lang, 'common.cancel'))) {
    await state.clear(user.user_id);
    return send(ctx, user.user_id, t(lang, 'common.cancelled'), null, 'input-cancelled', removeKeyboard);
  }
  const g = await guard(ctx, user, pending.data.chat, L.settings, null);
  if (!g) {
    await state.clear(user.user_id);
    return null;
  }
  if (!text || [...text].length > TOPIC_NAME_MAX) return send(ctx, user.user_id, t(lang, 'topics.name_prompt', { max: TOPIC_NAME_MAX }), null, 'topic-name-again');
  await state.clear(user.user_id);
  const c = g.chat.chat_id;
  const thread = Number(pending.data.thread);
  if (!thread) {
    try {
      const made = await call(ctx, 'createForumTopic', { chat_id: c, name: text }, 'topics-create');
      await gd.saveTopic(c, Number(made.message_thread_id), { name: made.name, color: made.icon_color });
      return list(ctx, user, g, null, t(lang, 'topics.created', { name: iso(made.name, 60) }));
    } catch (err) {
      return list(ctx, user, g, null, t(lang, 'chat.tg_error', { error: describeError(err) }));
    }
  }
  const err = await tg(ctx, lang, 'editForumTopic', { chat_id: c, message_thread_id: thread, name: text });
  if (!err) await gd.saveTopic(c, thread, { name: text });
  const tp = await gd.topic(c, thread);
  return tp ? topicScreen(ctx, user, g, tp, null, err || t(lang, 'topics.renamed')) : list(ctx, user, g, null, err);
}
