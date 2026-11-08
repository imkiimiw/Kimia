// 📢 Destination channels (owner only): list (+ one-tap add of the channels the owner named),
// the channel card, rules (languages, genres, excluded genres, minimum confidence), caption
// template with a preview sent to the owner, post format, schedule (interval, hours, daily limit,
// time zone), approval, enable / auto-publish, rights check, removal. Phase 5 posts NOTHING.
import { GENRES, LIMITS, BOT_USERNAME, SUGGESTED_DESTINATIONS } from '../config/static.js';
import { t, tp, raw, digits, dateTime } from '../i18n/index.js';
import { esc } from '../telegram/html.js';
import { btn, markup, grid } from '../bot/keyboards.js';
import { sendQueueView } from './approvals_ui.js';
import { screen, homeButton, promptView } from './panel.js';
import { UserError, parseIntInRange } from '../core/util.js';
import { normalizeRules, parseHours, hoursOf, matches, RULE_LANGUAGES } from '../publishing/rules.js';
import { storedRights } from '../publishing/destinations.js';
import { renderCaption, captionValues, unknownVariables, DEFAULT_TEMPLATE, CAPTION_VARS, CAPTION_MAX, channelHandle, channelSignature } from '../publishing/captions.js';
import { classify } from '../telegram/errors.js';

const PERM = 'destinations.manage';
const title = (d) => d.title || (d.username ? '@' + d.username : String(d.chat_id));
const yes = (v) => (v ? '✅' : '❌');

function rulesText(lang, d) {
  const r = normalizeRules(d.rules);
  const names = (list, prefix) => list.map((x) => tp(lang, `${prefix}.${x}`)).join('، ');
  return t(lang, 'dst.rules', {
    langs: r.languages.length ? names(r.languages, 'tlang') : raw(t(lang, 'dst.no_languages')),
    genres: r.genres.length ? names(r.genres, 'genre') : tp(lang, 'dst.all'),
    exclude: r.exclude_genres.length ? names(r.exclude_genres, 'genre') : '—',
    conf: tp(lang, `conf.${r.min_language_confidence}`),
  });
}

const hoursText = (lang, d) => {
  const h = hoursOf(d.active_hours);
  return h ? tp(lang, 'dst.hours_range', { from: h.from, to: h.to }) : tp(lang, 'dst.all_day');
};

/** «📬 Queue: 8 posts · next: in about 4 min» (why it waits, when it does). */
function queueLine(lang, q, auto) {
  if (!q.queued) return t(lang, 'dst.queue_empty', { waiting: q.waiting ? raw(t(lang, 'dst.queue_waiting', { n: q.waiting })) : '' });
  if (!auto) return t(lang, 'dst.queue_manual', { n: q.queued, waiting: q.waiting ? raw(t(lang, 'dst.queue_waiting', { n: q.waiting })) : '' });
  const mins = Math.max(0, Math.ceil(((q.nextAt || q.now) - q.now) / 60));
  const when = q.ready
    ? (mins ? t(lang, 'dst.next_in', { m: mins }) : t(lang, 'dst.next_now'))
    : q.reason === 'interval' ? t(lang, 'dst.next_in', { m: Math.max(1, mins) })
      : t(lang, `dst.next_${q.reason === 'hours' || q.reason === 'daily_limit' || q.reason === 'off' ? q.reason : 'off'}`);
  return t(lang, 'dst.queue', { n: q.queued, waiting: q.waiting ? raw(t(lang, 'dst.queue_waiting', { n: q.waiting })) : '', when: raw(when) });
}

