/*
 * Inline mode. Fires on every keystroke of "@bot …", so it does little: 1–4 small indexed queries and
 * one answerInlineQuery, never another Bot API call.
 *
 *  - "@bot words": public memes matching every word (lib/store.js search), by usage count.
 *    Same for everyone, so is_personal = false and a short server cache. next_offset = "<n>".
 *  - "@bot" alone: the user's recently sent memes, then their own latest uploads, then the most
 *    popular ones (no duplicates), plus an "upload" button. Personal, so is_personal = true.
 *    next_offset = "e<n>" (position in the popular list).
 *  - Nothing found: the "upload" button (InlineQueryResultsButton, the modern switch_pm), which opens
 *    the private chat with /start upload.
 *
 * Result ids are "m<meme id>"; chosen_inline_result (BotFather /setinlinefeedback) turns them into
 * usage counts and the user's recent list.
 */
import {
  INLINE_CACHE, INLINE_MAX_OFFSET, INLINE_PAGE, INLINE_PERSONAL_CACHE, OWN_SHOW, RECENT_KEEP, RECENT_SHOW, START_UPLOAD, USE_COOLDOWN,
} from './config.js';
import { langOf, t } from './i18n.js';
import { queryWords } from './normalize.js';
import * as store from './store.js';
import { call, describeError } from './tg.js';
import { cut } from './util.js';

/* Video and voice results need a title (Bot API); stickers take none. */
export function toResult(m) {
  const id = `m${m.id}`;
  const title = cut(m.keywords, 64);
  switch (m.kind) {
    case 'photo': return { type: 'photo', id, photo_file_id: m.file_id, title };
    case 'animation': return { type: 'gif', id, gif_file_id: m.file_id, title };
    case 'video': return { type: 'video', id, video_file_id: m.file_id, title };
    case 'sticker': return { type: 'sticker', id, sticker_file_id: m.file_id };
    case 'voice': return { type: 'voice', id, voice_file_id: m.file_id, title };
    default: return null;
  }
}

function parseOffset(s, prefix = '') {
  const m = new RegExp(`^${prefix}(\\d{1,6})$`).exec(String(s || ''));
  return m ? Number(m[1]) : 0;
}

async function lang(q) {
  return langOf(await store.getUser(q.from.id), q.from);
}

async function searchPage(q, words) {
  const off = parseOffset(q.offset);
  if (off > INLINE_MAX_OFFSET) return { results: [], next: '' };
  const rows = await store.search(words, INLINE_PAGE + 1, off);
  const out = { results: rows.slice(0, INLINE_PAGE), next: rows.length > INLINE_PAGE ? String(off + INLINE_PAGE) : '' };
  if (!off && !rows.length) out.button = { text: t(await lang(q), 'inline.none'), start_parameter: START_UPLOAD };
  return out;
}

async function homePage(q) {
  const uid = q.from.id;
  const idx = parseOffset(q.offset, 'e');
  if (idx > INLINE_MAX_OFFSET) return { results: [], next: '' };
  const seen = new Set();
  const personal = [];
  for (const m of [...(await store.recentUsed(uid, RECENT_SHOW)), ...(await store.ownLatest(uid, OWN_SHOW))]) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      personal.push(m);
    }
  }
  const results = idx === 0 ? personal.slice() : [];
  const pop = await store.popular(INLINE_PAGE - results.length + seen.size + 1, idx);
  let i = 0;
  for (; i < pop.length && results.length < INLINE_PAGE; i += 1) if (!seen.has(pop[i].id)) results.push(pop[i]);
  const out = { results, next: i < pop.length && idx + i <= INLINE_MAX_OFFSET ? `e${idx + i}` : '' };
  if (idx === 0) out.button = { text: t(await lang(q), results.length ? 'inline.upload' : 'inline.empty_db'), start_parameter: START_UPLOAD };
  return out;
}

export async function onInlineQuery(ctx, q) {
  const words = queryWords(q.query);
  const page = words.length ? await searchPage(q, words) : await homePage(q);
  const params = {
    inline_query_id: q.id,
    results: page.results.map(toResult).filter(Boolean),
    cache_time: words.length ? INLINE_CACHE : INLINE_PERSONAL_CACHE,
    is_personal: !words.length,
    next_offset: page.next,
  };
  if (page.button) params.button = page.button;
  try {
    await call(ctx, 'answerInlineQuery', params, words.length ? 'inline.search' : 'inline.home');
  } catch (err) {
    console.warn(`answerInlineQuery failed: ${describeError(err)}`);
  }
}

/* A user sent one of the results (needs BotFather /setinlinefeedback). */
export async function onChosenResult(ctx, r, nowSec) {
  const m = /^m(\d{1,15})$/.exec(String(r.result_id || ''));
  if (!m || !r.from) return false;
  return store.recordUse(r.from.id, Number(m[1]), nowSec, USE_COOLDOWN, RECENT_KEEP);
}
