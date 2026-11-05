// Destination rules and schedules (pure). Phase 5 stores and shows them; Phase 6 routing uses
// matches() and withinHours(). Rules: languages (a track's language must be listed), genres
// (if any are listed, the track's genre must be one), excluded genres, minimum language confidence
// (below it a track still goes to the channel, but only through approval).
import { GENRES, CONFIDENCE_ORDER } from '../config/static.js';
import { toAsciiDigits } from '../music/normalize.js';

export const RULE_LANGUAGES = Object.freeze(['fa', 'en', 'other']);
export const DEFAULT_RULES = Object.freeze({ languages: [], genres: [], exclude_genres: [], min_language_confidence: 'medium' });

const onlyFrom = (list, allowed) => [...new Set((Array.isArray(list) ? list : []).filter((x) => allowed.includes(x)))];

/** A clean rules object from stored JSON (unknown values dropped). */
export function normalizeRules(raw) {
  let r = raw;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      r = {};
    }
  }
  r = r && typeof r === 'object' ? r : {};
  return {
    languages: onlyFrom(r.languages, RULE_LANGUAGES),
    genres: onlyFrom(r.genres, GENRES),
    exclude_genres: onlyFrom(r.exclude_genres, GENRES),
    min_language_confidence: CONFIDENCE_ORDER.includes(r.min_language_confidence) ? r.min_language_confidence : 'medium',
  };
}

/** Adds or removes one value of a list rule. */
export function toggleIn(rules, field, value) {
  const r = normalizeRules(rules);
  const list = new Set(r[field]);
  if (list.has(value)) list.delete(value);
  else list.add(value);
  const next = { ...r, [field]: [...list] };
  if (field === 'genres') next.exclude_genres = next.exclude_genres.filter((g) => !list.has(g));
  if (field === 'exclude_genres') next.genres = next.genres.filter((g) => !list.has(g));
  return normalizeRules(next);
}

export const confidenceAtLeast = (c, min) => CONFIDENCE_ORDER.indexOf(c) >= CONFIDENCE_ORDER.indexOf(min);

/**
 * Does an active track belong in this channel?
 * @returns {{match: boolean, needsApproval: boolean, reason: string|null}}
 */
export function matches(track, channel) {
  const r = normalizeRules(channel.rules);
  const no = (reason) => ({ match: false, needsApproval: false, reason });
  if (!track || track.status !== 'active') return no('not_active');
  if (!r.languages.includes(track.language)) return no('language');
  if (r.genres.length && !r.genres.includes(track.genre)) return no('genre');
  if (track.genre && r.exclude_genres.includes(track.genre)) return no('excluded_genre');
  const low = !confidenceAtLeast(track.language_confidence, r.min_language_confidence);
  return { match: true, needsApproval: !!channel.approval_required || low, reason: low ? 'low_confidence' : null };
}

/**
 * Active hours from text: "all" / "همه" / "-" → null (all day); "9-23" → { from: 9, to: 23 }
 * (22-2 wraps past midnight). @returns {{from: number, to: number}|null|undefined} undefined = invalid
 */
export function parseHours(text) {
  const s = toAsciiDigits(String(text || '')).trim().toLowerCase();
  if (['all', '-', 'همه', 'همیشه', '24'].includes(s)) return null;
  const m = /^(\d{1,2})\s*[-–—تا ]+\s*(\d{1,2})$/.exec(s);
  if (!m) return undefined;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from > 23 || to > 24 || from === to) return undefined;
  return { from, to };
}

/** Is a local hour (0–23) inside the window? null = all day. */
export function withinHours(hours, localHour) {
  if (!hours) return true;
  return hours.from < hours.to ? localHour >= hours.from && localHour < hours.to : localHour >= hours.from || localHour < hours.to;
}

/** Parses the stored active_hours JSON. */
export function hoursOf(stored) {
  if (!stored) return null;
  try {
    const h = typeof stored === 'string' ? JSON.parse(stored) : stored;
    return h && Number.isInteger(h.from) && Number.isInteger(h.to) ? { from: h.from, to: h.to } : null;
  } catch {
    return null;
  }
}