async function cardView(app, d) {
  const lang = app.lang;
  const tz = await app.settings.get('time_zone');
  const rights = storedRights(d) || {};
  const lines = [
    t(lang, 'dst.card_head', { title: title(d), handle: d.username ? '@' + d.username : '', chat_id: String(d.chat_id) }),
    t(lang, 'dst.card_state', { enabled: tp(lang, d.enabled ? 'fjm.state.on' : 'fjm.state.off'), auto: tp(lang, d.auto_publish ? 'common.on' : 'common.off'), approval: tp(lang, d.approval_required ? 'dst.approval_on' : 'dst.approval_off') }),
    t(lang, 'dst.card_rights', { post: yes(rights.post), edit: yes(rights.edit), del: yes(rights.delete), checked: dateTime(rights.checked_at || 0, tz, lang) }),
    rulesText(lang, d),
    t(lang, 'dst.card_format', { format: tp(lang, `dst.format.${d.post_format}`), caption: tp(lang, d.caption_template ? 'dst.caption_custom' : 'dst.caption_default') }),
    t(lang, 'dst.card_schedule', { interval: Math.round(d.min_interval_seconds / 60), hours: hoursText(lang, d), daily: d.daily_limit ? digits(d.daily_limit, lang) : tp(lang, 'dst.no_limit'), tz: d.time_zone }),
  ];
  const queue = await app.publisher.queueOf(d);
  lines.push(queueLine(lang, queue, await app.settings.get('publishing.auto_send')));
  if (!d.bot_rights_ok) lines.push(t(lang, 'dst.warn_rights'));
  else if (!rights.edit || !rights.delete) lines.push(t(lang, 'dst.warn_edit_delete'));
  if (!normalizeRules(d.rules).languages.length) lines.push(t(lang, 'dst.warn_languages'));
  const id = d.id;
  return {
    text: lines.join('\n'),
    keyboard: markup([
      [btn(tp(lang, d.enabled ? 'fjm.btn_disable' : 'fjm.btn_enable'), 'dst', 'tog', id), btn(tp(lang, 'dst.btn_auto', { v: tp(lang, d.auto_publish ? 'common.on' : 'common.off') }), 'dst', 'auto', id)],
      [btn(tp(lang, 'dst.btn_approval', { v: tp(lang, d.approval_required ? 'common.on' : 'common.off') }), 'dst', 'appr', id), btn(tp(lang, 'dst.btn_conf', { v: tp(lang, `conf.${normalizeRules(d.rules).min_language_confidence}`) }), 'dst', 'conf', id)],
      [btn(tp(lang, 'dst.btn_langs'), 'dst', 'langs', id), btn(tp(lang, 'dst.btn_genres'), 'dst', 'gen', id, 'inc'), btn(tp(lang, 'dst.btn_exclude'), 'dst', 'gen', id, 'exc')],
      [btn(tp(lang, 'dst.btn_caption'), 'dst', 'cap', id), btn(tp(lang, 'dst.btn_preview'), 'dst', 'prev', id), btn(tp(lang, 'dst.btn_format'), 'dst', 'fmt', id)],
      [btn(tp(lang, 'dst.btn_signature', { v: tp(lang, d.signature !== 0 ? 'common.on' : 'common.off') }), 'dst', 'sig', id)],
      [btn(tp(lang, 'dst.btn_sendq', { n: digits(queue.queued, lang) }), 'dst', 'sendq', id), btn(tp(lang, 'dst.btn_send_now'), 'dst', 'now', id)],
      [btn(tp(lang, 'dst.btn_interval_v', { v: digits(Math.round(d.min_interval_seconds / 60), lang) }), 'dst', 'int', id), btn(tp(lang, 'dst.btn_daily_v', { v: d.daily_limit ? digits(d.daily_limit, lang) : tp(lang, 'dst.no_limit') }), 'dst', 'daily', id)],
      [btn(tp(lang, 'dst.btn_hours_v', { v: hoursText(lang, d) }), 'dst', 'hours', id)],
      [btn(tp(lang, 'dst.btn_tz', { tz: d.time_zone }), 'dst', 'tz', id), btn(tp(lang, 'dst.btn_check'), 'dst', 'check', id)],
      [btn(tp(lang, 'dst.btn_history'), 'pub', 'ch', id, 0), btn(tp(lang, 'dst.btn_backfill'), 'pub', 'bf', id)],
      [btn(tp(lang, 'fjm.btn_delete'), 'dst', 'del', id), btn(tp(lang, 'common.back'), 'dst', 'home')],
    ]),
  };
}

async function listView(app) {
  const lang = app.lang;
  const rows = await app.destinations.list();
  const lines = rows.map((d, i) => {
    const r = normalizeRules(d.rules);
    return `${digits(i + 1, lang)}. ${d.enabled ? '✅' : '⏸'} ${d.bot_rights_ok ? '🟢' : '🔴'} ${esc(title(d))} · ${esc(r.languages.map((l) => tp(lang, `tlang.${l}`)).join('، ') || '—')}`;
  });
  const buttons = rows.map((d, i) => [btn(`⚙️ ${digits(i + 1, lang)}. ${title(d)}`.slice(0, 60), 'dst', 'v', d.id)]);
  const known = new Set(rows.map((d) => d.chat_id));
  for (const s of SUGGESTED_DESTINATIONS) {
    if (!known.has(s.chat_id)) buttons.push([btn(tp(lang, 'dst.btn_suggested', { name: '@' + s.username, lang: tp(lang, `tlang.${s.language}`) }), 'dst', 'sug', s.chat_id)]);
  }
  if (rows.length < LIMITS.destinationsMax) buttons.push([btn(tp(lang, 'dst.btn_add'), 'dst', 'add')]);
  buttons.push([homeButton(lang)]);
  return { text: t(lang, 'dst.title', { count: rows.length, list: raw(lines.length ? lines.join('\n') : t(lang, 'dst.empty')) }), keyboard: markup(buttons) };
}

