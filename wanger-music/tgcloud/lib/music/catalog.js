// CatalogService: the track lifecycle (draft → active ⇄ hidden → removed), metadata edits,
// duplicate resolution and the optional archive channel. Every change is audited; activating,
// hiding or removing bumps catalog.version (part of every search cache key from Phase 3).
import { LIMITS, GENRES } from '../config/static.js';
import { assertCan } from '../permissions/policy.js';
import { UserError, truncate } from '../core/util.js';
import { normalizeTrack, display, key } from './normalize.js';
import { classifyLanguage } from './classify.js';
import { dupKey, isSoftDuplicate } from './duplicates.js';
import { classify as classifyError } from '../telegram/errors.js';
import { esc } from '../telegram/html.js';
import { windowAllows } from '../telegram/limiter.js';
import { t } from '../i18n/index.js';

const PERM = 'catalog.manage';

/** Caption of an archived copy (HTML). */
export const archiveCaption = (tr) => `#t${tr.public_id}\n🎵 ${esc(tr.title || '')}\n👤 ${esc(tr.artist || '')}${tr.album ? `\n💿 ${esc(tr.album)}` : ''}`;

/** Tracks one «✅ Activate all» press activates at most (the rest: press again). */
const ACTIVATE_MANY_MAX = 300;

/**
 * @param {{repo: any, tg: any, settings: any, audit: any, alerts: any, clock: any, log: any, index?: {add: (t: any) => Promise<any>, remove: (id: number) => Promise<any>}, publishing?: {routeTrack: (t: any) => Promise<any>, cancelForTrack: (id: number) => Promise<any>, deleteForTrack: (id: number) => Promise<any>, reroute?: (t: any) => Promise<any>}}} deps
 *   index: the search index (Phase 3) — a track is indexed while it is active
 *   publishing: routing on activation, cancellation on hide/remove, cleanup on purge (Phase 6)
 */
