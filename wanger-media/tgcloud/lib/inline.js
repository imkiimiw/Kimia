// Inline mode: "@Wanger_mediabot <link>" in any chat (the owner switches inline mode on in
// @BotFather → /setinline). Same gates as private chats (ban, maintenance, language, forced join,
// disclaimer — otherwise a "start the bot" button), the same policy except the quota (nothing is
// sent until the user picks a result), then: the cached files (instant), an information card, or
// the media Telegram can fetch by URL (photos ≤ 5 MB, videos/GIFs ≤ 20 MB with a thumbnail).
import { PLATFORM_NAMES } from './config.js';
import * as system from './db/system.js';
import * as users from './db/users.js';
import { resolveForInline } from './download.js';
import { tp } from './i18n/index.js';
import * as tg from './tg.js';
import { caption as buildCaption } from './ui.js';
import { tehranDay } from './util.js';

const MAX_RESULTS = 10;
const THROTTLE_MS = 1500;

/** The first http(s) link in the inline query text, or null. */
export function linkIn(query) {
  const m = /https?:\/\/\S+/i.exec(String(query || ''));
  return m ? m[0] : null;
}

/** Results for cached file_ids (no fetching; Telegram already has the files). */
export function cachedResults(items, caption, title) {
  const cap = { caption, parse_mode: 'HTML' };
  return items.slice(0, MAX_RESULTS).map((it, i) => {
    const id = 'c' + i;
    if (it.type === 'photo') return { type: 'photo', id, photo_file_id: it.file_id, ...cap };
    if (it.type === 'gif') return { type: 'mpeg4_gif', id, mpeg4_file_id: it.file_id, ...cap };
    if (it.type === 'document') return { type: 'document', id, document_file_id: it.file_id, title, ...cap };
    if (it.type === 'audio') return { type: 'audio', id, audio_file_id: it.file_id, ...cap };
    return { type: 'video', id, video_file_id: it.file_id, title, ...cap };
  }).filter((r) => r.photo_file_id || r.mpeg4_file_id || r.document_file_id || r.audio_file_id || r.video_file_id);
}

/** Results by URL for fresh choices (only those Telegram can fetch itself, with a thumbnail). */
export function urlResults(choices, caption, title) {
  const out = [];
  choices.slice(0, MAX_RESULTS).forEach((c, i) => {
    const id = 'u' + i;
    const cap = { caption, parse_mode: 'HTML' };
    if (c.item.type === 'photo') out.push({ type: 'photo', id, photo_url: c.variant.url, thumbnail_url: c.variant.url, ...cap });
    else if (c.item.type === 'gif' && c.item.thumb) out.push({ type: 'mpeg4_gif', id, mpeg4_url: c.variant.url, thumbnail_url: c.item.thumb, ...cap });
    else if (c.item.type === 'video' && c.item.thumb) out.push({ type: 'video', id, video_url: c.variant.url, mime_type: 'video/mp4', thumbnail_url: c.item.thumb, title, ...cap });
  });
  return out;
}

/** ready = the user passed every gate; blocked = banned or maintenance. */
export async function answer(ctx, user, iq, { ready, blocked }) {
  const lang = user.lang || user.preselected || 'en';
  const send = (results, { cache = 30, button = null } = {}) => tg.call(ctx, 'inline', 'answerInlineQuery', {
    inline_query_id: iq.id, results, cache_time: cache, is_personal: true, ...(button ? { button: { text: tp(lang, button), start_parameter: 'inline' } } : {}),
  });
  if (blocked) {
    await send([], { cache: 0 });
    return { view: 'inline', blocked: true };
  }
  if (!ready) {
    await send([], { cache: 0, button: 'inline.start_first' });
    return { view: 'inline', held: true };
  }
  const link = linkIn(iq.query);
  if (!link) {
    await send([], { button: 'inline.how' });
    return { view: 'inline', empty: true };
  }
  if (!(await users.claimTap(user.id, 'inline', ctx.nowMs, THROTTLE_MS))) {
    await send([], { cache: 0 });
    return { view: 'inline', throttled: true };
  }
  const r = await resolveForInline(ctx, user, link);
  if (r.error) {
    await send([], { cache: 0, button: 'inline.cant' });
    return { view: 'inline', error: r.error };
  }
  const platform = r.adapter.id;
  let results;
  if (r.cached) {
    const m = r.meta || {};
    const cap = buildCaption(lang, { platform, url: r.ref.url, title: m.title, author: m.author, details: m.details }, m.notes || []);
    results = cachedResults(r.cached.items, cap, PLATFORM_NAMES[platform]);
  } else if (r.post.meta) {
    const cap = buildCaption(lang, r.post, ['meta_' + platform]);
    results = [{
      type: 'article', id: 'm', title: r.post.title ? r.post.title.slice(0, 100) : PLATFORM_NAMES[platform],
      description: [r.post.author, r.post.details].filter(Boolean).join(' · ').slice(0, 200) || PLATFORM_NAMES[platform],
      ...(r.post.cover ? { thumbnail_url: r.post.cover } : {}),
      input_message_content: { message_text: cap, parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    }];
  } else {
    results = urlResults(r.choices, buildCaption(lang, r.post, r.post.coverOnly ? ['cover_only'] : []), PLATFORM_NAMES[platform]);
  }
  await send(results, results.length ? {} : { cache: 0, button: 'inline.open_bot' });
  if (results.length) await system.count([['inline', tehranDay(ctx.now), 1]]);
  return { view: 'inline', results: results.length, platform };
}
