// "🌟 سؤال روز": a question for the link. Mode 1 uses the question of the day — the same pool in
// every language (lib/i18n/*.js "qotd"), one per Tehran calendar day, so nothing has to be scheduled —
// mode 2 the user's own question, mode 0 none. Visitors of the link see it, and their messages are
// filed as answers to it.
import { QUESTION_MAX } from './config.js';
import { langOf, list, t } from './i18n.js';
import { clearState, setState, setUserField } from './store.js';
import {
  answer, btn, send, show,
} from './tg.js';
import { esc, localDayIndex } from './util.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);

/** Today's question of the day in `lang`. */
export function questionOfDay(lang) {
  const pool = list(lang, 'qotd');
  return pool.length ? pool[localDayIndex() % pool.length] : '';
}

/** The question on `user`'s link right now (in their language), or null. */
export function questionOf(user) {
  if (user.qMode === 1) return questionOfDay(langOf(user));
  if (user.qMode === 2 && user.qText) return user.qText;
  return null;
}

export async function showQotd(ctx, user, note = '') {
  const mode = user.qMode;
  const current = questionOf(user);
  const kb = [
    [btn(`${mode === 1 ? '✅ ' : ''}${T(ctx, 'q.btn_daily')}`, 'qd:d')],
    [btn(`${mode === 2 ? '✅ ' : ''}${T(ctx, 'q.btn_own')}`, 'qd:c'), btn(`${mode === 0 ? '✅ ' : ''}${T(ctx, 'q.btn_none')}`, 'qd:0')],
    [btn(T(ctx, 'q.btn_card'), 'cd'), btn(T(ctx, 'btn.back'), 'an')],
  ];
  const text = T(ctx, 'q.text', {
    today: esc(questionOfDay(ctx.lang)),
    current: current ? esc(current) : T(ctx, 'q.no_question'),
  });
  return show(ctx, 'qotd', `${note ? `${note}\n\n` : ''}${text}`, kb);
}

export async function setMode(ctx, user, mode) {
  if (mode === 'c') {
    await setState(user.id, 'qotd_custom');
    await answer(ctx);
    return show(ctx, 'qotd_ask', T(ctx, 'q.ask', { max: QUESTION_MAX }), [[btn(T(ctx, 'btn.cancel'), 'qd')]]);
  }
  user.qMode = mode === 'd' ? 1 : 0;
  await setUserField(user.id, 'q_mode', user.qMode);
  await answer(ctx, T(ctx, user.qMode ? 'q.set_daily' : 'q.set_none'));
  return showQotd(ctx, user);
}

/** The user's own question, typed after "✍️ سؤال خودم". */
export async function onCustomQuestion(ctx, user, text) {
  const q = String(text || '').trim();
  if (!q) return send(ctx, 'qotd_invalid', T(ctx, 'q.invalid'));
  if (q.length > QUESTION_MAX) return send(ctx, 'qotd_invalid', T(ctx, 'q.too_long', { max: QUESTION_MAX }));
  await clearState(user.id);
  user.qMode = 2;
  user.qText = q;
  await setUserField(user.id, 'q_text', q);
  await setUserField(user.id, 'q_mode', 2);
  ctx.messageId = null;
  return showQotd(ctx, user, T(ctx, 'q.set_own'));
}
