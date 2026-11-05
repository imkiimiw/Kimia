// Turns a post into Telegram messages.
//
// For each media item: a cached file_id for that post / item / quality is resent as is (no
// download); otherwise the file is downloaded from twimg and uploaded, and the file_id Telegram
// returns is cached. Videos use the user's quality mode with automatic fallback to a lower quality
// that fits the 50 MB upload limit; if even the lowest doesn't fit, the user gets direct links.
// Several photos/videos go out as one album (sendMediaGroup), a GIF as an animation.
import { InputFile } from 'sdk';
import { ALBUM_MAX, PHOTO_MAX, UPLOAD_MAX, URL_PHOTO_MAX, URL_SEND_MAX } from './config.js';
import { postUrl } from './links.js';
import { MediaError, chooseVariant, download, ensureSize, qualityLabel } from './media.js';
import { fetchPost, photoSizeUrl } from './x_api.js';
import { action, btn, call, describeError, isApiError, send, urlBtn } from './tg.js';
import { clip, esc, fa, nowSec, size, sizeShort } from './text.js';
import * as store from './store.js';

const CAPTION_MAX = 1024;
const VX_REFRESH_SEC = 30 * 60;

// ---------- getting the post ----------

/**
 * The post, from the posts table when we have it (no API call), else from FxTwitter/vxTwitter.
 * Returns { ok: true, post, fresh } or { ok: false, reason }.
 */
export async function getPost(ctx, link, { refresh = false } = {}) {
  const simulated = !!(ctx.simulate && (ctx.simulate.fx || ctx.simulate.vx));
  const stored = await store.getPost(link.id);
  // A post that only vxTwitter could read (one quality per video) is asked again after a while,
  // so FxTwitter's full answer replaces it once FxTwitter is back.
  const stale = !!stored && stored.source === 'vx' && nowSec() - stored.fetchedAt > VX_REFRESH_SEC;
  if (stored && stored.media.length && !refresh && !simulated && !stale) return { ok: true, post: stored, fresh: false };

  const res = await fetchPost(link.id, link.username, { simulate: ctx.simulate });
  ctx.apiLog.push(...res.log);
  await store.bumpDaily(res.stats);
  if (!res.ok) {
    if (stale && stored.media.length) return { ok: true, post: stored, fresh: false };
    return { ok: false, reason: res.reason };
  }
  // A vxTwitter answer has only the best video quality: never let it replace a full FxTwitter one.
  if (!stored || res.post.source === 'fx' || stored.source === 'vx') {
    await store.savePost(res.post);
    return { ok: true, post: res.post, fresh: true };
  }
  if (!simulated) return { ok: true, post: stored, fresh: false };
  res.post.unsaved = true; // a simulated-outage test: deliver vxTwitter's answer, keep the stored one
  return { ok: true, post: res.post, fresh: true };
}

// ---------- captions ----------

/** Caption from the user's options, at most 1024 UTF-16 units (the post text is cut first). */
export function buildCaption(user, post, notes = []) {
  const tail = [];
  if (user.capAuthor && post.author) tail.push(`👤 @${post.author}`);
  if (user.capLink) tail.push(`🔗 ${postUrl(post.id, post.author)}`);
  const extra = notes.filter(Boolean);
  const after = [...extra, ...tail].join('\n');
  let body = user.capText ? String(post.text || '').trim() : '';
  if (body) {
    const room = CAPTION_MAX - (after ? after.length + 2 : 0);
    body = room > 20 ? clip(body, room) : '';
  }
  const plain = [body, after].filter(Boolean).join('\n\n');
  if (!plain) return null;
  return plain.length <= CAPTION_MAX ? esc(plain) : esc(clip(plain, CAPTION_MAX));
}

// ---------- planning ----------

