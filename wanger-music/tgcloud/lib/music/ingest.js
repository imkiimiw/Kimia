// IngestService: an audio sent or forwarded by an admin (Phase 4: a source channel post) becomes
// a draft track — metadata extraction → normalization → duplicate detection → language → insert.
// It never publishes. Hard duplicates are refused; soft duplicates are created and flagged.
import { assertCan } from '../permissions/policy.js';
import { LIMITS } from '../config/static.js';
import { randomId, truncate } from '../core/util.js';
import { normalizeTrack } from './normalize.js';
import { dupKey, needsReview } from './duplicates.js';

/** Why a message can't be imported as music (pure). @returns {string|null} i18n key */
export function mediaRefusal(message) {
  if (!message) return 'music.err.not_audio';
  if (message.audio) return null;
  if (message.voice) return 'music.err.voice';
  if (message.document) return 'music.err.document';
  if (message.video || message.video_note || message.animation) return 'music.err.not_audio';
  return 'music.err.not_audio';
}

/** Origin post of a forwarded message (channel forwards carry chat + message id). */
export function originOf(message) {
  const o = message && message.forward_origin;
  if (o && o.type === 'channel' && o.chat) return { chatId: o.chat.id, messageId: o.message_id ?? null };
  if (o && o.type === 'chat' && o.sender_chat) return { chatId: o.sender_chat.id, messageId: null };
  if (message && message.forward_from_chat) return { chatId: message.forward_from_chat.id, messageId: message.forward_from_message_id ?? null };
  return { chatId: null, messageId: null };
}

/**
 * @param {{repo: any, catalog: any, audit: any, clock: any, log: any}} deps
 */
export function createIngestService({ repo, catalog, audit, clock, log }) {
  return {
    /**
     * @param {any} actor users row
     * @param {any} message a Message with `audio`
     * @param {{sourceType?: string, sourceId?: number|null, sourceDefaultLanguage?: string|null, origin?: {chatId: number|null, messageId: number|null}}} [opts]
     *   origin: where the audio was first posted (a source channel's own post); default: the forward origin
     * @returns {Promise<{kind: 'created', track: any, review: boolean} | {kind: 'duplicate', existing: any}>}
     */
    async importAudio(actor, message, opts = {}) {
      assertCan(actor, 'catalog.manage');
      const a = message.audio;
      const origin = opts.origin || originOf(message);
      const existing = await repo.findHard({ file_unique_id: a.file_unique_id, origin_chat_id: origin.chatId, origin_message_id: origin.messageId });
      if (existing) return { kind: 'duplicate', existing };

      const n = normalizeTrack({ title: a.title, performer: a.performer, fileName: a.file_name });
      const cap = (v) => (v ? truncate(v, LIMITS.trackTextMax) : null);
      const base = {
        title: cap(n.title),
        artist: cap(n.artist),
        featured_artists: cap(n.featured),
        album: null,
        version: n.version,
        duration: Number.isSafeInteger(a.duration) ? a.duration : 0,
        genre: null,
        audio_file_id: a.file_id,
        audio_file_unique_id: a.file_unique_id,
        mime_type: a.mime_type ? String(a.mime_type).slice(0, 64) : null,
        file_size: Number.isSafeInteger(a.file_size) ? a.file_size : null,
        file_name: a.file_name ? String(a.file_name).slice(0, 200) : null,
        cover_file_id: a.thumbnail ? a.thumbnail.file_id : null,
        normalized_title: n.normalizedTitle,
        normalized_artist: n.normalizedArtist,
        dup_key: dupKey(n.normalizedArtist, n.normalizedTitle, n.versionKey),
        source_type: opts.sourceType || 'manual',
        source_id: opts.sourceId ?? null,
        origin_chat_id: origin.chatId,
        origin_message_id: origin.messageId,
        status: 'draft',
        added_by: actor.telegram_id, // 0 for source imports (system)
      };
      const lang = opts.sourceDefaultLanguage
        ? { language: opts.sourceDefaultLanguage, language_confidence: 'high', language_source: 'source' }
        : await catalog.languageFor(base);
      const soft = await catalog.findSoftDuplicate({ ...base, id: 0 });
      const row = { ...base, ...lang, duplicate_of: soft ? soft.id : null };

      for (let attempt = 0; attempt < 3; attempt++) {
        const track = await repo.insert({ ...row, public_id: randomId(9), now: clock.now() });
        if (track) {
          await audit.record(actor, 'catalog.import', 'track', track.public_id, { duplicate_of: track.duplicate_of });
          log.info('track_imported', { track_id: track.id, status: track.status });
          return { kind: 'created', track, review: needsReview(track) };
        }
        const raced = await repo.findHard({ file_unique_id: a.file_unique_id, origin_chat_id: origin.chatId, origin_message_id: origin.messageId });
        if (raced) return { kind: 'duplicate', existing: raced };
      }
      throw new Error('could not allocate a public id');
    },

    /**
     * Counts one import in the admin's current run of forwards (atomic). A run ends after
     * LIMITS.importBulkWindowSeconds of quiet. @param {{kind: string, review?: boolean}} result
     */
    recordSession: (adminId, result) => repo.bumpSession(adminId, clock.now(), LIMITS.importBulkWindowSeconds, {
      created: result.kind === 'created' ? 1 : 0,
      duplicates: result.kind === 'duplicate' ? 1 : 0,
      review: result.kind === 'created' && result.review ? 1 : 0,
    }),
    claimSummary: (adminId, startedAt) => repo.claimSummary(adminId, startedAt),
    setSummaryMessage: (adminId, startedAt, messageId) => repo.setSummaryMessage(adminId, startedAt, messageId),
    getSession: (adminId) => repo.getSession(adminId),
  };
}
