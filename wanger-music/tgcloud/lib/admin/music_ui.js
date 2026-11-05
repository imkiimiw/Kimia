// 🎵 Music (catalog.manage): counts, filtered lists, search, and the track card with every
// action — activate, hide, remove (confirm), restore, purge (owner, confirm), edit title / artist /
// album, language, genre, cover, soft-duplicate decisions, play.
import { GENRES, LIMITS } from '../config/static.js';
import { t, tp, raw, digits } from '../i18n/index.js';
import { esc } from '../telegram/html.js';
import { btn, markup, grid } from '../bot/keyboards.js';
import { screen, homeButton, promptView } from './panel.js';
import { can } from '../permissions/policy.js';
import { UserError, truncate } from '../core/util.js';

const PERM = 'catalog.manage';
const FILTERS = ['review', 'draft', 'active', 'hidden', 'removed', 'fa', 'en', 'other', 'unknown'];

/** "3:07" @param {number} s @param {string} lang */
export const fmtDuration = (s, lang) => digits(`${Math.floor((s || 0) / 60)}:${String((s || 0) % 60).padStart(2, '0')}`, lang);
/** "4.2 MB" */
export const fmtSize = (b, lang) => (b ? digits(`${(b / 1048576).toFixed(1)} MB`, lang) : '—');

const label = (lang, tr) => truncate(`${tr.title || tp(lang, 'trk.untitled')} — ${tr.artist || '?'}`, 48);

/** The track card (also the import card, with a header). */
export async function trackView(app, viewer, tr, { header = '' } = {}) {
  const lang = app.lang;
  const lines = [];
  if (header) lines.push(header, '');
  lines.push(t(lang, 'trk.line.title', { title: tr.title || tp(lang, 'trk.untitled'), version: tr.version ? raw(` · <i>${esc(tr.version)}</i>`) : '' }));
  lines.push(t(lang, 'trk.line.artist', { artist: tr.artist || '—', featured: tr.featured_artists ? ` (feat. ${tr.featured_artists})` : '' }));
  if (tr.album) lines.push(t(lang, 'trk.line.album', { album: tr.album }));
  if (tr.genre) lines.push(t(lang, 'trk.line.genre', { genre: tp(lang, `genre.${tr.genre}`) }));
  lines.push(t(lang, 'trk.line.file', { duration: fmtDuration(tr.duration, lang), size: fmtSize(tr.file_size, lang) }));
  lines.push(t(lang, 'trk.line.language', { language: tp(lang, `tlang.${tr.language}`), confidence: tp(lang, `conf.${tr.language_confidence}`), source: tp(lang, `lsrc.${tr.language_source}`) }));
  lines.push(t(lang, 'trk.line.status', { status: tp(lang, `trk.status.${tr.status}`), id: `t_${tr.public_id}`, plays: tr.play_count || 0 }));
  if (tr.origin_chat_id) lines.push(t(lang, 'trk.line.origin', { chat: String(tr.origin_chat_id), message: String(tr.origin_message_id ?? '—') }));
  if (tr.status === 'active' && (await app.settings.get('archive.chat_id'))) lines.push(t(lang, tr.archive_message_id ? 'trk.line.archive_done' : 'trk.line.archive_wait'));
  if (!tr.title) lines.push(t(lang, 'trk.line.missing', { what: tp(lang, 'trk.what.title') }));
  if (!tr.artist) lines.push(t(lang, 'trk.line.missing', { what: tp(lang, 'trk.what.artist') }));
  if (tr.duplicate_of) {
    const other = await app.catalog.get(tr.duplicate_of);
    if (other) lines.push(t(lang, 'trk.line.dup', { title: label(lang, other), id: `t_${other.public_id}` }));
  }
  for (const r of await app.catalog.relatedVersions(tr)) lines.push(t(lang, 'trk.line.related', { title: label(lang, r), version: r.version || '—', id: `t_${r.public_id}` }));
  lines.push(t(lang, 'trk.line.publications'));
  lines.push('', t(lang, 'trk.tags_note'));
  return { text: lines.join('\n'), keyboard: cardKeyboard(lang, viewer, tr) };
}