const EXT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function photoType(url) {
  const m = /\.(jpg|jpeg|png|webp)(?:[?#]|$)/i.exec(url);
  const ext = m ? m[1].toLowerCase() : 'jpg';
  return { ext: ext === 'jpeg' ? 'jpg' : ext, type: EXT_TYPES[ext] || 'image/jpeg' };
}

async function photoPlan(item, i, files, asDocument, changed) {
  if (asDocument) {
    const hit = files.get(`${i}:doc`);
    if (hit) return { i, kind: 'document', q: 'doc', fileId: hit.fileId, fileKind: hit.kind };
    const n = await ensureSize(item, changed);
    return { i, kind: 'document', q: 'doc', url: item.url, size: n, ...photoType(item.url) };
  }
  for (const q of ['orig', 'large']) {
    const hit = files.get(`${i}:${q}`);
    if (hit) return { i, kind: 'photo', q, fileId: hit.fileId, fileKind: hit.kind };
  }
  const n = await ensureSize(item, changed);
  if (!n || n <= PHOTO_MAX) return { i, kind: 'photo', q: 'orig', url: item.url, size: n, ...photoType(item.url) };
  // Above Telegram's 10 MB photo limit: the 4096px rendition, then the "large" one.
  for (const name of ['4096x4096', 'large']) {
    const url = photoSizeUrl(item.url, name);
    const probe = { url };
    const m = await ensureSize(probe, null);
    if (m && m <= PHOTO_MAX) return { i, kind: 'photo', q: 'large', url, size: m, ...photoType(url) };
  }
  return { i, kind: 'document', q: 'doc', url: item.url, size: n, ...photoType(item.url) };
}

async function videoPlan(item, i, files, mode, onlyKey, changed) {
  const kind = item.type === 'gif' ? 'animation' : 'video';
  let variant;
  if (onlyKey) {
    variant = item.variants.find((v) => v.key === onlyKey);
    if (!variant) return { i, kind, missing: true };
    const n = await ensureSize(variant, changed);
    if (n && n > UPLOAD_MAX) return { i, kind, tooBig: true, item };
  } else {
    // A GIF has a single variant; a cached file for any quality the mode would pick is used as is.
    const choice = await chooseVariant(item, item.type === 'gif' ? 'best' : mode, UPLOAD_MAX, changed);
    if (choice.tooBig) return { i, kind, tooBig: true, item };
    variant = choice.variant;
  }
  const q = item.type === 'gif' ? 'gif' : variant.key;
  const hit = files.get(`${i}:${q}`);
  const base = { i, kind, q, variant, width: variant.w || item.width, height: variant.h || item.height, duration: item.duration };
  if (hit) return { ...base, fileId: hit.fileId, fileKind: hit.kind };
  return { ...base, url: variant.url, size: variant.size || null, ext: 'mp4', type: 'video/mp4' };
}

// ---------- sending ----------

const METHOD = { video: 'sendVideo', animation: 'sendAnimation', photo: 'sendPhoto', document: 'sendDocument' };

/** The file_id (and its real kind) of what Telegram stored for a sent message. */
function fileOf(msg) {
  if (!msg) return null;
  if (msg.video) return { fileId: msg.video.file_id, kind: 'video', size: msg.video.file_size };
  if (msg.animation) return { fileId: msg.animation.file_id, kind: 'animation', size: msg.animation.file_size };
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { fileId: p.file_id, kind: 'photo', size: p.file_size };
  }
  if (msg.document) return { fileId: msg.document.file_id, kind: 'document', size: msg.document.file_size };
  return null;
}

function fileName(post, plan) {
  const who = (post.author || 'x').replace(/[^A-Za-z0-9_]/g, '');
  return `${who}_${post.id}_${plan.i + 1}${plan.q && plan.q !== 'orig' && plan.q !== 'doc' ? `_${plan.q}` : ''}.${plan.ext || 'mp4'}`;
}

/** The file parameter for a plan: cached file_id, freshly downloaded bytes, or (mode 'url') the URL. */
async function fileParam(post, plan, mode) {
  if (mode === 'file_id') return plan.fileId;
  if (mode === 'url') return plan.url;
  const bytes = await download(plan.url, plan.size);
  plan.size = bytes.length;
  return new InputFile(bytes, fileName(post, plan), { type: plan.type });
}

function mediaFields(plan, sensitive) {
  const f = {};
  if (plan.kind === 'video' || plan.kind === 'animation') {
    if (plan.width) f.width = plan.width;
    if (plan.height) f.height = plan.height;
    if (plan.duration) f.duration = plan.duration;
    if (plan.kind === 'video') f.supports_streaming = true;
  }
  if (sensitive && plan.kind !== 'document') f.has_spoiler = true;
  return f;
}

const STALE_FILE = /wrong file identifier|file reference|wrong remote file|file_id/i;
// Errors about the chat itself: no other way of sending the file can succeed.
const CHAT_ERROR = /chat not found|user not found|peer_id_invalid|bot was blocked|user is deactivated|not enough rights|have no rights|bot can't initiate/i;

export function isChatError(err) {
  return isApiError(err) && (err.code === 403 || (err.code === 400 && CHAT_ERROR.test(err.description)));
}

/** Ways to try a plan, in order: cached file_id, upload of downloaded bytes, Telegram fetching the URL. */
function attempts(plan) {
  const out = [];
  if (plan.fileId) out.push('file_id');
  if (plan.url) {
    out.push('upload');
    const urlMax = plan.kind === 'photo' ? URL_PHOTO_MAX : URL_SEND_MAX;
    if (!plan.size || plan.size <= urlMax) out.push('url');
  }
  return out;
}

/** Sends one item on its own; caches its file_id. Returns the sent message or throws the last error. */
async function sendSingle(ctx, post, plan, { chatId, caption, kb, sensitive }) {
  let lastErr = null;
  for (const mode of attempts(plan)) {
    const kind = mode === 'file_id' ? (plan.fileKind || plan.kind) : plan.kind;
    try {
      const file = await fileParam(post, plan, mode);
      await action(ctx, kind === 'photo' ? 'upload_photo' : kind === 'document' ? 'upload_document' : 'upload_video');
      const params = { chat_id: chatId, [kind]: file, ...mediaFields({ ...plan, kind }, sensitive) };
      if (caption) {
        params.caption = caption;
        params.parse_mode = 'HTML';
      }
      if (kb) params.reply_markup = { inline_keyboard: kb };
      const msg = await call(ctx, METHOD[kind], params, `media_${kind}`, { src: mode === 'upload' ? 'download+upload' : mode, q: plan.q, ...(plan.size ? { bytes: plan.size } : {}) });
      const f = fileOf(msg);
      if (f && f.fileId && mode !== 'file_id') await store.putCachedFile(post.id, plan.i, plan.q, { ...f, size: f.size || plan.size });
      plan.sentBy = mode;
      return msg;
    } catch (err) {
      lastErr = err;
      if (mode === 'file_id' && isApiError(err) && err.code === 400 && STALE_FILE.test(err.description)) {
        await store.dropCachedFile(post.id, plan.i, plan.q);
      }
      if (isChatError(err)) throw err; // e.g. the user blocked the bot: nothing else will work
      if (err instanceof MediaError && err.code === 'blocked_host') throw err;
      console.warn(`${METHOD[kind]} via ${mode} failed: ${describeError(err)}`);
    }
  }
  throw lastErr || new Error('nothing to send');
}

/** One album; falls back to sending its items one by one if Telegram refuses the group. */
async function sendAlbum(ctx, post, plans, { chatId, caption, sensitive }) {
  try {
    const media = [];
    for (const [idx, plan] of plans.entries()) {
      const mode = plan.fileId ? 'file_id' : 'upload';
      const type = plan.fileId ? (plan.fileKind === 'video' ? 'video' : plan.fileKind === 'document' ? 'document' : 'photo') : plan.kind;
      const entry = { type, media: await fileParam(post, plan, mode), ...mediaFields({ ...plan, kind: type }, sensitive) };
      if (idx === 0 && caption) {
        entry.caption = caption;
        entry.parse_mode = 'HTML';
      }
      plan.sentBy = mode;
      media.push(entry);
    }
    await action(ctx, plans.some((p) => p.kind === 'video') ? 'upload_video' : 'upload_photo');
    const bytes = plans.reduce((n, p) => n + (p.fileId ? 0 : p.size || 0), 0);
    const msgs = await call(ctx, 'sendMediaGroup', { chat_id: chatId, media }, 'media_album', { q: plans.map((p) => p.q).join(','), ...(bytes ? { bytes } : {}) });
    for (const [idx, plan] of plans.entries()) {
      if (plan.fileId) continue;
      const f = fileOf(Array.isArray(msgs) ? msgs[idx] : null);
      if (f && f.fileId) await store.putCachedFile(post.id, plan.i, plan.q, { ...f, size: f.size || plan.size });
    }
    return true;
  } catch (err) {
    if (isChatError(err)) throw err;
    if (err instanceof MediaError && err.code === 'blocked_host') throw err;
    console.warn(`sendMediaGroup failed, sending items one by one: ${describeError(err)}`);
    let first = true;
    let sent = 0;
    for (const plan of plans) {
      if (plan.fileId && plan.sentBy === 'file_id' && isApiError(err) && STALE_FILE.test(err.description)) {
        await store.dropCachedFile(post.id, plan.i, plan.q);
        delete plan.fileId;
      }
      try {
        await sendSingle(ctx, post, plan, { chatId, caption: first ? caption : null, sensitive });
        first = false;
        sent += 1;
      } catch (e) {
        if (isChatError(e)) throw e;
        plan.failed = describeError(e);
      }
    }
    return sent > 0;
  }
}

/** Direct links when a video is too big for Telegram even at its lowest quality. */
async function sendTooBig(ctx, post, plan, chatId) {
  const smallest = plan.item.variants[plan.item.variants.length - 1];
  const kb = [];
  for (const v of plan.item.variants.slice(0, 6)) {
    kb.push([urlBtn(`🔗 ${qualityLabel(v)}${v.size ? ` · ${sizeShort(v.size)}` : ''}`, v.url)]);
  }
  const low = smallest && smallest.size ? ` (کمترین کیفیت: ${size(smallest.size)})` : '';
  await send(ctx, 'too_big',
    `📦 <b>این ویدیو برای تلگرام خیلی حجیم است.</b>\n\nحتی با کمترین کیفیت${low} از سقف ۵۰ مگابایتی ارسال ربات بیشتر است، `
    + 'پس نمی‌توانم خودش را بفرستم. از لینک‌های مستقیم زیر دانلودش کنید:\n\n'
    + `<a href="${esc(smallest.url)}">⬇️ لینک مستقیم کم‌حجم‌ترین نسخه</a>`,
    kb, chatId);
}

/**
 * Sends a post to `chatId`.
 *   mode: auto / best / low — the user's quality;
 *   only: { item, key } — just that video in that quality (the quality picker);
 *   asDocuments: true — the photos as files (original, uncompressed).
 * Returns { sent, failed, tooBig, fromCache, kinds, firstMessage, error }.
 */
export async function deliverPost(ctx, user, post, { chatId = ctx.chatId, mode = user.quality, only = null, asDocuments = false } = {}) {
  const files = await store.getCachedFiles(post.id);
  const changed = { dirty: false };
  const plans = [];
  for (const [i, item] of post.media.entries()) {
    if (only && only.item !== i) continue;
    if (asDocuments && item.type !== 'photo') continue;
    if (item.type === 'photo') plans.push(await photoPlan(item, i, files, asDocuments, changed));
    else if (item.type === 'video' || item.type === 'gif') plans.push(await videoPlan(item, i, files, mode, only ? only.key : null, changed));
  }
  if (changed.dirty && !post.unsaved) await store.updatePostMedia(post.id, post.media);

  const out = { sent: 0, failed: 0, tooBig: 0, fromCache: true, kinds: new Set(), error: null };
  const notes = [];
  if (post.sensitive) notes.push('🔞 محتوای حساس');
  if (post.fromQuote) notes.push('↪️ رسانه‌ی پست نقل‌قول‌شده');
  if (only && plans[0] && plans[0].variant) notes.push(`🎚 کیفیت: ${qualityLabel(plans[0].variant)}`);
  let caption = buildCaption(user, post, notes);
  const useCaption = () => {
    const c = caption;
    caption = null;
    return c;
  };

  const sendable = plans.filter((p) => !p.tooBig && !p.missing);
  if (plans.some((p) => p.missing)) out.missing = true;
  const gifs = sendable.filter((p) => p.kind === 'animation');
  const group = sendable.filter((p) => p.kind !== 'animation');
  const hasVideoChoice = !only && !asDocuments && post.media.some((m) => m.type === 'video' && m.variants.length > 1);
  const hasPhotos = !only && !asDocuments && post.media.some((m) => m.type === 'photo');
  const actions = [];
  if (hasVideoChoice) actions.push(btn('🎚 کیفیت‌های دیگر', `qp:${post.id}`));
  if (hasPhotos) actions.push(btn('🖼 فایل اصلی عکس‌ها', `pd:${post.id}`));
  const actionKb = actions.length ? [actions] : null;
  let actionsShown = false;

  const note = (p) => {
    out.kinds.add(p.kind === 'animation' ? 'gif' : p.kind);
    if (p.sentBy !== 'file_id') out.fromCache = false;
  };

  try {
    // Units: an album when 2+ photos/videos fit the album budget, else one message per item.
    const units = [];
    const uploadBytes = group.reduce((n, p) => n + (p.fileId ? 0 : p.size || 0), 0);
    if (group.length >= 2 && uploadBytes <= ALBUM_MAX) {
      units.push({ album: group });
    } else if (group.length >= 2) {
      const photos = group.filter((p) => p.kind === 'photo' || p.kind === 'document');
      const rest = group.filter((p) => !photos.includes(p));
      if (photos.length >= 2) units.push({ album: photos });
      else rest.unshift(...photos);
      for (const p of rest) units.push({ single: p });
    } else {
      for (const p of group) units.push({ single: p });
    }
    for (const p of gifs) units.push({ single: p });

    for (const unit of units) {
      if (unit.album) {
        const ok = await sendAlbum(ctx, post, unit.album, { chatId, caption: useCaption(), sensitive: post.sensitive });
        for (const p of unit.album) {
          if (p.failed || !ok) out.failed += 1;
          else {
            out.sent += 1;
            note(p);
          }
        }
      } else {
        const p = unit.single;
        const kb = units.length === 1 && actionKb && !actionsShown ? actionKb : null;
        try {
          await sendSingle(ctx, post, p, { chatId, caption: useCaption(), kb, sensitive: post.sensitive });
          if (kb) actionsShown = true;
          out.sent += 1;
          note(p);
        } catch (err) {
          if (isChatError(err)) throw err;
          out.failed += 1;
          out.error = describeError(err);
        }
      }
    }
    for (const p of plans.filter((x) => x.tooBig)) {
      await sendTooBig(ctx, post, p, chatId);
      out.tooBig += 1;
    }
    if (out.sent && actionKb && !actionsShown) {
      await send(ctx, 'post_actions', '⬆️ گزینه‌های بیشتر برای این پست:', actionKb, chatId);
    }
  } catch (err) {
    out.error = describeError(err);
    out.chatError = isChatError(err);
    if (isApiError(err) && err.code === 403) out.blocked = true;
    out.failed += Math.max(0, sendable.length - out.sent);
  }
  if (!out.sent) out.fromCache = false;
  return out;
}

/** What the history row calls this post. */
export function kindOf(kinds) {
  const k = [...kinds];
  if (k.length > 1) return 'mixed';
  return k[0] === 'animation' ? 'gif' : k[0] || 'media';
}

export const KIND_NAMES = { video: '🎬 ویدیو', photo: '🖼 عکس', gif: '🎞 گیف', document: '📎 فایل', mixed: '🗂 چندرسانه‌ای', media: '📥 رسانه' };

/** A short, readable summary of how many items went out, for progress and summary lines. */
export function resultLine(res) {
  const parts = [];
  if (res.sent) parts.push(`${fa(res.sent)} رسانه ارسال شد${res.fromCache ? ' ⚡️ (از کش)' : ''}`);
  if (res.tooBig) parts.push(`${fa(res.tooBig)} ویدیو خیلی حجیم (لینک مستقیم فرستاده شد)`);
  if (res.failed) parts.push(`${fa(res.failed)} مورد ناموفق`);
  return parts.join('، ');
}
