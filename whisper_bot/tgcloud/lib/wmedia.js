// Media whispers: a photo, video, voice, file… for up to 3 recipients. Inline mode can't carry media,
// so one is made here in the bot's chat: the user sends the media — the recipients and options
// (! one-time, 1h expiry, >20:00 time capsule) in its caption, or in a second message — and the bot
// stores it (whispers.kind / file_id) with a button that opens the chat picker with the inline query
// "mw_<id>" (lib/whisper.js mediaArticle). The posted message is like any whisper's; the media opens
// in the bot's chat for the sender and the recipients only, protected from forwarding and saving.
import { MEDIA_WHISPER_MAX } from './config.js';
import { contentOf } from './anon.js';
import { botInfo } from './bot.js';
import { dur, num, t } from './i18n.js';
import { parseQuery } from './parse.js';
import { clearState, createWhisper, setState } from './store.js';
import {
  answer, btn, inlineBtn, send, show,
} from './tg.js';
import {
  esc, nextLocalTime, nowSec, randomId,
} from './util.js';
import { clockOf, joinNames, resolveRecipients } from './whisper.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);
const cancel = (ctx) => [[btn(T(ctx, 'btn.cancel'), 'ws')]];
const PARSE_ERRORS = ['too_many', 'bad_expiry', 'bad_capsule'];

export async function ask(ctx, user) {
  await setState(user.id, 'wm_wait');
  await answer(ctx);
  return show(ctx, 'wmedia_ask', T(ctx, 'wm.ask'), cancel(ctx));
}

/** The media arrived (state wm_wait): with its recipients in the caption, or they're asked for. */
export async function onMedia(ctx, user, kv, message) {
  const c = contentOf(message);
  if (!c || c.kind === 'text') return send(ctx, 'wmedia_need', T(ctx, 'wm.need_media'), cancel(ctx));
  const p = parseQuery(c.body);
  if (p.recipients && p.recipients.length && (!p.error || p.error === 'no_text')) {
    return create(ctx, user, kv, { kind: c.kind, fileId: c.fileId }, p, p.text || '');
  }
  await setState(user.id, 'wm_to', { k: c.kind, f: c.fileId, c: !p.error && p.text ? p.text : '' });
  const note = PARSE_ERRORS.includes(p.error) ? `${T(ctx, `w.err.${p.error}.title`)}\n\n` : '';
  return send(ctx, 'wmedia_ask_to', `${note}${T(ctx, 'wm.ask_to')}`, cancel(ctx));
}

/** Who it's for (state wm_to), with the options; the caption stays the text unless this has one. */
export async function onRecipients(ctx, user, kv, message, st) {
  if (typeof message.text !== 'string') {
    if (contentOf(message)) return onMedia(ctx, user, kv, message); // another media replaces the first
    return send(ctx, 'wmedia_need_to', T(ctx, 'wm.need_to'), cancel(ctx));
  }
  const p = parseQuery(message.text);
  if (PARSE_ERRORS.includes(p.error)) return send(ctx, 'wmedia_bad', `${T(ctx, `w.err.${p.error}.title`)}\n${T(ctx, `w.err.${p.error}.desc`)}`, cancel(ctx));
  if (!p.recipients || !p.recipients.length) return send(ctx, 'wmedia_need_to', T(ctx, 'wm.need_to'), cancel(ctx));
  return create(ctx, user, kv, { kind: st.data.k, fileId: st.data.f }, p, p.text || st.data.c || '');
}

async function create(ctx, user, kv, media, p, body) {
  if (body.length > MEDIA_WHISPER_MAX) return send(ctx, 'wmedia_too_long', T(ctx, 'wm.too_long', { max: num(ctx.lang, MEDIA_WHISPER_MAX) }), cancel(ctx));
  const bot = await botInfo(ctx, kv);
  const res = await resolveRecipients(user, p.recipients, bot.username, ctx.lang);
  if (res.error) { // the state stays: they can send other recipients
    const desc = res.error === 'blocked' ? T(ctx, 'w.err.blocked.desc', { who: res.who }) : T(ctx, `w.err.${res.error}.desc`);
    return send(ctx, 'wmedia_refused', `${T(ctx, `w.err.${res.error}.title`)}\n${desc}`, cancel(ctx));
  }
  const expiry = p.expiry != null ? p.expiry : user.defExpiry;
  const now = nowSec();
  const opensAt = p.capsule ? nextLocalTime(p.capsule.h, p.capsule.m, now) : 0;
  const id = randomId(8);
  await createWhisper({
    id,
    senderId: user.id,
    body,
    once: !!p.once,
    expiresAt: expiry ? (opensAt || now) + expiry : 0,
    recipients: res.rcpts.map((r) => ({ rid: r.rid, runame: r.runame, label: r.label })),
    inlineId: null,
    lang: ctx.lang,
    kind: media.kind,
    fileId: media.fileId,
    opensAt,
  });
  await clearState(user.id);
  const lines = [T(ctx, 'wm.ready', { kind: T(ctx, `kind.${media.kind}`), who: joinNames(ctx.lang, res.rcpts.map((r) => esc(r.label))) })];
  if (opensAt) lines.push(T(ctx, 'w.capsule_line', { at: clockOf(ctx.lang, opensAt) }));
  if (p.once) lines.push(T(ctx, 'w.once_line'));
  if (expiry) lines.push(T(ctx, 'w.expiry_line', { d: dur(ctx.lang, expiry) }));
  lines.push('', T(ctx, 'wm.how_to_post'));
  return send(ctx, 'wmedia_ready', lines.join('\n'), [[inlineBtn(T(ctx, 'wm.btn_post'), `mw_${id}`)], [btn(T(ctx, 'w.btn_details'), `d:${id}`)]],
    ctx.chatId, { meta: { id } });
}