function cardKeyboard(lang, viewer, tr) {
  const id = tr.id;
  const edits = [
    [btn(tp(lang, 'trk.btn.title'), 'trk', 'ed', id, 'title'), btn(tp(lang, 'trk.btn.artist'), 'trk', 'ed', id, 'artist'), btn(tp(lang, 'trk.btn.album'), 'trk', 'ed', id, 'album')],
    [btn(tp(lang, 'trk.btn.language'), 'trk', 'lang', id), btn(tp(lang, 'trk.btn.genre'), 'trk', 'genre', id), btn(tp(lang, 'trk.btn.cover'), 'trk', 'cover', id)],
  ];
  const back = [btn(tp(lang, 'mus.back'), 'mus', 'home')];
  const play = btn(tp(lang, 'trk.btn.play'), 'trk', 'play', id);
  if (tr.status === 'removed') {
    return markup([[btn(tp(lang, 'trk.btn.restore'), 'trk', 'rest', id), can(viewer, 'catalog.purge') ? btn(tp(lang, 'trk.btn.purge'), 'trk', 'purge', id) : null], [play], back]);
  }
  const rows = [];
  if (tr.status === 'draft') rows.push([btn(tp(lang, 'trk.btn.activate'), 'trk', 'act', id)]);
  if (tr.status === 'hidden') rows.push([btn(tp(lang, 'trk.btn.activate'), 'trk', 'act', id), btn(tp(lang, 'trk.btn.remove'), 'trk', 'rm', id)]);
  if (tr.status === 'active') rows.push([btn(tp(lang, 'trk.btn.hide'), 'trk', 'hide', id), btn(tp(lang, 'trk.btn.remove'), 'trk', 'rm', id)]);
  rows.push(...edits);
  if (tr.duplicate_of) rows.push([btn(tp(lang, 'trk.btn.keep'), 'trk', 'keep', id), btn(tp(lang, 'trk.btn.replace'), 'trk', 'repl', id)]);
  rows.push(tr.status === 'draft' ? [play, btn(tp(lang, 'trk.btn.discard'), 'trk', 'rm', id)] : [play]);
  rows.push(back);
  return markup(rows);
}

async function homeView(app) {
  const lang = app.lang;
  const c = await app.catalog.counts();
  const f = (name) => btn(tp(lang, 'mus.filter_btn', { name: tp(lang, `mus.filter.${name}`), n: c[name] || 0 }), 'mus', 'ls', name, 0);
  return {
    text: t(lang, 'mus.title', c),
    keyboard: markup([
      [f('review'), f('draft')],
      [f('active'), f('hidden'), f('removed')],
      [f('fa'), f('en')],
      [f('other'), f('unknown')],
      [btn(tp(lang, 'mus.btn_search'), 'mus', 'find')],
      [homeButton(lang)],
    ]),
  };
}