async function showCard(app, user, cq, id, toast = null) {
  const d = await app.destinations.get(id);
  if (!d) {
    await screen(app, user, cq, await listView(app), 'destinations');
    return { toast: tp(app.lang, 'dst.err.gone') };
  }
  await screen(app, user, cq, await cardView(app, d), 'destination_card');
  return toast ? { toast } : {};
}

/** The newest active track this channel would take (for a realistic preview), or null. */
async function sampleTrack(app, d) {
  for (const tr of await app.catalog.latestActive(30)) if (matches(tr, d).match) return tr;
  return null;
}

/** Caption values of a track (or a made-up one) in the owner's language. */
async function valuesFor(app, tr) {
  const lang = app.lang;
  const track = tr || { public_id: 'AbCdEfGh1', title: tp(lang, 'dst.sample_title'), artist: tp(lang, 'dst.sample_artist'), album: tp(lang, 'dst.sample_album'), duration: 187, language: 'fa', genre: 'pop' };
  const src = tr && tr.source_id ? await app.sources.get(tr.source_id) : null;
  return captionValues(track, { botUsername: BOT_USERNAME, languageName: (l) => tp(lang, `tlang.${l}`), genreName: (g) => tp(lang, `genre.${g}`), sourceName: src ? src.title || '' : '' });
}

/**
 * Sends the owner exactly what a post to this channel would look like (cover first for
 * cover_then_audio). Throws UserError when Telegram refuses the caption. Nothing goes to the channel.
 */
