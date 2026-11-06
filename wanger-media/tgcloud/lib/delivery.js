// Sending media to Telegram (brief §6 "Delivery"): by URL when Telegram can fetch it itself
// (≤ 20 MB, photos ≤ 5 MB); otherwise the bot downloads the bytes (size known in advance, Range
// chunks above one fetch's 30 MB, never above the upload limit) and uploads an InputFile. If
// Telegram can't fetch a URL, the same variant is uploaded instead when its size allows.
// Albums go through sendMediaGroup (photos and videos; GIFs are sent on their own).
// Returns the file_ids Telegram assigned, for the (URL, variant) → file_id cache.
import { InputFile } from 'sdk';
import { TG_UPLOAD_MAX, TG_UPLOAD_PHOTO_MAX } from './config.js';
import { download } from './platforms/common.js';
import * as tg from './tg.js';

/** Telegram couldn't fetch the URL itself (then uploading may still work). */
const URL_REFUSED = /failed to get http url content|wrong file identifier\/http url specified|webpage_curl_failed|webpage_media_empty|wrong type of the web page content|failed to download|http url content/i;
/** A cached file_id Telegram no longer accepts. */
export const FILE_ID_REFUSED = /wrong file identifier|file reference|file_id|wrong remote file|file is too big/i;

export class DeliveryError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'DeliveryError';
    this.code = code; // too_big | url_refused | upload_failed | file_id_refused
  }
}

const EXT = { photo: 'jpg', video: 'mp4', gif: 'mp4', audio: 'mp3' };
const MIME = { photo: 'image/jpeg', video: 'video/mp4', gif: 'video/mp4', audio: 'audio/mpeg' };
/** Albums take photos and videos; GIFs and audio go on their own. */
const inAlbum = (type) => type === 'photo' || type === 'video';
const uploadMax = (type, maxBytes) => Math.min(type === 'photo' ? TG_UPLOAD_PHOTO_MAX : TG_UPLOAD_MAX, maxBytes);

/** The file_id of what a sent message carries. */
export function fileIdOf(message, type) {
  if (!message) return null;
  if (type === 'photo' && Array.isArray(message.photo) && message.photo.length) return message.photo[message.photo.length - 1].file_id;
  if (type === 'gif') return (message.animation && message.animation.file_id) || (message.document && message.document.file_id) || (message.video && message.video.file_id) || null;
  if (type === 'audio') return (message.audio && message.audio.file_id) || (message.document && message.document.file_id) || null;
  return (message.video && message.video.file_id) || (message.document && message.document.file_id) || null;
}

const replyParams = (replyTo) => (replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {});

function single(ctx, chatId, replyTo, item, media, caption) {
  const base = { chat_id: chatId, ...(caption ? { caption, parse_mode: 'HTML' } : {}), ...replyParams(replyTo) };
  const dims = { ...(item.width ? { width: item.width } : {}), ...(item.height ? { height: item.height } : {}), ...(item.duration ? { duration: item.duration } : {}) };
  if (item.type === 'photo') return tg.call(ctx, 'dl_photo', 'sendPhoto', { ...base, photo: media });
  if (item.type === 'gif') return tg.call(ctx, 'dl_gif', 'sendAnimation', { ...base, animation: media, ...dims });
  if (item.type === 'audio') return tg.call(ctx, 'dl_audio', 'sendAudio', { ...base, audio: media, ...(item.duration ? { duration: item.duration } : {}) });
  return tg.call(ctx, 'dl_video', 'sendVideo', { ...base, video: media, ...dims, supports_streaming: true });
}

function group(ctx, chatId, replyTo, entries, caption) {
  const media = entries.map(({ item, media: m }, i) => ({
    type: item.type === 'photo' ? 'photo' : 'video',
    media: m,
    ...(i === 0 && caption ? { caption, parse_mode: 'HTML' } : {}),
    ...(item.type === 'video' ? { supports_streaming: true } : {}),
    ...(item.type !== 'photo' && item.width ? { width: item.width, height: item.height } : {}),
    ...(item.type !== 'photo' && item.duration ? { duration: item.duration } : {}),
  }));
  return tg.call(ctx, 'dl_album', 'sendMediaGroup', { chat_id: chatId, media, ...replyParams(replyTo) });
}

/** The bytes of a chosen variant as an InputFile (size checked before anything is downloaded). */
async function asUpload(ctx, choice, allow, maxBytes, name) {
  const { item, variant } = choice;
  const max = uploadMax(item.type, maxBytes);
  if (!variant.bytes || variant.bytes > max) throw new DeliveryError('too_big', `${variant.bytes} > ${max}`);
  const bytes = await download(ctx, variant.url, allow, { bytes: variant.bytes, ranges: variant.ranges, max });
  return new InputFile(bytes, `${name}.${EXT[item.type]}`, { type: variant.mime || MIME[item.type] });
}