async function listView(app, filter, page) {
  const lang = app.lang;
  const size = LIMITS.musicPageSize;
  const count = await app.catalog.count(filter);
  const pages = Math.max(1, Math.ceil(count / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = (await app.catalog.list(filter, p, size)).map((tr) => [btn(`${tr.duplicate_of ? '⚠️ ' : ''}${label(lang, tr)}`, 'trk', 'v', tr.id)]);
  if (pages > 1) rows.push([p > 0 ? btn(tp(lang, 'common.prev'), 'mus', 'ls', filter, p - 1) : null, p < pages - 1 ? btn(tp(lang, 'common.next'), 'mus', 'ls', filter, p + 1) : null]);
  rows.push([btn(tp(lang, 'mus.back'), 'mus', 'home')]);
  const head = t(lang, 'mus.list', { name: tp(lang, `mus.filter.${filter}`), count });
  return { text: `${head}\n${count ? t(lang, 'common.page', { page: p + 1, pages }) : t(lang, 'mus.list_empty')}`, keyboard: markup(rows) };
}

/** Shows a track's card in the pressed message. */
async function showCard(app, user, cq, id, toast = null) {
  const tr = await app.catalog.get(id);
  if (!tr) return { toast: tp(app.lang, 'trk.err.gone'), alert: true };
  await screen(app, user, cq, await trackView(app, user, tr), 'track_card');
  return toast ? { toast } : {};
}

const confirmView = (app, tr, key, yesKey, yesAction) => ({
  text: t(app.lang, key, { title: label(app.lang, tr) }),
  keyboard: markup([[btn(tp(app.lang, yesKey), 'trk', yesAction, tr.id), btn(tp(app.lang, 'common.no'), 'trk', 'v', tr.id)]]),
});

async function withTrack(app, id) {
  const tr = await app.catalog.get(id);
  if (!tr) throw new UserError('trk.err.gone');
  return tr;
}

/** A status action that refreshes the card and confirms with a toast. */
const action = (name, fn, toastKey) => ({
  ns: 'trk', action: name, args: ['uint'], perm: PERM,
  async run(app, user, [id], cq) {
    await fn(app, user, id);
    return showCard(app, user, cq, id, tp(app.lang, toastKey));
  },
});

export const routes = [
  { ns: 'mus', action: 'home', args: [], perm: PERM, run: async (app, user, _a, cq) => { await screen(app, user, cq, await homeView(app), 'music_home'); return {}; } },
  {
    ns: 'mus', action: 'ls', args: ['word', 'uint'], perm: PERM,
    async run(app, user, [filter, page], cq) {
      if (!FILTERS.includes(filter)) return { toast: tp(app.lang, 'common.expired'), alert: true };
      await screen(app, user, cq, await listView(app, filter, page), 'music_list');
      return {};
    },
  },
  {
    ns: 'mus', action: 'find', args: [], perm: PERM,
    async run(app, user) {
      await app.flows.start(user.telegram_id, 'mus_search', {});
      await app.tg.send(user.telegram_id, promptView(app.lang, t(app.lang, 'mus.search_prompt')), 'music_search_prompt');
      return {};
    },
  },
  { ns: 'trk', action: 'v', args: ['uint'], perm: PERM, run: (app, user, [id], cq) => showCard(app, user, cq, id) },
  {
    ns: 'trk', action: 'play', args: ['uint'], perm: PERM,
    async run(app, user, [id]) {
      const tr = await withTrack(app, id);
      await app.tg.call('sendAudio', { chat_id: user.telegram_id, audio: tr.audio_file_id }, 'track_play');
      return {};
    },
  },
  action('act', (app, user, id) => app.catalog.activate(user, id), 'trk.activated'),
  action('hide', (app, user, id) => app.catalog.hide(user, id), 'trk.hidden_ok'),
  action('rest', (app, user, id) => app.catalog.restore(user, id), 'trk.restored'),
  action('rmok', (app, user, id) => app.catalog.remove(user, id), 'trk.removed_ok'),
  action('keep', (app, user, id) => app.catalog.resolveDuplicate(user, id, 'keep'), 'trk.kept'),
  action('replok', (app, user, id) => app.catalog.resolveDuplicate(user, id, 'replace'), 'trk.replaced'),
  { ns: 'trk', action: 'rm', args: ['uint'], perm: PERM, run: async (app, user, [id], cq) => { await screen(app, user, cq, confirmView(app, await withTrack(app, id), 'trk.remove_confirm', 'trk.btn.yes_remove', 'rmok'), 'track_confirm'); return {}; } },
  {
    ns: 'trk', action: 'repl', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      const tr = await withTrack(app, id);
      const old = tr.duplicate_of ? await app.catalog.get(tr.duplicate_of) : null;
      if (!old) return showCard(app, user, cq, id);
      await screen(app, user, cq, { ...confirmView(app, tr, 'trk.replace_confirm', 'trk.btn.yes_replace', 'replok'), text: t(app.lang, 'trk.replace_confirm', { title: label(app.lang, old) }) }, 'track_confirm');
      return {};
    },
  },
  { ns: 'trk', action: 'purge', args: ['uint'], perm: 'catalog.purge', run: async (app, user, [id], cq) => { await screen(app, user, cq, confirmView(app, await withTrack(app, id), 'trk.purge_confirm', 'trk.btn.yes_purge', 'purgeok'), 'track_confirm'); return {}; } },
  {
    ns: 'trk', action: 'purgeok', args: ['uint'], perm: 'catalog.purge',
    async run(app, user, [id], cq) {
      await app.catalog.purge(user, id);
      await screen(app, user, cq, await homeView(app), 'music_home');
      return { toast: tp(app.lang, 'trk.purged') };
    },
  },
  {
    ns: 'trk', action: 'ed', args: ['uint', 'field'], perm: PERM,
    async run(app, user, [id, field]) {
      await withTrack(app, id);
      await app.flows.start(user.telegram_id, 'trk_edit', { id, field });
      await app.tg.send(user.telegram_id, promptView(app.lang, t(app.lang, `trk.prompt.${field}`)), 'track_edit_prompt');
      return {};
    },
  },
  {
    ns: 'trk', action: 'lang', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      const tr = await withTrack(app, id);
      const lang = app.lang;
      await screen(app, user, cq, {
        text: t(lang, 'trk.lang_choose', { title: label(lang, tr) }),
        keyboard: markup([['fa', 'en', 'other'].map((l) => btn(tp(lang, `tlang.${l}`), 'trk', 'setl', id, l)), [btn(tp(lang, 'common.back'), 'trk', 'v', id)]]),
      }, 'track_language');
      return {};
    },
  },
  {
    ns: 'trk', action: 'setl', args: ['uint', 'tlang'], perm: PERM,
    async run(app, user, [id, l], cq) {
      await app.catalog.setLanguage(user, id, l);
      return showCard(app, user, cq, id, tp(app.lang, 'trk.saved'));
    },
  },
  {
    ns: 'trk', action: 'genre', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      const tr = await withTrack(app, id);
      const lang = app.lang;
      await screen(app, user, cq, {
        text: t(lang, 'trk.genre_choose', { title: label(lang, tr) }),
        keyboard: markup([...grid(GENRES.map((g) => btn(tp(lang, `genre.${g}`), 'trk', 'setg', id, g)), 3), [btn(tp(lang, 'trk.btn.genre_none'), 'trk', 'setg', id, 'none'), btn(tp(lang, 'common.back'), 'trk', 'v', id)]]),
      }, 'track_genre');
      return {};
    },
  },
  {
    ns: 'trk', action: 'setg', args: ['uint', 'word'], perm: PERM,
    async run(app, user, [id, g], cq) {
      await app.catalog.setGenre(user, id, g === 'none' ? null : String(g));
      return showCard(app, user, cq, id, tp(app.lang, 'trk.saved'));
    },
  },
  {
    ns: 'trk', action: 'cover', args: ['uint'], perm: PERM,
    async run(app, user, [id]) {
      await withTrack(app, id);
      await app.flows.start(user.telegram_id, 'trk_cover', { id });
      await app.tg.send(user.telegram_id, promptView(app.lang, t(app.lang, 'trk.cover_prompt')), 'track_cover_prompt');
      return {};
    },
  },
];

