// Channel engagement (owner's ideas, 2026-11-23), from a destination channel's card: 🔥 the weekly
// chart (plays in the bot + reactions in the channel; previewed to the owner, sent with one tap),
// 🗳 a "next song" poll over the channel's queue (closing it sends the winner at once), and ❤️ the
// channel's most liked posts (message_reaction_count). Nothing reaches a channel without a tap.
import { BOT_USERNAME } from '../config/static.js';
import { t, tp, digits } from '../i18n/index.js';
import { esc } from '../telegram/html.js';
import { btn, markup } from '../bot/keyboards.js';
import { truncate } from '../core/util.js';
import { classify } from '../telegram/errors.js';
import { captionLanguage } from '../publishing/worker.js';
import { channelSignature } from '../publishing/captions.js';

const PERM = 'destinations.manage';
const WEEK = 7 * 86400;
const CHART_SIZE = 10;
const title = (d) => d.title || (d.username ? '@' + d.username : String(d.chat_id));
const back = (lang, id) => btn(tp(lang, 'common.back'), 'dst', 'v', id);

/** The open poll of a channel, or null. */
export function pollOf(d) {
  let p = d && d.poll;
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p);
    } catch {
      p = null;
    }
  }
  return p && Number.isSafeInteger(p.message_id) && Array.isArray(p.pubs) ? p : null;
}

/** The card's engagement buttons. @param {string} lang @param {any} d */
export const cardRows = (lang, d) => [[
  btn(tp(lang, 'eng.btn_chart'), 'eng', 'chart', d.id),
  pollOf(d) ? btn(tp(lang, 'eng.btn_poll_end'), 'eng', 'pend', d.id) : btn(tp(lang, 'eng.btn_poll'), 'eng', 'poll', d.id),
  btn(tp(lang, 'eng.btn_top'), 'eng', 'top', d.id),
]];

/** The week's top songs for a channel: plays in the bot plus the channel's reactions. */
async function chartRows(app, d) {
  const since = app.clock.now() - WEEK;
  const [top, liked] = await Promise.all([app.stats.top(7), app.publisher.topReacted(d.id, since, 30)]);
  /** @type {Map<number, {public_id: string, title: string, artist: string, score: number}>} */
  const by = new Map();
  for (const r of top.period) if (r.status === 'active') by.set(r.id, { public_id: r.public_id, title: r.title, artist: r.artist, score: Number(r.plays) || 0 });
  for (const r of liked) {
    if (r.track_status !== 'active') continue;
    const cur = by.get(r.track_id) || { public_id: r.public_id, title: r.title, artist: r.artist, score: 0 };
    cur.score += Number(r.reactions) || 0;
    by.set(r.track_id, cur);
  }
  return [...by.values()].filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, CHART_SIZE);
}

/** The chart post (HTML) in the channel's language. */
function chartText(lang, d, rows) {
  const lines = rows.map((r, i) => `${digits(i + 1, lang)}. <a href="https://t.me/${BOT_USERNAME}?start=t_${esc(r.public_id)}">${esc(truncate(`${r.title || '?'} — ${r.artist || '?'}`, 70))}</a>`);
  const sig = channelSignature(d);
  return [t(lang, 'eng.chart_head', { n: digits(rows.length, lang) }), '', ...lines, '', t(lang, 'eng.chart_foot', { bot: BOT_USERNAME }), ...(sig ? [esc(sig)] : [])].join('\n');
}
const chartKeyboard = (lang) => ({ inline_keyboard: [[{ text: tp(lang, 'eng.chart_btn'), url: `https://t.me/${BOT_USERNAME}` }]] });