const refusedUrl = (err) => !!err && err.code === 400 && URL_REFUSED.test(String(err.description || err.message || ''));

/**
 * Sends the chosen variants. choices = [{ item, variant, via }] in post order.
 * → { items: [{ type, file_id }], bytes, messages }
 */
export async function deliver(ctx, { chatId, replyTo, choices, caption, allow, maxBytes, name }) {
  const groupable = choices.filter((c) => inAlbum(c.item.type));
  const gifs = choices.filter((c) => !inAlbum(c.item.type));
  const sent = [];
  let captionUsed = false;

  if (groupable.length >= 2) {
    for (let start = 0; start < groupable.length; start += 10) {
      const part = groupable.slice(start, start + 10);
      const cap = captionUsed ? null : caption;
      let messages;
      try {
        const entries = await Promise.all(part.map(async (c, i) => ({
          item: c.item, media: c.via === 'url' ? c.variant.url : await asUpload(ctx, c, allow, maxBytes, `${name}_${start + i + 1}`),
        })));
        messages = await group(ctx, chatId, replyTo, entries, cap);
      } catch (err) {
        if (!refusedUrl(err)) throw err;
        // Telegram couldn't fetch a URL: upload the whole part instead (sizes are known).
        const entries = await Promise.all(part.map(async (c, i) => ({ item: c.item, media: await asUpload(ctx, c, allow, maxBytes, `${name}_${start + i + 1}`) })));
        messages = await group(ctx, chatId, replyTo, entries, cap);
      }
      captionUsed = true;
      part.forEach((c, i) => sent.push({ type: c.item.type, file_id: fileIdOf(messages && messages[i], c.item.type), bytes: c.variant.bytes || 0 }));
    }
  }

  const singles = groupable.length === 1 ? [...groupable, ...gifs] : gifs;
  for (const c of singles) {
    const cap = captionUsed ? null : caption;
    let msg;
    if (c.via === 'url') {
      try {
        msg = await single(ctx, chatId, replyTo, c.item, c.variant.url, cap);
      } catch (err) {
        if (!refusedUrl(err)) throw err;
        if (!c.variant.bytes) throw new DeliveryError('url_refused', 'Telegram could not fetch the URL and the size is unknown');
        msg = await single(ctx, chatId, replyTo, c.item, await asUpload(ctx, c, allow, maxBytes, name), cap);
      }
    } else {
      msg = await single(ctx, chatId, replyTo, c.item, await asUpload(ctx, c, allow, maxBytes, name), cap);
    }
    captionUsed = true;
    sent.push({ type: c.item.type, file_id: fileIdOf(msg, c.item.type), bytes: c.variant.bytes || 0 });
  }

  return {
    items: sent.map(({ type, file_id }) => ({ type, file_id })),
    bytes: sent.reduce((a, s) => a + s.bytes, 0),
  };
}

/**
 * An information card (METADATA_ONLY platforms): the cover photo by URL with the caption, or — no
 * cover, or Telegram can't fetch it — the caption as a text message. Nothing is downloaded.
 * → { items: [{ type: 'photo', file_id }] | [], bytes: 0 }
 */
export async function sendCard(ctx, { chatId, replyTo, cover, caption }) {
  if (cover) {
    try {
      const msg = await single(ctx, chatId, replyTo, { type: 'photo' }, cover, caption);
      return { items: [{ type: 'photo', file_id: fileIdOf(msg, 'photo') }], bytes: 0 };
    } catch (err) {
      if (!(err && err.code === 400)) throw err; // the cover was refused: the text alone still helps
    }
  }
  await tg.call(ctx, 'dl_card', 'sendMessage', {
    chat_id: chatId, text: caption, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...replyParams(replyTo),
  });
  return { items: [], bytes: 0 };
}

/** Re-sends cached file_ids (no fetching). Throws DeliveryError('file_id_refused') if Telegram refuses them. */
export async function sendCached(ctx, { chatId, replyTo, items, caption }) {
  const entries = items.map((it) => ({ item: { type: it.type }, media: it.file_id }));
  try {
    const groupable = entries.filter((e) => inAlbum(e.item.type));
    const gifs = entries.filter((e) => !inAlbum(e.item.type));
    let captionUsed = false;
    if (groupable.length >= 2) {
      for (let start = 0; start < groupable.length; start += 10) {
        await group(ctx, chatId, replyTo, groupable.slice(start, start + 10), captionUsed ? null : caption);
        captionUsed = true;
      }
    }
    for (const e of groupable.length === 1 ? [...groupable, ...gifs] : gifs) {
      await single(ctx, chatId, replyTo, e.item, e.media, captionUsed ? null : caption);
      captionUsed = true;
    }
  } catch (err) {
    if (err && err.code === 400 && FILE_ID_REFUSED.test(String(err.description || err.message || ''))) throw new DeliveryError('file_id_refused', err.description);
    throw err;
  }
}
