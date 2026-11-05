/*
 * The Mini App Telegram opens for a join request when Aegis is the chat's guard bot (Bot API 10.1):
 * webapp/join.html asks { action: 'get' } for the captcha (question and options, in the person's
 * language) and sends { action: 'answer', choice }. The request is known from the init data Telegram
 * signs and the platform verifies (user, chat, chat_join_request_query_id), never from the input;
 * the decision goes back with answerChatJoinRequestQuery (ui/security.js → ui/channel.js).
 */
import { EndpointError } from 'sdk';
import * as errors from '../lib/core/errors.js';
import { createCtx } from '../lib/core/tg.js';
import { parseJson } from '../lib/core/util.js';
import * as channels from '../lib/engines/channels.js';
import * as chats from '../lib/engines/chats.js';
import * as guards from '../lib/engines/guards.js';
import * as users from '../lib/engines/users.js';
import { isRtl, pickLang, t } from '../lib/i18n/index.js';
import { answerCaptcha, questionText } from '../lib/ui/security.js';

const plain = (s) => String(s).replace(/[\u200F\u2068\u2069]/g, '');

export default async function (input, pctx) {
  const init = (pctx && pctx.initData) || {};
  const user = init.user;
  const chat = init.chat;
  const query = init.chat_join_request_query_id;
  if (!user || !chat || !query) throw new EndpointError('Not a join request', { code: 'NO_REQUEST' });
  const u = await users.get(user.id);
  const lang = u && Number(u.lang_set) ? u.lang : pickLang(user.language_code);
  const name = String(chat.title || '');
  const base = { lang, rtl: isRtl(lang), title: plain(t(lang, 'ch.guard_title', { title: name })), close: plain(t(lang, 'app.close')) };
  const known = await chats.get(chat.id);
  const row = await guards.pendingCaptcha(chat.id, user.id);
  const req = await channels.openRequest(chat.id, user.id);
  if (!known || !row || row.kind !== 'guard' || !req || req.query !== query) return { ...base, done: true, text: plain(t(lang, 'ch.guard_gone')) };
  const options = parseJson(row.options, []) || [];
  if (input && input.action === 'answer') {
    const ctx = createCtx({ kind: 'endpoint' });
    try {
      const r = await answerCaptcha(ctx, known, row, input.choice);
      return { ...base, done: r !== 'wrong', result: r, text: plain(t(lang, `ch.guard_${r}`, { title: name })) };
    } catch (err) {
      await errors.record(ctx, err, { source: 'endpoint.joinGuard', userId: user.id, chatId: chat.id });
      throw err;
    }
  }
  const math = options.every((o) => /^\d+$/.test(String(o)));
  return { ...base, question: plain(questionText(lang, { kind: math ? 'math' : 'button', target: row.question })), hint: plain(t(lang, 'ch.guard_hint')), options };
}