export const routes = [
  {
    // 🔥 a preview to the owner first
    ns: 'eng', action: 'chart', args: ['uint'], perm: PERM,
    async run(app, user, [id]) {
      const d = await app.destinations.get(id);
      if (!d) return { toast: tp(app.lang, 'dst.err.gone'), alert: true };
      const rows = await chartRows(app, d);
      if (rows.length < 3) return { toast: tp(app.lang, 'eng.chart_too_few'), alert: true };
      const lang = captionLanguage(d);
      await app.tg.call('sendMessage', { chat_id: user.telegram_id, text: chartText(lang, d, rows), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: chartKeyboard(lang) }, 'chart_preview');
      await app.tg.send(user.telegram_id, {
        text: t(app.lang, 'eng.chart_preview_note', { title: title(d) }),
        keyboard: markup([[btn(tp(app.lang, 'eng.btn_chart_send', { title: truncate(title(d), 30) }), 'eng', 'chok', id)], [back(app.lang, id)]]),
      }, 'chart_preview_note');
      return {};
    },
  },
  {
    ns: 'eng', action: 'chok', args: ['uint'], perm: PERM,
    async run(app, user, [id]) {
      const d = await app.destinations.get(id);
      if (!d || !d.bot_rights_ok) return { toast: tp(app.lang, 'dst.err.gone'), alert: true };
      // a second tap on the same preview within the hour does nothing
      if (!(await app.alerts.claim(`chart:${id}`, 3600))) return { toast: tp(app.lang, 'eng.chart_already'), alert: true };
      const rows = await chartRows(app, d);
      if (rows.length < 3) return { toast: tp(app.lang, 'eng.chart_too_few'), alert: true };
      const lang = captionLanguage(d);
      await app.tg.call('sendMessage', { chat_id: d.chat_id, text: chartText(lang, d, rows), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: chartKeyboard(lang) }, 'channel_chart');
      await app.audit.record(user, 'destination.chart', 'destination', d.chat_id, { songs: rows.length });
      return { toast: tp(app.lang, 'eng.chart_sent', { title: truncate(title(d), 40) }) };
    },
  },
  {
    // 🗳 the channel's next queued songs as a poll
    ns: 'eng', action: 'poll', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      const d = await app.destinations.get(id);
      if (!d || !d.bot_rights_ok) return { toast: tp(app.lang, 'dst.err.gone'), alert: true };
      if (pollOf(d)) return { toast: tp(app.lang, 'eng.poll_open'), alert: true };
      const options = await app.publisher.queuedOf(d.id, 4);
      if (options.length < 2) return { toast: tp(app.lang, 'eng.poll_need'), alert: true };
      const lang = captionLanguage(d);
      const m = await app.tg.call('sendPoll', {
        chat_id: d.chat_id, question: tp(lang, 'eng.poll_question'), is_anonymous: true,
        options: options.map((o) => ({ text: truncate(`${o.title || '?'} — ${o.artist || '?'}`, 100) })),
      }, 'channel_poll');
      await app.destinations.setPoll(user, d.id, { message_id: m.message_id, pubs: options.map((o) => o.id), at: app.clock.now() });
      await app.tg.show(user.telegram_id, cq.message && cq.message.message_id, { text: t(app.lang, 'eng.poll_sent', { title: title(d), n: digits(options.length, app.lang) }), keyboard: markup([[btn(tp(app.lang, 'eng.btn_poll_end'), 'eng', 'pend', id)], [back(app.lang, id)]]) }, 'channel_poll_sent');
      return {};
    },
  },
  {
    // ⏹ close the poll; the winner goes out now (ties: the earliest in the queue)
    ns: 'eng', action: 'pend', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      const d = await app.destinations.get(id);
      const poll = pollOf(d);
      if (!d || !poll) return { toast: tp(app.lang, 'eng.poll_none'), alert: true };
      let counts = [];
      try {
        const res = await app.tg.call('stopPoll', { chat_id: d.chat_id, message_id: poll.message_id }, 'channel_poll_stop');
        counts = (res && Array.isArray(res.options) ? res.options : []).map((o) => Number(o.voter_count) || 0);
      } catch (e) {
        app.log.warn('poll_stop_failed', { channel_id: d.chat_id, error: classify(e).kind });
      }
      await app.destinations.setPoll(user, d.id, null);
      if (!counts.length) {
        await app.tg.show(user.telegram_id, cq.message && cq.message.message_id, { text: t(app.lang, 'eng.poll_lost'), keyboard: markup([[back(app.lang, id)]]) }, 'channel_poll_done');
        return {};
      }
      const best = counts.reduce((b, n, i) => (n > counts[b] ? i : b), 0);
      const outcome = await app.worker.sendPublicationNow(poll.pubs[best]);
      await app.tg.show(user.telegram_id, cq.message && cq.message.message_id, {
        text: t(app.lang, 'eng.poll_done', { votes: digits(counts[best], app.lang), total: digits(counts.reduce((a, n) => a + n, 0), app.lang), outcome: tp(app.lang, `dst.now.${outcome}`) }),
        keyboard: markup([[back(app.lang, id)]]),
      }, 'channel_poll_done');
      return {};
    },
  },
  {
    // ❤️ the channel's most liked posts (30 days)
    ns: 'eng', action: 'top', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      const d = await app.destinations.get(id);
      if (!d) return { toast: tp(app.lang, 'dst.err.gone'), alert: true };
      const rows = await app.publisher.topReacted(d.id, app.clock.now() - 30 * 86400, 10);
      const lang = app.lang;
      const lines = rows.map((r, i) => t(lang, 'eng.top_line', { i: digits(i + 1, lang), title: truncate(`${r.title || '?'} — ${r.artist || '?'}`, 60), n: digits(r.reactions, lang) }));
      await app.tg.show(user.telegram_id, cq.message && cq.message.message_id, {
        text: [t(lang, 'eng.top_title', { title: title(d) }), '', ...(lines.length ? lines : [t(lang, 'eng.top_empty')])].join('\n'),
        keyboard: markup([...rows.map((r, i) => [btn(`${digits(i + 1, lang)}. ${truncate(r.title || '?', 40)}`, 'trk', 'v', r.track_id)]), [back(lang, id)]]),
      }, 'channel_top');
      return {};
    },
  },
];
