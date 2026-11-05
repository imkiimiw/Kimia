// "🖼 کارت": shareable image cards for Telegram and Instagram (story 9:16, post 4:5, square). The
// card is drawn in the user's own Telegram client by the bot's Mini App (webapp/, hosted by the
// platform next to the bot), where fonts for Persian, Russian and English are available; the Mini
// App then sends the finished JPEG back through the cardSend endpoint and the bot posts it to the
// user's chat, ready to save to the gallery for Instagram or to share in Telegram.
//
// Kinds: link (my anonymous link + question, with a QR code), q (the question of the day), msg (an
// anonymous message I received, with an optional answer — never anything about who sent it).
import { InputFile } from 'sdk';
import { getAnonMsg } from './astore.js';
import { displayNameOf, ensureAnonCode, linkOf, ratingLine } from './anon.js';
import { botInfo } from './bot.js';
import { langOf, t } from './i18n.js';
import { questionOf, questionOfDay } from './qotd.js';
import { getKv, getUser } from './store.js';
import { btn, call, show, webAppBtn } from './tg.js';
import { base64ToBytes } from './util.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);
const MAX_CARD_BYTES = 3 * 1024 * 1024;

/** The Mini App's address: the platform serves it at app<bot id>.tgcloud.ai. */
export function cardUrl(botId, params) {
  const q = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `https://app${botId}.tgcloud.ai/?${q}`;
}

export async function showCards(ctx, user, kv) {
  const bot = await botInfo(ctx, kv);
  const kb = [];
  if (bot.id) {
    kb.push([webAppBtn(T(ctx, 'cd.btn_link'), cardUrl(bot.id, { k: 'link', l: ctx.lang }))]);
    kb.push([webAppBtn(T(ctx, 'cd.btn_q'), cardUrl(bot.id, { k: 'q', l: ctx.lang }))]);
  }
  kb.push([btn(T(ctx, 'cd.btn_from_inbox'), 'ib:0:-:0'), btn(T(ctx, 'btn.back'), 'an')]);
  return show(ctx, 'cards', T(ctx, 'cd.text'), kb);
}

/** cardData endpoint: what to draw. Only the caller's own link, question or messages. */
export async function cardData(userId, input) {
  const user = await getUser(userId);
  if (!user) return { error: 'NO_USER' };
  const lang = langOf(user);
  const kv = await getKv(['bot_id', 'bot_username']);
  const bot = await botInfo({ trace: [] }, kv);
  const base = {
    lang,
    name: displayNameOf(user, lang),
    rating: user.showRating && user.ratingCount ? ratingLine(lang, user).replace(/<[^>]+>/g, '') : '',
    brand: bot.username ? `@${bot.username}` : '',
    labels: {
      story: t(lang, 'cd.ui_story'), post: t(lang, 'cd.ui_post'), square: t(lang, 'cd.ui_square'), theme: t(lang, 'cd.ui_theme'),
      send: t(lang, 'cd.ui_send'), sending: t(lang, 'cd.ui_sending'), sent: t(lang, 'cd.ui_sent'), failed: t(lang, 'cd.ui_failed'),
      answer: t(lang, 'cd.ui_answer'), title: t(lang, 'cd.ui_title'),
    },
  };
  if (input.k === 'msg') {
    const m = /^[0-9A-Za-z]{10}$/.test(String(input.id)) ? await getAnonMsg(String(input.id)) : null;
    if (!m || m.toId !== user.id) return { error: 'NOT_YOURS' };
    return { ...base, kind: 'msg', head: t(lang, 'cd.msg_head'), text: m.body || '', q: m.q || '', foot: t(lang, 'cd.msg_foot') };
  }
  const link = bot.username ? linkOf(bot.username, await ensureAnonCode(user)) : '';
  if (input.k === 'q') {
    const q = questionOf(user) || questionOfDay(lang);
    return { ...base, kind: 'q', head: t(lang, 'cd.q_head'), text: q, link, foot: t(lang, 'cd.link_foot') };
  }
  return { ...base, kind: 'link', head: t(lang, 'cd.link_head'), text: questionOf(user) || t(lang, 'cd.link_text'), link, foot: t(lang, 'cd.link_foot') };
}

/** cardSend endpoint: the finished JPEG/PNG (base64) is sent to the caller's own chat as a photo. */
export async function cardSend(userId, input, ctx = { trace: [] }) {
  const user = await getUser(userId);
  if (!user) return { error: 'NO_USER' };
  const bytes = base64ToBytes(input.image);
  if (!bytes || bytes.length < 100) return { error: 'BAD_IMAGE' };
  if (bytes.length > MAX_CARD_BYTES) return { error: 'TOO_BIG' };
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!png && !jpeg) return { error: 'BAD_IMAGE' };
  const lang = langOf(user);
  const kv = await getKv(['bot_id', 'bot_username']);
  const bot = await botInfo(ctx, kv);
  const link = bot.username && input.k !== 'msg' ? linkOf(bot.username, await ensureAnonCode(user)) : '';
  await call(ctx, 'sendPhoto', {
    chat_id: user.id,
    photo: new InputFile(bytes, png ? 'card.png' : 'card.jpg', { type: png ? 'image/png' : 'image/jpeg' }),
    caption: link ? t(lang, 'cd.sent_caption_link', { link }) : t(lang, 'cd.sent_caption'),
    parse_mode: 'HTML',
  }, 'card_photo');
  return { ok: true, bytes: bytes.length };
}
