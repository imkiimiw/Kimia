// SearchService: queries over the track_terms index, play counts, index maintenance (a track is
// indexed while active; hide/remove/purge drop its terms) and artist aliases.
import { assertCan } from '../permissions/policy.js';
import { UserError } from '../core/util.js';
import { key } from '../music/normalize.js';
import { termsForTrack, parseQuery, artistKeys } from './terms.js';

const REBUILD_BATCH = 20;
const ARTIST_REINDEX_MAX = 50;
const OFFSET_MAX = 1000;

/** @param {{repo: any, settings: any, audit: any, clock: any, log: any}} deps */
export function createSearchService({ repo, settings, audit, clock, log }) {
  async function indexTrack(track) {
    if (!track) return;
    if (track.status !== 'active') {
      await repo.clearTerms(track.id);
      return;
    }
    const keys = artistKeys(track);
    await repo.ensureArtists(keys, clock.now());
    const aliases = await repo.aliasesFor(keys.map((k) => k.key));
    await repo.setTerms(track.id, termsForTrack(track, aliases));
  }

  const requestRebuild = () => settings.setInternal('search.reindex_cursor', 0);

  async function reindexArtist(artistKey) {
    const list = await repo.activeByArtist(artistKey, ARTIST_REINDEX_MAX + 1);
    for (const tr of list.slice(0, ARTIST_REINDEX_MAX)) await indexTrack(tr);
    if (list.length > ARTIST_REINDEX_MAX) await requestRebuild();
  }

  const svc = {
    indexTrack,
    unindex: (trackId) => repo.clearTerms(trackId),
    requestRebuild,

    /**
     * @param {any} raw query text @param {{limit: number, offset?: number}} page
     * @returns {Promise<{q: {text: string, tokens: string[], full: string}, tracks: any[], more: boolean, offset: number}>}
     */
    async query(raw, { limit, offset = 0 }) {
      const q = parseQuery(raw);
      const off = Math.min(Math.max(0, offset | 0), OFFSET_MAX);
      const rows = q.tokens.length ? await repo.search(q.tokens, q.full, limit + 1, off) : await repo.popular(limit + 1, off);
      return { q, tracks: rows.slice(0, limit), more: rows.length > limit && off + limit < OFFSET_MAX, offset: off };
    },

    addPlay: (publicId) => repo.addPlay(publicId),

    /** Tick processor: rebuilds the index in small batches while search.reindex_cursor ≥ 0. */
    async runReindex({ deadlineMs }) {
      let cursor = Number(await settings.get('search.reindex_cursor'));
      if (cursor < 0) return { skipped: 'done' };
      const rows = await repo.activeAfter(cursor, REBUILD_BATCH);
      let n = 0;
      for (const tr of rows) {
        if (clock.ms() >= deadlineMs) break;
        await indexTrack(tr);
        cursor = tr.id;
        n += 1;
      }
      const done = n === rows.length && rows.length < REBUILD_BATCH;
      await settings.setInternal('search.reindex_cursor', done ? -1 : cursor);
      if (done) log.info('search_index_rebuilt', { count: n });
      return { indexed: n, done };
    },

    stats: async () => ({ terms: await repo.countTerms(), cursor: Number(await settings.get('search.reindex_cursor')) }),

    // ---- artists and aliases (catalog.manage)
    listArtists: (page, size) => repo.listArtists(size, page * size),
    countArtists: () => repo.countArtists(),
    getArtist: (id) => repo.getArtist(id),
    getArtistByKey: (k) => repo.getArtistByKey(k),
    artistAliases: (id) => repo.artistAliases(id),
    artistTrackCount: (k) => repo.artistTrackCount(k),
    /** The artist row of a track's primary artist (created if missing). */
    async artistOfTrack(track) {
      const k = key(track.artist);
      if (!k) return null;
      await repo.ensureArtists([{ key: k, name: track.artist }], clock.now());
      return repo.getArtistByKey(k);
    },

    async addAlias(actor, artistId, text) {
      assertCan(actor, 'catalog.manage');
      const artist = await repo.getArtist(artistId);
      if (!artist) throw new UserError('art.err.gone');
      const alias = key(text);
      if (alias.length < 2 || alias.length > 64) throw new UserError('art.err.alias');
      if (alias === artist.normalized_name) throw new UserError('art.err.same');
      if (!(await repo.addAlias(alias, artistId))) {
        const owner = await repo.aliasOwner(alias);
        throw new UserError('art.err.taken', { name: owner ? owner.name : '?' });
      }
      await audit.record(actor, 'artist.alias_add', 'artist', artistId, { alias });
      await reindexArtist(artist.normalized_name);
      return alias;
    },

    async removeAlias(actor, artistId, alias) {
      assertCan(actor, 'catalog.manage');
      const artist = await repo.getArtist(artistId);
      if (!artist) throw new UserError('art.err.gone');
      if (!(await repo.removeAlias(alias, artistId))) throw new UserError('art.err.gone');
      await audit.record(actor, 'artist.alias_remove', 'artist', artistId, { alias });
      await reindexArtist(artist.normalized_name);
    },
  };
  return svc;
}