async function sendPreview(app, user, d, template) {
  const tr = await sampleTrack(app, d);
  const caption = renderCaption(template || DEFAULT_TEMPLATE, { ...(await valuesFor(app, tr)), channel: channelHandle(d) }, CAPTION_MAX, channelSignature(d));
  const chat = user.telegram_id;
  try {
    if (tr) {
      if (d.post_format === 'cover_then_audio' && tr.cover_file_id) await app.tg.call('sendPhoto', { chat_id: chat, photo: tr.cover_file_id }, 'destination_preview');
      await app.tg.call('sendAudio', { chat_id: chat, audio: tr.audio_file_id, caption, parse_mode: 'HTML' }, 'destination_preview');
    } else {
      await app.tg.call('sendMessage', { chat_id: chat, text: caption || '—', parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, 'destination_preview');
    }
  } catch (e) {
    const k = classify(e).kind;
    if (k === 'bad_caption' || k === 'bad_request') throw new UserError('set.err.template', { reason: classify(e).description });
    throw e;
  }
  await app.tg.send(chat, { text: t(app.lang, tr ? 'dst.preview_note_track' : 'dst.preview_note_sample', { title: title(d) }) }, 'destination_preview_note');
}

const cardAction = (action, fn) => ({
  ns: 'dst', action, args: ['uint'], perm: PERM,
  async run(app, user, [id], cq) {
    await fn(app, user, id);
    return showCard(app, user, cq, id, tp(app.lang, 'trk.saved'));
  },
});

/** A card button that starts an input flow. @param {(d: any) => Record<string, any>} [vars] prompt variables */
const flowAction = (action, flow, promptKey, vars = (d) => ({ id: d.id })) => ({
  ns: 'dst', action, args: ['uint'], perm: PERM,
  async run(app, user, [id]) {
    const d = await app.destinations.get(id);
    if (!d) return { toast: tp(app.lang, 'dst.err.gone'), alert: true };
    await app.flows.start(user.telegram_id, flow, { id });
    await app.tg.send(user.telegram_id, promptView(app.lang, t(app.lang, promptKey, vars(d))), 'destination_prompt');
    return {};
  },
});

function languagesView(lang, d) {
  const r = normalizeRules(d.rules);
  return {
    text: t(lang, 'dst.langs_title', { title: title(d) }),
    keyboard: markup([RULE_LANGUAGES.map((l) => btn(`${r.languages.includes(l) ? '✅' : '▫️'} ${tp(lang, `tlang.${l}`)}`, 'dst', 'tl', d.id, l)), [btn(tp(lang, 'common.back'), 'dst', 'v', d.id)]]),
  };
}

function genresView(lang, d, mode) {
  const r = normalizeRules(d.rules);
  const on = mode === 'exc' ? r.exclude_genres : r.genres;
  const mark = mode === 'exc' ? '🚫' : '✅';
  return {
    text: t(lang, mode === 'exc' ? 'dst.exclude_title' : 'dst.genres_title', { title: title(d) }),
    keyboard: markup([...grid(GENRES.map((g) => btn(`${on.includes(g) ? mark : '▫️'} ${tp(lang, `genre.${g}`)}`, 'dst', 'tg', d.id, mode, g)), 3), [btn(tp(lang, 'common.back'), 'dst', 'v', d.id)]]),
  };
}

const finish = async (app, user, id) => {
  await app.flows.clear(user.telegram_id);
  const d = await app.destinations.get(id);
  if (d) await app.tg.send(user.telegram_id, await cardView(app, d), 'destination_card');
};

export const routes = [
  { ns: 'dst', action: 'home', args: [], perm: PERM, run: async (app, user, _a, cq) => { await screen(app, user, cq, await listView(app), 'destinations'); return {}; } },
  { ns: 'dst', action: 'v', args: ['uint'], perm: PERM, run: (app, user, [id], cq) => showCard(app, user, cq, id) },
  {
    ns: 'dst', action: 'add', args: [], perm: PERM,
    async run(app, user) {
      await app.flows.start(user.telegram_id, 'dst_add', {});
      await app.tg.send(user.telegram_id, promptView(app.lang, t(app.lang, 'dst.add_prompt', { bot: BOT_USERNAME })), 'destination_add_prompt');
      return {};
    },
  },
  {
    ns: 'dst', action: 'sug', args: ['int'], perm: PERM,
    async run(app, user, [chatId], cq) {
      const s = SUGGESTED_DESTINATIONS.find((x) => x.chat_id === chatId);
      if (!s) return { toast: tp(app.lang, 'common.expired'), alert: true };
      const d = await app.destinations.add(user, String(s.chat_id), null, { language: s.language });
      return showCard(app, user, cq, d.id, tp(app.lang, 'dst.added_toast'));
    },
  },
  cardAction('tog', (app, user, id) => app.destinations.toggleEnabled(user, id)),
  cardAction('auto', (app, user, id) => app.destinations.toggleAuto(user, id)),
  cardAction('appr', (app, user, id) => app.destinations.toggleApproval(user, id)),
  cardAction('sig', (app, user, id) => app.destinations.toggleSignature(user, id)),
  {
    // «📤 send this channel's queue» (owner)
    ns: 'dst', action: 'sendq', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      if (!(await app.destinations.get(id))) return { toast: tp(app.lang, 'common.expired'), alert: true };
      await screen(app, user, cq, await sendQueueView(app, id), 'send_queue');
      return {};
    },
  },
  {
    // «▶️ send the next post now» (owner): no waiting for the interval / active hours
    ns: 'dst', action: 'now', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      const outcome = await app.worker.sendNow(id);
      await showCard(app, user, cq, id);
      return { toast: tp(app.lang, `dst.now.${outcome}`), alert: outcome !== 'sent' };
    },
  },
  cardAction('conf', (app, user, id) => app.destinations.cycleConfidence(user, id)),
  cardAction('fmt', (app, user, id) => app.destinations.cycleFormat(user, id)),
  cardAction('tz', (app, user, id) => app.destinations.cycleTimeZone(user, id)),
  cardAction('check', (app, user, id) => app.destinations.checkRights(user, id)),
  { ns: 'dst', action: 'langs', args: ['uint'], perm: PERM, run: async (app, user, [id], cq) => { const d = await app.destinations.get(id); if (!d) return showCard(app, user, cq, id); await screen(app, user, cq, languagesView(app.lang, d), 'destination_languages'); return {}; } },
  { ns: 'dst', action: 'tl', args: ['uint', 'tlang'], perm: PERM, run: async (app, user, [id, l], cq) => { const d = await app.destinations.toggleLanguage(user, id, l); await screen(app, user, cq, languagesView(app.lang, d), 'destination_languages'); return {}; } },
  { ns: 'dst', action: 'gen', args: ['uint', 'mode'], perm: PERM, run: async (app, user, [id, mode], cq) => { const d = await app.destinations.get(id); if (!d) return showCard(app, user, cq, id); await screen(app, user, cq, genresView(app.lang, d, String(mode)), 'destination_genres'); return {}; } },
  { ns: 'dst', action: 'tg', args: ['uint', 'mode', 'word'], perm: PERM, run: async (app, user, [id, mode, g], cq) => { const d = await app.destinations.toggleGenre(user, id, mode, String(g)); await screen(app, user, cq, genresView(app.lang, d, String(mode)), 'destination_genres'); return {}; } },
  flowAction('cap', 'dst_cap', 'dst.caption_prompt', (d) => ({ vars: CAPTION_VARS.map((v) => `{${v}}`).join(' '), current: d.caption_template || DEFAULT_TEMPLATE, max: LIMITS.captionTemplateMax })),
  flowAction('int', 'dst_int', 'dst.interval_prompt', (d) => ({ value: Math.round(d.min_interval_seconds / 60) })),
  flowAction('hours', 'dst_hours', 'dst.hours_prompt'),
  flowAction('daily', 'dst_daily', 'dst.daily_prompt', (d) => ({ value: d.daily_limit })),
  {
    ns: 'dst', action: 'prev', args: ['uint'], perm: PERM,
    async run(app, user, [id]) {
      const d = await app.destinations.get(id);
      if (!d) return { toast: tp(app.lang, 'dst.err.gone'), alert: true };
      await sendPreview(app, user, d, d.caption_template);
      return {};
    },
  },
  {
    ns: 'dst', action: 'del', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      const d = await app.destinations.get(id);
      if (!d) return showCard(app, user, cq, id);
      await screen(app, user, cq, { text: t(app.lang, 'dst.delete_confirm', { title: title(d) }), keyboard: markup([[btn(tp(app.lang, 'common.yes_delete'), 'dst', 'delok', id), btn(tp(app.lang, 'common.no'), 'dst', 'v', id)]]) }, 'destination_delete_confirm');
      return {};
    },
  },
  { ns: 'dst', action: 'delok', args: ['uint'], perm: PERM, run: async (app, user, [id], cq) => { await app.destinations.remove(user, id); await screen(app, user, cq, await listView(app), 'destinations'); return { toast: tp(app.lang, 'src.deleted') }; } },
];