export const flows = {
  mus_search: {
    perm: PERM,
    async run(app, user, message) {
      const q = String(message.text || '').trim();
      const results = await app.catalog.search(q);
      if (!results.length) throw new UserError('mus.search_none');
      await app.flows.clear(user.telegram_id);
      const lang = app.lang;
      const rows = results.map((tr) => [btn(`${tp(lang, `trk.status.${tr.status}`).split(' ')[0]} ${label(lang, tr)}`, 'trk', 'v', tr.id)]);
      rows.push([btn(tp(lang, 'mus.back'), 'mus', 'home')]);
      await app.tg.send(user.telegram_id, { text: t(lang, 'mus.search_results', { q: truncate(q, 40) }), keyboard: markup(rows) }, 'music_search_results');
    },
  },
  trk_edit: {
    perm: PERM,
    async run(app, user, message, flow) {
      const id = Number(flow.data && flow.data.id);
      const field = String(flow.data && flow.data.field);
      const tr = await app.catalog.edit(user, id, field, message.text || '');
      await app.flows.clear(user.telegram_id);
      await app.tg.send(user.telegram_id, await trackView(app, user, tr), 'track_card');
    },
  },
  trk_cover: {
    perm: PERM,
    async run(app, user, message, flow) {
      const photos = message.photo;
      if (!Array.isArray(photos) || !photos.length) throw new UserError('trk.err.cover');
      const best = photos.reduce((a, b) => ((b.width || 0) * (b.height || 0) > (a.width || 0) * (a.height || 0) && (b.width || 0) <= 1280 ? b : a), photos[0]);
      const tr = await app.catalog.setCover(user, Number(flow.data && flow.data.id), best.file_id);
      await app.flows.clear(user.telegram_id);
      await app.tg.send(user.telegram_id, await trackView(app, user, tr), 'track_card');
    },
  },
};
