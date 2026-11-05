// 🎤 Artists and their aliases (catalog.manage). An alias (e.g. "shadmehr" for «شادمهر عقیلی»)
// becomes a search term of every active track of that artist.
import { LIMITS } from '../config/static.js';
import { t, tp, raw, digits } from '../i18n/index.js';
import { esc } from '../telegram/html.js';
import { btn, markup } from '../bot/keyboards.js';
import { screen, promptView } from './panel.js';
import { truncate } from '../core/util.js';

const PERM = 'catalog.manage';

async function listView(app, page) {
  const lang = app.lang;
  const size = LIMITS.musicPageSize;
  const count = await app.search.countArtists();
  const pages = Math.max(1, Math.ceil(count / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = (await app.search.listArtists(p, size)).map((a) => [btn(`🎤 ${truncate(a.name, 50)}`, 'art', 'v', a.id)]);
  if (pages > 1) rows.push([p > 0 ? btn(tp(lang, 'common.prev'), 'art', 'ls', p - 1) : null, p < pages - 1 ? btn(tp(lang, 'common.next'), 'art', 'ls', p + 1) : null]);
  rows.push([btn(tp(lang, 'mus.back'), 'mus', 'home')]);
  return { text: t(lang, 'art.list', { count }) + (count ? `\n${t(lang, 'common.page', { page: p + 1, pages })}` : `\n${t(lang, 'art.empty')}`), keyboard: markup(rows) };
}

async function cardView(app, artist) {
  const lang = app.lang;
  const aliases = await app.search.artistAliases(artist.id);
  const tracks = await app.search.artistTrackCount(artist.normalized_name);
  const rows = aliases.map((a, i) => [btn(`➖ ${truncate(a, 40)}`, 'art', 'rmal', artist.id, i)]);
  rows.push([btn(tp(lang, 'art.btn_add_alias'), 'art', 'addal', artist.id)]);
  rows.push([btn(tp(lang, 'art.btn_list'), 'art', 'ls', 0), btn(tp(lang, 'mus.back'), 'mus', 'home')]);
  return {
    text: t(lang, 'art.card', {
      name: artist.name,
      tracks: digits(tracks, lang),
      aliases: raw(aliases.length ? aliases.map((a) => `• <code>${esc(a)}</code>`).join('\n') : t(lang, 'art.no_aliases')),
    }),
    keyboard: markup(rows),
  };
}

async function showArtist(app, user, cq, id) {
  const a = await app.search.getArtist(id);
  if (!a) return { toast: tp(app.lang, 'art.err.gone'), alert: true };
  await screen(app, user, cq, await cardView(app, a), 'artist_card');
  return {};
}

export const routes = [
  { ns: 'art', action: 'ls', args: ['uint'], perm: PERM, run: async (app, user, [page], cq) => { await screen(app, user, cq, await listView(app, page), 'artists'); return {}; } },
  { ns: 'art', action: 'v', args: ['uint'], perm: PERM, run: (app, user, [id], cq) => showArtist(app, user, cq, id) },
  {
    ns: 'art', action: 'byt', args: ['uint'], perm: PERM,
    async run(app, user, [trackId], cq) {
      const tr = await app.catalog.get(trackId);
      const a = tr ? await app.search.artistOfTrack(tr) : null;
      if (!a) return { toast: tp(app.lang, 'art.err.no_artist'), alert: true };
      return showArtist(app, user, cq, a.id);
    },
  },
  {
    ns: 'art', action: 'addal', args: ['uint'], perm: PERM,
    async run(app, user, [id]) {
      const a = await app.search.getArtist(id);
      if (!a) return { toast: tp(app.lang, 'art.err.gone'), alert: true };
      await app.flows.start(user.telegram_id, 'art_alias', { id });
      await app.tg.send(user.telegram_id, promptView(app.lang, t(app.lang, 'art.alias_prompt', { name: a.name })), 'artist_alias_prompt');
      return {};
    },
  },
  {
    ns: 'art', action: 'rmal', args: ['uint', 'uint'], perm: PERM,
    async run(app, user, [id, index], cq) {
      const aliases = await app.search.artistAliases(id);
      const alias = aliases[Number(index)];
      if (!alias) return showArtist(app, user, cq, id);
      await app.search.removeAlias(user, id, alias);
      await showArtist(app, user, cq, id);
      return { toast: tp(app.lang, 'art.alias_removed', { alias }) };
    },
  },
];

export const flows = {
  art_alias: {
    perm: PERM,
    async run(app, user, message, flow) {
      const id = Number(flow.data && flow.data.id);
      const alias = await app.search.addAlias(user, id, String(message.text || ''));
      await app.flows.clear(user.telegram_id);
      const a = await app.search.getArtist(id);
      await app.tg.send(user.telegram_id, { text: t(app.lang, 'art.alias_added', { alias }) }, 'artist_alias_added');
      if (a) await app.tg.send(user.telegram_id, await cardView(app, a), 'artist_card');
    },
  },
};

