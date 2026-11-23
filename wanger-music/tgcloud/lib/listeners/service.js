// Listener features (owner's ideas, 2026-11-23): ❤️ favourites, 🔔 followed artists, 📝 song
// requests, 🔎 missed searches, and the lists listeners browse. Rules live here; texts and
// keyboards in bot/listener_ui.js. Messages to listeners (a followed artist's new song, a request
// that arrived) are queued on activation and sent by the tick (processor `notices`), at most once.
import { LIMITS, MOODS } from '../config/static.js';
import { UserError } from '../core/util.js';
import { termsForTrack, parseQuery, skeletonTerm } from '../search/terms.js';

const DAY = 86400;
const MISSED_KEEP_DAYS = 30;

/**
 * Does a request fit a track (pure)? Every token — or two neighbouring tokens joined — must be one
 * of the track's search terms, as written or as its Finglish skeleton ("shadmehr bi to" fits
 * «بی تو — شادمهر عقیلی»).
 * @param {string} reqKey normalized request text @param {any} track
 */
export function requestMatches(reqKey, track) {
  const terms = new Set(termsForTrack(track));
  const has = (tok) => terms.has(tok) || (Boolean(skeletonTerm(tok)) && terms.has(skeletonTerm(tok)));
  const toks = String(reqKey || '').split(' ').filter(Boolean);
  if (!toks.length) return false;
  for (let i = 0; i < toks.length;) {
    if (has(toks[i])) i += 1;
    else if (i + 1 < toks.length && has(toks[i] + toks[i + 1])) i += 2;
    else return false;
  }
  return true;
}

/**
 * Drops a missed search that is only the beginning of a longer one in the list (inline mode sends
 * a query per keystroke: "shad", "shadm", "shadmehr"). @param {{key: string}[]} rows
 */
export function collapsePrefixes(rows) {
  return rows.filter((r) => !rows.some((o) => o !== r && o.key.length > r.key.length && o.key.startsWith(r.key)));
}

/** @param {{repo: any, settings: any, clock: any, log: any}} deps */
export function createListenersService({ repo, settings, clock, log }) {
  const now = () => clock.now();
  return {
    // ---- ❤️
    async toggleFavorite(userId, track) {
      if (await repo.removeFavorite(userId, track.id)) return { on: false };
      if (await repo.addFavorite(userId, track.id, now(), LIMITS.favoritesMax)) return { on: true };
      throw new UserError('l.err.fav_full', { max: LIMITS.favoritesMax });
    },
    isFavorite: (userId, trackId) => repo.isFavorite(userId, trackId),
    /** One page (+1 row to know if there is more). */
    favorites: (userId, page) => repo.favorites(userId, LIMITS.listenerPage + 1, page * LIMITS.listenerPage),

    // ---- 🔔
    async toggleFollow(userId, track) {
      const k = track.normalized_artist;
      if (!k || !track.artist) throw new UserError('l.err.no_artist');
      if (await repo.unfollow(userId, k)) return { on: false };
      if (await repo.follow(userId, k, track.artist, now(), LIMITS.followsMax)) return { on: true };
      throw new UserError('l.err.follow_full', { max: LIMITS.followsMax });
    },
    isFollowing: (userId, artistKey) => (artistKey ? repo.isFollowing(userId, artistKey) : Promise.resolve(false)),
    follows: (userId, page) => repo.follows(userId, LIMITS.listenerPage + 1, page * LIMITS.listenerPage),
    unfollow: (userId, artistKey) => repo.unfollow(userId, artistKey),

    // ---- 📝
    /** @returns {Promise<{status: 'added'|'duplicate', text: string}>} */
    async request(userId, raw) {
      const q = parseQuery(raw);
      if (!q.tokens.length) throw new UserError('l.err.req_empty');
      if (await repo.hasOpenRequest(userId, q.full)) return { status: 'duplicate', text: q.text };
      if ((await repo.countOpenRequestsOf(userId)) >= LIMITS.requestsOpenMax) throw new UserError('l.err.req_full', { max: LIMITS.requestsOpenMax });
      await repo.addRequest(userId, q.text, q.full, now());
      return { status: 'added', text: q.text };
    },
    requestsOf: (userId) => repo.requestsOf(userId, LIMITS.requestsOpenMax),
    cancelRequest: (userId, id) => repo.cancelRequest(userId, id, now()),
    requestSummary: () => repo.requestSummary(LIMITS.listenerAdminList),
    countOpenRequests: () => repo.countOpenRequests(),
    dropRequests: (key) => repo.dropRequests(key, now()),

    /**
     * A track just became active (catalog.activate): queue its artist's followers and mark the
     * open requests it fits. Best effort: never fails the activation.
     */
    async onActivated(track) {
      try {
        if (!(await settings.get('listeners.notices'))) return { job: false, matched: 0 };
        const job = track.normalized_artist ? await repo.createNoticeJob(track.id, track.normalized_artist, now()) : null;
        const open = await repo.openRequests(LIMITS.requestsScan);
        const matched = await repo.markMatched(open.filter((r) => requestMatches(r.key, track)).map((r) => r.id), track.id);
        return { job: Boolean(job), matched };
      } catch (e) {
        log.warn('listeners_on_activated_failed', { track_id: track && track.id, error: String(e && e.message).slice(0, 120) });
        return { job: false, matched: 0 };
      }
    },

    // ---- 🔎 (normalized text and a count only)
    async recordMissed(raw) {
      const q = parseQuery(raw);
      if (!q.tokens.length || [...q.full].length < 3) return;
      await repo.recordMissed(q.full, q.text, now());
    },
    topMissed: async () => collapsePrefixes(await repo.topMissed(now() - MISSED_KEEP_DAYS * DAY, LIMITS.listenerAdminList * 2)).slice(0, LIMITS.listenerAdminList),
    deleteMissed: (key) => repo.deleteMissed(key),
    pruneMissed: () => repo.pruneMissed(now() - MISSED_KEEP_DAYS * DAY),

    // ---- lists
    /** A random track among the 100 most played (newest first when nobody played yet). */
    async random() {
      const list = await repo.popular(100);
      return list.length ? list[Math.floor(Math.random() * list.length)] : null;
    },
    byArtist: (artistKey, page) => repo.byArtist(artistKey, LIMITS.listenerPage + 1, page * LIMITS.listenerPage),
    album: (track) => (track.album && track.normalized_artist ? repo.album(track.normalized_artist, track.album, LIMITS.albumMax) : Promise.resolve([])),
    byGenre: (genre, page) => repo.byGenre(genre, LIMITS.listenerPage + 1, page * LIMITS.listenerPage),
    byMood: (mood, page) => (MOODS.includes(mood) ? repo.byMood(mood, LIMITS.listenerPage + 1, page * LIMITS.listenerPage) : Promise.resolve([])),
    activeById: (id) => repo.activeById(id),

    // ---- notice queue (the tick sends; bot/listener_ui.js#runNotices)
    matchedRequests: (limit) => repo.matchedRequests(limit),
    claimMatched: (id) => repo.claimMatched(id, now()),
    openNoticeJob: () => repo.openNoticeJob(),
    followersAfter: (artistKey, cursor, limit) => repo.followersAfter(artistKey, cursor, limit),
    claimNoticeBatch: (id, from, to) => repo.claimNoticeBatch(id, from, to),
    finishNoticeBatch: (id, sent, done) => repo.finishNoticeBatch(id, sent, done, now()),
  };
}