export function createCatalogService({ repo, tg, settings, audit, alerts, clock, log, index = { add: async (_t) => {}, remove: async (_id) => {} }, publishing = { routeTrack: async (_t) => 0, cancelForTrack: async (_id) => 0, deleteForTrack: async (_id) => 0 } }) {
  async function mustGet(id) {
    const tr = await repo.get(id);
    if (!tr) throw new UserError('trk.err.gone');
    return tr;
  }

  const bumpVersion = async () => settings.setInternal('catalog.version', Number(await settings.get('catalog.version')) + 1);

  /** The first earlier, non-removed track this one softly duplicates, or null. */
  async function findSoftDuplicate(tr) {
    const candidates = await repo.byDupKey(tr.dup_key, tr.id || 0);
    const hit = candidates.find((c) => c.id < (tr.id || Number.MAX_SAFE_INTEGER) && isSoftDuplicate(c, tr));
    return hit || null;
  }

  /** Language: keep a manual/source choice; otherwise artist hint, then the script heuristic (setting music.language_auto). */
  async function languageFor(fields, current = null) {
    if (current && (current.language_source === 'manual' || current.language_source === 'source')) {
      return { language: current.language, language_confidence: current.language_confidence, language_source: current.language_source };
    }
    const artistHint = fields.normalized_artist ? await repo.artistLanguage(fields.normalized_artist) : null;
    const heuristic = /** @type {'confident'|'all'|'off'} */ (String((await settings.get('music.language_auto')) || 'confident'));
    const c = classifyLanguage({ artistHint, heuristic, text: [fields.title, fields.artist, fields.album].filter(Boolean).join(' ') });
    return { language: c.language, language_confidence: c.confidence, language_source: c.source };
  }

  /** Copies an active track to the archive channel (best effort). @returns {Promise<'done'|'skip'|'stop'>} */
  async function archiveOne(tr, chatId) {
    try {
      const m = await tg.call('sendAudio', { chat_id: chatId, audio: tr.audio_file_id, caption: archiveCaption(tr), parse_mode: 'HTML' }, 'archive');
      await repo.setArchive(tr.id, chatId, m.message_id);
      return 'done';
    } catch (e) {
      const c = classifyError(e);
      log.warn('archive_failed', { track_id: tr.id, channel_id: chatId, error_code: c.code, error: c.kind });
      if (c.kind === 'rate_limit') {
        await settings.setInternal('telegram.cooldown_until', clock.now() + Math.max(1, c.retryAfter));
        return 'stop';
      }
      if (c.kind === 'chat_gone' || c.kind === 'no_rights') {
        await alerts.owner('archive', (lang) => t(lang, 'alert.archive', { reason: c.description }), LIMITS.alertArchiveEverySeconds);
        return 'stop';
      }
      return 'skip';
    }
  }

  /** Channel rate window for the archive (≤ 18 posts a minute, Telegram allows ~20). */
  async function archiveSlot() {
    const now = clock.now();
    const r = windowAllows(await settings.get('archive.rate'), now, LIMITS.archivePerMinute, 60);
    if (r.allowed) await settings.setInternal('archive.rate', r.state);
    return r.allowed;
  }

  const svc = {
    get: (id) => repo.get(id),
    getByPublicId: (pid) => repo.getByPublicId(pid),
    counts: () => repo.counts(),
    latestActive: (limit) => repo.latestActive(limit),
    list: (filter, page, size) => repo.list(filter, size, page * size),
    count: (filter) => repo.count(filter),
    findSoftDuplicate,
    /** Other versions of the same song (a remix of an existing song is flagged this way, not blocked). */
    relatedVersions: (tr) => (tr.normalized_title ? repo.relatedVersions(tr.normalized_artist, tr.normalized_title, tr.dup_key, tr.id) : Promise.resolve([])),
    languageFor,

    /** Admin search: a public id, or a prefix of the title/artist key. */
    async search(text) {
      const s = String(text || '').trim();
      const pid = /^#?t?_?([A-Za-z0-9]{8,10})$/.exec(s);
      if (pid) {
        const tr = await repo.getByPublicId(pid[1]);
        if (tr) return [tr];
      }
      const k = key(s);
      if (k.length < 2) return [];
      return repo.searchPrefix(k, ['draft', 'active', 'hidden', 'removed'], LIMITS.musicSearchMax);
    },

    /** draft/hidden → active. Needs a title and an artist. Archives the first time (best effort). */
    async activate(actor, id) {
      assertCan(actor, PERM);
      const tr = await mustGet(id);
      if (!tr.title || !tr.artist) throw new UserError('trk.err.need_meta');
      if (tr.duplicate_of) throw new UserError('trk.err.dup_pending');
      const row = await repo.transition(id, ['draft', 'hidden'], 'active', clock.now());
      if (!row) throw new UserError('trk.err.state');
      await bumpVersion();
      await index.add(row);
      await publishing.routeTrack(row);
      await audit.record(actor, 'catalog.activate', 'track', row.public_id);
      const archive = await settings.get('archive.chat_id');
      if (archive && !row.archive_message_id && (await archiveSlot())) await archiveOne(row, archive);
      return (await repo.get(id)) || row;
    },

    /**
     * «✅ Activate all»: every ready draft (or one admin's import batch), oldest first, until the
     * deadline or ACTIVATE_MANY_MAX; drafts that need a review stay drafts.
     * @param {any} actor @param {{addedBy?: number, from?: number, to?: number}} filter @param {number} deadlineMs
     * @returns {Promise<{activated: number, left: number, review: number}>}
     */
    async activateMany(actor, filter, deadlineMs) {
      assertCan(actor, PERM);
      let activated = 0;
      /** @type {Set<number>} */
      const tried = new Set();
      while (clock.ms() < deadlineMs && activated < ACTIVATE_MANY_MAX) {
        const rows = (await repo.readyDrafts(filter, 25)).filter((r) => !tried.has(r.id));
        if (!rows.length) break;
        for (const r of rows) {
          if (clock.ms() >= deadlineMs) break;
          tried.add(r.id);
          try {
            await svc.activate(actor, r.id);
            activated += 1;
          } catch (e) {
            if (!(e instanceof UserError)) throw e;
          }
        }
      }
      const c = await repo.countDrafts(filter);
      return { activated, left: c.ready, review: c.total - c.ready };
    },

    /** active → hidden: leaves search at once. */
    async hide(actor, id) {
      assertCan(actor, PERM);
      const row = await repo.transition(id, ['active'], 'hidden', clock.now());
      if (!row) throw new UserError('trk.err.state');
      await bumpVersion();
      await index.remove(row.id);
      await publishing.cancelForTrack(row.id);
      await audit.record(actor, 'catalog.hide', 'track', row.public_id);
      return row;
    },

    /** → removed (also "discard" for a draft). The row stays, so its file stays blocked as a duplicate. */
    async remove(actor, id) {
      assertCan(actor, PERM);
      const before = await mustGet(id);
      const row = await repo.transition(id, ['draft', 'active', 'hidden'], 'removed', clock.now());
      if (!row) throw new UserError('trk.err.state');
      if (before.status === 'active') await bumpVersion();
      await index.remove(row.id);
      await publishing.cancelForTrack(row.id);
      await audit.record(actor, 'catalog.remove', 'track', row.public_id, { from: before.status });
      return row;
    },

    /** hidden/removed → draft. */
    async restore(actor, id) {
      assertCan(actor, PERM);
      const row = await repo.transition(id, ['hidden', 'removed'], 'draft', clock.now());
      if (!row) throw new UserError('trk.err.state');
      await audit.record(actor, 'catalog.restore', 'track', row.public_id);
      return row;
    },

    /** Owner only: deletes a removed track for good (its file is no longer blocked). */
    async purge(actor, id) {
      assertCan(actor, 'catalog.purge');
      const tr = await mustGet(id);
      if (tr.status !== 'removed') throw new UserError('trk.err.state');
      await index.remove(id); // children first (no foreign keys)
      await publishing.deleteForTrack(id);
      if (!(await repo.purge(id))) throw new UserError('trk.err.state');
      await audit.record(actor, 'catalog.purge', 'track', tr.public_id, { title: tr.title, artist: tr.artist });
      return tr;
    },

    /** Edits title, artist or album; recomputes keys, the duplicate flag and a heuristic language. */
    async edit(actor, id, field, value) {
      assertCan(actor, PERM);
      if (!['title', 'artist', 'album'].includes(field)) throw new UserError('trk.err.state');
      const tr = await mustGet(id);
      const text = String(value || '').trim();
      if (!text || text.length > LIMITS.trackTextMax) throw new UserError('trk.err.text', { max: LIMITS.trackTextMax });
      /** @type {Record<string, any>} */
      let patch;
      if (field === 'album') {
        patch = { album: display(text) };
      } else if (field === 'title') {
        const n = normalizeTrack({ title: text, performer: 'x' });
        patch = { title: n.title, version: n.version, normalized_title: n.normalizedTitle };
        if (n.featured) patch.featured_artists = [tr.featured_artists, n.featured].filter(Boolean).join(', ');
      } else {
        const n = normalizeTrack({ title: 'x', performer: text });
        patch = { artist: n.artist, normalized_artist: n.normalizedArtist, featured_artists: n.featured };
      }
      if ((field === 'title' && !patch.title) || (field === 'artist' && !patch.artist) || (field === 'album' && !patch.album)) {
        throw new UserError('trk.err.text', { max: LIMITS.trackTextMax });
      }
      const merged = { ...tr, ...patch };
      patch.dup_key = dupKey(merged.normalized_artist, merged.normalized_title, key(merged.version));
      Object.assign(patch, await languageFor(merged, tr));
      const dup = await findSoftDuplicate({ ...merged, ...patch });
      patch.duplicate_of = dup ? dup.id : null;
      const row = await repo.update(id, patch, clock.now());
      if (tr.status === 'active') {
        await bumpVersion();
        await index.add(row);
      }
      await audit.record(actor, `catalog.edit_${field}`, 'track', tr.public_id, { value: truncate(text, 80) });
      return row;
    },

    /** Manual language: confidence high, source manual. */
    async setLanguage(actor, id, language) {
      assertCan(actor, PERM);
      if (!['fa', 'en', 'other'].includes(language)) throw new UserError('trk.err.state');
      const tr = await mustGet(id);
      const row = await repo.update(id, { language, language_confidence: 'high', language_source: 'manual' }, clock.now());
      await audit.record(actor, 'catalog.language', 'track', tr.public_id, { language });
      if (row && row.status === 'active' && publishing.reroute) await publishing.reroute(row); // wrong channel queued? cancelled; right one routed
      return row;
    },

    /** @param {string|null} genre one of GENRES, or null to clear */
    async setGenre(actor, id, genre) {
      assertCan(actor, PERM);
      if (genre !== null && !GENRES.includes(genre)) throw new UserError('trk.err.state');
      const tr = await mustGet(id);
      const row = await repo.update(id, { genre }, clock.now());
      await audit.record(actor, 'catalog.genre', 'track', tr.public_id, { genre });
      if (row && row.status === 'active' && publishing.reroute) await publishing.reroute(row);
      return row;
    },

    /** Cover for channel posts (the audio file's own thumbnail does not change). */
    async setCover(actor, id, fileId) {
      assertCan(actor, PERM);
      const tr = await mustGet(id);
      const row = await repo.update(id, { cover_file_id: fileId }, clock.now());
      await audit.record(actor, 'catalog.cover', 'track', tr.public_id);
      return row;
    },

    /**
     * Soft duplicate decision: 'keep' clears the flag; 'replace' removes the older track (it keeps
     * blocking its own file) and clears the flag on this one.
     */
    async resolveDuplicate(actor, id, decision) {
      assertCan(actor, PERM);
      const tr = await mustGet(id);
      if (!tr.duplicate_of) throw new UserError('trk.err.state');
      if (decision === 'replace') {
        const old = await repo.get(tr.duplicate_of);
        if (old && old.status !== 'removed') await svc.remove(actor, old.id);
      }
      const row = await repo.update(id, { duplicate_of: null }, clock.now());
      await audit.record(actor, `catalog.duplicate_${decision}`, 'track', tr.public_id, { other: tr.duplicate_of });
      return row;
    },

    /** Tick processor: archives active tracks that have no archive copy yet (a few per tick). */
    async runArchiveBacklog({ deadlineMs }) {
      const chatId = await settings.get('archive.chat_id');
      if (!chatId) return { skipped: 'off' };
      if (Number(await settings.get('telegram.cooldown_until')) > clock.now()) return { skipped: 'cooldown' };
      const backlog = await repo.archiveBacklog(LIMITS.archivePerTick);
      let done = 0;
      for (const tr of backlog) {
        if (clock.ms() >= deadlineMs || !(await archiveSlot())) break;
        const r = await archiveOne(tr, chatId);
        if (r === 'done') done += 1;
        if (r === 'stop') break;
      }
      return { done, waiting: backlog.length - done };
    },
  };

  return svc;
}