export const flows = {
  dst_add: {
    perm: PERM,
    async run(app, user, message) {
      const d = await app.destinations.add(user, message.text || message.caption || '', message);
      await app.tg.send(user.telegram_id, { text: t(app.lang, 'dst.added', { title: title(d) }) }, 'destination_added');
      await finish(app, user, d.id);
    },
  },
  dst_cap: {
    perm: PERM,
    maxInput: LIMITS.captionTemplateMax,
    async run(app, user, message, flow) {
      const id = Number(flow.data && flow.data.id);
      const d = await app.destinations.get(id);
      if (!d) return app.flows.clear(user.telegram_id);
      const raw = String(message.text || '').trim();
      const template = raw === '-' ? null : raw;
      if (template !== null) {
        const unknown = unknownVariables(template);
        if (unknown.length) throw new UserError('set.err.vars', { vars: unknown.map((v) => `{${v}}`).join(' ') });
        await sendPreview(app, user, d, template); // validation: Telegram must accept it
      }
      await app.destinations.setTemplate(user, id, template);
      await finish(app, user, id);
    },
  },
  dst_int: {
    perm: PERM,
    async run(app, user, message, flow) {
      const minutes = parseIntInRange(message.text, 0, 1440);
      if (minutes === null) throw new UserError('set.err.int', { min: 0, max: 1440 });
      await app.destinations.setMinInterval(user, Number(flow.data.id), minutes * 60);
      await finish(app, user, Number(flow.data.id));
    },
  },
  dst_daily: {
    perm: PERM,
    async run(app, user, message, flow) {
      const n = parseIntInRange(message.text, 0, 1000);
      if (n === null) throw new UserError('set.err.int', { min: 0, max: 1000 });
      await app.destinations.setDailyLimit(user, Number(flow.data.id), n);
      await finish(app, user, Number(flow.data.id));
    },
  },
  dst_hours: {
    perm: PERM,
    async run(app, user, message, flow) {
      const hours = parseHours(message.text);
      if (hours === undefined) throw new UserError('dst.err.hours');
      await app.destinations.setHours(user, Number(flow.data.id), hours);
      await finish(app, user, Number(flow.data.id));
    },
  },
};
