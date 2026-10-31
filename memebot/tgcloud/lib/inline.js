/*
 * Inline mode. Fires on every keystroke of "@bot …", so it does little: 1–4 small indexed queries and
 * one answerInlineQuery, never another Bot API call.
 *
 *  - "@bot words": memes matching every word (lib/store.js search), by usage count: public ones,
 *    plus the user's own memes still waiting for approval. next_offset = "<n>".
 *  - "@bot" alone: the user's recently sent memes, then their own latest uploads, then the most
 *    popular ones (no duplicates), plus an "upload" button. Personal, so is_personal = true.
 *    next_offset = "e<n>" (position in the popular list).
 *  - Nothing found: the "upload" button (InlineQueryResultsButton, the modern switch_pm), which opens
 *    the private chat with /start upload.
 *  - Banned users get no results. With forced join on, non-members get no results and a "join the
 *    channels" button (/start join); membership is cached (lib/join.js), so this costs no Bot API
 *    call on most keystrokes.
 *  Results differ per user (own pending memes, join, ban), so every answer is is_personal.
 *  Phase 3 query syntax (lib/normalize.js parseQuery): leading modifier words from the locales'
 *  _words — "fav" (the user's favourites) and a type ("gif", "گیف", "sticker", …) — then words and
 *  #tags. "@bot fav" alone lists favourites (next_offset "<n>"), with the type too if given.
 *  Phase 4: results are ranked by score (uses + 3 × likes); with the likebtn setting on, each sent
 *  meme carries a 👍 button.
 *
 * Result ids are "m<meme id>"; chosen_inline_result (BotFather /setinlinefeedback) turns them into
 * usage counts and the user's recent list.
 */
import {
  INLINE_CACHE, INLINE_MAX_OFFSET, INLINE_PAGE, INLINE_PERSONAL_CACHE, OWN_SHOW, RECENT_KEEP, RECENT_SHOW, START_UPLOAD, USE_COOLDOWN,
} from './config.js';
import { START_FAV, START_JOIN } from './config.js';
import * as admin from './adminstore.js';
import { roleOf } from './bot.js';
import { langOf, t } from './i18n.js';
import { checkJoin } from './join.js';
import { LOCALES } from './locales/index.js';
import { aliasMap, parseQuery } from './normalize.js';
import * as store from './store.js';
import { likeButton } from './collection.js';
import { call, describeError, keyboard } from './tg.js';
import { cut } from './util.js';

/* Modifier words of every language, built once when the module loads. */
const ALIASES = aliasMap(LOCALES);

/* Video and voice results need a title (Bot API); stickers take none. With `like`, the sent
   message gets a 👍 button (lib/collection.js toggleLike). */
export function toResult(m, like = false) {
  const id = `m${m.id}`;
  const title = cut(m.keywords, 64);
  const extra = like ? { reply_markup: keyboard([[likeButton(m.id, m.likes || 0)]]) } : {};
  switch (m.kind) {
    case 'photo': return { type: 'photo', id, photo_file_id: m.file_id, title, ...extra };
    case 'animation': return { type: 'gif', id, gif_file_id: m.file_id, title, ...extra };
    case 'video': return { type: 'video', id, video_file_id: m.file_id, title, ...extra };
    case 'sticker': return { type: 'sticker', id, sticker_file_id: m.file_id, ...extra };
    case 'voice': return { type: 'voice', id, voice_file_id: m.file_id, title, ...extra };
    default: return null;
  }
}

function parseOffset(s, prefix = '') {
  const m = new RegExp(`^${prefix}(\\d{1,6})$`).exec(String(s || ''));
  return m ? Number(m[1]) : 0;
}

/* Words, and/or a type filter, and/or "fav" with words. */
async function searchPage(q, query, lang) {
  const off = parseOffset(q.offset);
  if (off > INLINE_MAX_OFFSET) return { results: [], next: '' };
  const rows = await store.search(query, INLINE_PAGE + 1, off, q.from.id);
  const out = { results: rows.slice(0, INLINE_PAGE), next: rows.length > INLINE_PAGE ? String(off + INLINE_PAGE) : '' };
  if (!off && !rows.length) out.button = { text: t(lang, 'inline.none'), start_parameter: START_UPLOAD };
  return out;
}

/* "@bot fav" (optionally with a type): the user's favourites, newest starred first. */
async function favPage(q, kind, lang) {
  const off = parseOffset(q.offset);
  if (off > INLINE_MAX_OFFSET) return { results: [], next: '' };
  const rows = await store.favList(q.from.id, kind, INLINE_PAGE + 1, off);
  const out = { results: rows.slice(0, INLINE_PAGE), next: rows.length > INLINE_PAGE ? String(off + INLINE_PAGE) : '' };
  if (!off && !rows.length) out.button = { text: t(lang, 'inline.fav_empty'), start_parameter: START_FAV };
  return out;
}

async function homePage(q, lang) {
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
  if (idx === 0) out.button = { text: t(lang, results.length ? 'inline.upload' : 'inline.empty_db'), start_parameter: START_UPLOAD };
  return out;
}

/* Banned or not a member of the forced-join channels: an empty page (with a join button).
   Someone who never opened the bot has no cached check, so with forced join on they are sent to
   the bot first (/start join checks them and adds them to the users). */
async function gate(ctx, q, user, lang, settings, nowSec) {
  if (user && user.banned) return { results: [], next: '' };
  if (!settings.joinActive) return null;
  const locked = { results: [], next: '', button: { text: t(lang, 'join.inline'), start_parameter: START_JOIN } };
  if (!user) return (await roleOf(q.from.id)) ? null : locked;
  if (user.join_ok && user.join_ver === settings.joinVer && user.join_until > nowSec) return null;
  const join = await checkJoin(ctx, user, settings, nowSec, { role: await roleOf(user.id), inline: true });
  return join.ok ? null : locked;
}

export async function onInlineQuery(ctx, q, nowSec) {
  const query = parseQuery(q.query, ALIASES);
  const user = await store.getUser(q.from.id);
  const lang = langOf(user, q.from);
  let mode = 'home';
  if (query.fav && !query.words.length) mode = 'fav';
  else if (query.words.length || query.kind || query.fav) mode = 'search';
  const settings = await admin.getSettings();
  const page = (await gate(ctx, q, user, lang, settings, nowSec))
    || (mode === 'fav' ? await favPage(q, query.kind, lang) : mode === 'search' ? await searchPage(q, query, lang) : await homePage(q, lang));
  const params = {
    inline_query_id: q.id,
    results: page.results.map((m) => toResult(m, !!settings.likebtn)).filter(Boolean),
    cache_time: mode === 'search' ? INLINE_CACHE : INLINE_PERSONAL_CACHE,
    is_personal: true,
    next_offset: page.next,
  };
  if (page.button) params.button = page.button;
  try {
    await call(ctx, 'answerInlineQuery', params, `inline.${mode}`);
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
