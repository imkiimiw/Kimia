// Duplicate rules (pure, spec §8.3).
//  hard (blocked): same audio_file_unique_id, or the same origin chat + message id;
//  soft (flagged, never deleted): same dup_key (artist + title + version) and duration within 3 s.
import { LIMITS } from '../config/static.js';

/** @param {string} artistKey @param {string} titleKey @param {string} versionKey */
export const dupKey = (artistKey, titleKey, versionKey) => `${artistKey || ''}|${titleKey || ''}|${versionKey || ''}`;

/** Is `existing` a hard duplicate of the incoming file? */
export function isHardDuplicate(existing, incoming) {
  if (!existing) return false;
  if (existing.audio_file_unique_id === incoming.file_unique_id) return true;
  return incoming.origin_chat_id != null && incoming.origin_message_id != null
    && existing.origin_chat_id === incoming.origin_chat_id && existing.origin_message_id === incoming.origin_message_id;
}

/** Same dup_key and durations within the tolerance (a missing duration doesn't rule it out). */
export function isSoftDuplicate(a, b, seconds = LIMITS.softDuplicateSeconds) {
  if (!a || !b || a.dup_key !== b.dup_key) return false;
  if (!a.duration || !b.duration) return true;
  return Math.abs(a.duration - b.duration) <= seconds;
}

/** A draft that needs a human look before activation (also the "needs review" filter). */
export function needsReview(t) {
  return !t.title || !t.artist || t.language === 'unknown' || t.language_confidence === 'low' || t.duplicate_of != null;
}
