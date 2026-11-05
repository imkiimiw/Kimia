// Search for everyone (spec §9): inline mode (@bot <query> in any chat), private-chat search
// (/search, or any plain text), result buttons that send the audio by file_id, and the t_<id>
// deep link. Only active tracks, only our catalog; nothing slow runs in the inline path.
import { BOT_USERNAME } from '../config/static.js';
import { t, tp } from '../i18n/index.js';
import { btn, markup } from './keyboards.js';
import { truncate } from '../core/util.js';
import { inlineGateAnswer } from '../forcejoin/gate.js';
import { captionValues, renderCaption } from '../publishing/captions.js';
import { classify } from '../telegram/errors.js';

const PRIVATE_PAGE = 10;
const label = (lang, tr) => truncate(`${tr.title || tp(lang, 'trk.untitled')} — ${tr.artist || '?'}`, 56);

/** answerInlineQuery parameters for a page of results (pure). */
export function inlineAnswer(queryId, page, { lang, cacheTime, caption }) {
  const results = page.tracks.map((tr) => {
    const r = { type: 'audio', id: tr.public_id, audio_file_id: tr.audio_file_id };
    if (caption) {
      const text = renderCaption(caption, captionValues(tr, { botUsername: BOT_USERNAME, languageName: (l) => tp(lang, `tlang.${l}`), genreName: (g) => tp(lang, `genre.${g}`) }));
      if (text) Object.assign(r, { caption: text, parse_mode: 'HTML' });
    }
    return r;
  });
  const answer = { inline_query_id: queryId, results, is_personal: true, cache_time: cacheTime, next_offset: page.more ? String(page.offset + page.tracks.length) : '' };
  if (!results.length && page.offset === 0 && page.q.tokens.length) answer.button = { text: tp(lang, 'inline.no_results_button'), start_parameter: 'search' };
  return answer;
}

/** inline_query: gate, search, answer (one Bot API call). */
export async function onInlineQuery(app, q) {
  if (!q || !q.from || q.from.is_bot) return 'ignored';
  const user = await app.users.touchInline(q.from);
  app.user = user;
  app.lang = await app.users.languageOf(user);
  const answer = (params) => app.tg.call('answerInlineQuery', params, 'inline').catch((e) => {
    if (classify(e).kind !== 'query_expired') throw e;
    app.log.warn('inline_query_expired', { user_id: q.from.id });
  });
  if (user.is_banned) {
    await answer({ inline_query_id: q.id, results: [], is_personal: true, cache_time: 0 });
    return 'banned';
  }
  const verdict = await app.forcejoin.check(user);
  if (!verdict.passed) {
    await answer(inlineGateAnswer(q.id, app.lang));
    return 'gated';
  }
  const offset = /^\d{1,4}$/.test(String(q.offset || '')) ? Number(q.offset) : 0;
  const limit = Number(await app.settings.get('inline.page_size'));
  const page = await app.search.query(q.query, { limit, offset });
  await answer(inlineAnswer(q.id, page, { lang: app.lang, cacheTime: Number(await app.settings.get('inline.cache_time')), caption: await app.settings.get('inline.caption') }));
  return { results: page.tracks.length, offset, more: page.more };
}

/** chosen_inline_result: counts a play (needs /setinlinefeedback in BotFather). */
export async function onChosenInlineResult(app, r) {
  if (!r || !/^[A-Za-z0-9]{8,10}$/.test(String(r.result_id || ''))) return 'ignored';
  return (await app.search.addPlay(r.result_id)) ? 'counted' : 'unknown_track';
}

/** The results message of a private search (page = 0-based). */
async function resultsView(app, text, page) {
  const lang = app.lang;
  const res = await app.search.query(text, { limit: PRIVATE_PAGE, offset: page * PRIVATE_PAGE });
  if (!res.q.tokens.length) return { text: t(lang, 'search.prompt'), keyboard: markup([[{ text: tp(lang, 'search.btn_inline'), switch_inline_query_current_chat: '' }]]) };
  const inline = { text: tp(lang, 'search.btn_inline'), switch_inline_query_current_chat: res.q.text };
  if (!res.tracks.length) return { text: t(lang, page ? 'search.no_more' : 'search.none', { q: res.q.text }), keyboard: markup([[inline]]) };
  const rows = res.tracks.map((tr) => [btn(`🎵 ${label(lang, tr)}`, 's', 'get', tr.public_id)]);
  rows.push([page > 0 ? btn(tp(lang, 'common.prev'), 's', 'pg', page - 1) : null, res.more ? btn(tp(lang, 'common.next'), 's', 'pg', page + 1) : null]);
  rows.push([inline]);
  return { text: t(lang, 'search.results', { q: res.q.text, page: page + 1 }), keyboard: markup(rows) };
}

/** Plain text or /search <query> in private chat. */
export const searchFromText = async (app, user, text) => app.tg.send(user.telegram_id, await resultsView(app, text, 0), 'search_results');

/** Sends an active track's audio (by file_id) and counts the play. @returns {Promise<boolean>} */
export async function sendTrack(app, user, publicId) {
  const tr = await app.provider.getTrack(publicId);
  if (!tr) {
    await app.tg.send(user.telegram_id, { text: t(app.lang, 'start.track_gone') }, 'track_gone');
    return false;
  }
  await app.tg.call('sendAudio', { chat_id: user.telegram_id, audio: tr.audio_file_id }, 'track');
  await app.search.addPlay(tr.public_id);
  return true;
}

/** The query of a results message, read back from its first line (pagination stays stateless). */
const queryOf = (message) => {
  const m = /^🔎\s*«(.*)»/.exec(String((message && message.text) || '').split('\n')[0]);
  return m ? m[1] : '';
};

export const routes = [
  { ns: 's', action: 'get', args: ['pid'], perm: null, run: async (app, user, [pid]) => { await sendTrack(app, user, String(pid)); return {}; } },
  {
    ns: 's', action: 'pg', args: ['uint'], perm: null,
    async run(app, user, [page], cq) {
      const q = queryOf(cq.message);
      if (!q) return { toast: tp(app.lang, 'common.expired_user'), alert: true };
      await app.tg.show(user.telegram_id, cq.message.message_id, await resultsView(app, q, Number(page)), 'search_results');
      return {};
    },
  },
];
